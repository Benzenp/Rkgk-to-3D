import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { registerSW } from 'virtual:pwa-register';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { createRecognition } from './recognition.js';
import { Mannequin, KEY_JOINTS } from './mannequin.js';
import { toBVH } from './bvh.js';
import { Viewer } from './viewer.js';
import { DrawingBoard } from './board.js';
import { createBody, applyBody } from './body.js';

const $ = (s) => document.querySelector(s);
// 색 하나가 인물 한 명이다
const COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#12a594'];
const PAPER = [1080, 1350];
const DEPTH_STEP = 0.6; // 레이어 한 칸당 앞뒤 간격(m)
const DEBOUNCE_MS = 120;

// 앞뒤 반전 때 왼쪽/오른쪽 관절 번호를 맞바꾼다
const MIRROR = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
// 팔다리 앞뒤 뒤집기: [기준 관절, 뒤집을 관절들]
const LIMBS = {
  la: [11, [13, 15, 17, 19, 21]],
  ra: [12, [14, 16, 18, 20, 22]],
  ll: [23, [25, 27, 29, 31]],
  rl: [24, [26, 28, 30, 32]],
};
const BONES_2D = [[0, 11], [0, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32]];

const persons = COLORS.map((color, id) => ({
  id, color, name: `인물 ${id + 1}`,
  mannequin: null, box: null, det: null, px: null, anchor: null, low: [],
  flips: {}, offset: new THREE.Vector3(), scale: 1, yaw: 0, auto: new THREE.Vector3(), dirty: false,
  sex: 'female', style: 'anime', bodyKind: null,
  candidates: [], pick: null, // 인식 후보들과, 사용자가 고른 해석(전처리 이름). null이면 점수가 가장 높은 것
  // 사용자가 그림이나 3D에서 옮긴 관절: 관절 번호 → 인식 결과에 더할 이동량(m, three.js 축, 앞뒤 반전 전 기준)
  edits: {}, mpp: 0.002, job: null,
}));
// 처음 그린 순서 (뒤 → 앞). 나중에 그린 인물일수록 앞
const state = { order: [], selected: null, autoFrame: true, auto: loadSetting('auto', true) };

function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem('rkgk.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function saveSetting(key, value) {
  try {
    localStorage.setItem('rkgk.' + key, JSON.stringify(value));
  } catch {}
}

const recognition = createRecognition({
  onReady: (device) => {
    $('#device').textContent = device === 'GPU' ? 'GPU' : 'CPU (인식이 약할 수 있어요)';
    if (!running) setStatus(summary());
  },
  onError: () => setStatus('인식 모델을 불러오지 못했어요'),
});
const figures = () => state.order.map((id) => persons[id]).filter((p) => p.box);
// 3D에 올리는 인물: 사람으로 인식된 것만
const placed = () => figures().filter((p) => p.det);

const viewer = new Viewer($('#viewport'), {
  onSelect: (f) => select(f),
  // 인형을 끌어 바닥 위로 옮긴다 (사람 사이 거리)
  onFigureDrag: (f, phase) => {
    state.autoFrame = false; // 직접 배치하기 시작하면 카메라는 그대로 둔다
    f.offset.copy(f.mannequin.root.position).sub(f.auto);
    if (phase === 'end') refresh();
  },
  // 발밑 고리를 끌어 인형을 돌린다
  onFigureRotate: (f, deg, phase) => {
    f.yaw = Math.round(((deg % 360) + 540) % 360 - 180);
    if (f === state.selected) setYawLabel(f);
    if (phase === 'end') refresh();
  },
  // 3D에서 관절을 끌어 옮긴다
  onJointDrag: (f, index, point, phase) => {
    state.autoFrame = false;
    moveJointTo3D(f, index, point);
    if (phase === 'end') refresh();
    else livePose(f);
  },
});
viewer.orbit.addEventListener('change', () => updateCameraInfo());
// 카메라를 직접 움직이기 전까지는 그릴 때마다 모든 인물이 보이도록 맞춘다
viewer.orbit.addEventListener('start', () => (state.autoFrame = false));

const board = new DrawingBoard($('#stage'), {
  width: PAPER[0],
  height: PAPER[1],
  colors: COLORS,
  onChange: (ids) => {
    $('#undo').disabled = !board.undoStack.length;
    $('#redo').disabled = !board.redoStack.length;
    markDirty(ids);
  },
  // 관절 도구로 그림 위의 관절 점을 끌어 옮긴다
  onJointDrag: (id, index, x, y, phase) => {
    const f = persons[id];
    if (!f.det) return;
    moveJointTo2D(f, index, x, y);
    if (phase === 'end') refresh();
    else livePose(f);
  },
});

function setStatus(text, busy = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('busy', busy);
}

// --- 인식 ---

function swapLR(arr) {
  const out = arr.slice();
  for (const [a, b] of MIRROR) [out[a], out[b]] = [arr[b], arr[a]];
  return out;
}

// 인식 결과에 사용자 보정(몸 방향 반전, 팔다리 앞뒤 뒤집기)을 적용한 인물 공간 좌표
function figureLandmarks(fig) {
  // MediaPipe 월드 좌표는 y가 아래, z가 카메라 쪽으로 작아진다 → three.js 축으로 바꾼다
  let lm = fig.det.world.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));
  for (const [i, d] of Object.entries(fig.edits)) lm[i].add(d);
  let vis = fig.det.image.map((p) => p.visibility ?? 1);
  if (fig.flips.body) {
    // 같은 그림을 뒤돌아선 사람으로 해석: 깊이를 뒤집고 왼쪽/오른쪽을 맞바꾼다
    lm.forEach((v) => (v.z = -v.z));
    lm = swapLR(lm);
    vis = swapLR(vis);
  }
  for (const [key, [root, chain]] of Object.entries(LIMBS)) {
    if (!fig.flips[key]) continue;
    for (const i of chain) lm[i].z = 2 * lm[root].z - lm[i].z;
  }
  return { lm, vis };
}

function poseFigure(fig) {
  const m = fig.mannequin;
  const { lm, vis } = figureLandmarks(fig);
  m.applyLandmarks(lm);
  if (m.body) applyBody(m.body, m);
  viewer.updateShadows();
  const thr = +$('#threshold').value;
  const low = KEY_JOINTS.filter(([i]) => vis[i] < thr);
  fig.low = low.map(([, , label]) => label);
  m.setLowConfidence(low.map(([, bone]) => bone));
}

// 후보 하나를 이 인물의 인식 결과로 쓴다
function useCandidate(p, i) {
  const c = p.candidates[i] ?? p.candidates[0];
  p.det = c?.det ?? null;
  p.px = c?.px ?? null;
  p.anchor = p.det
    ? [(p.px[23][0] + p.px[24][0]) / 2, (p.px[23][1] + p.px[24][1]) / 2]
    : [p.box.x + p.box.w / 2, p.box.y + p.box.h / 2];
  // 그림 1px이 인물 공간에서 몇 m인지: 그림에서 옮긴 관절을 3D 이동량으로 바꿀 때 쓴다
  if (p.det) {
    const joints = KEY_JOINTS.map(([j]) => j);
    const w = diag2d(joints.map((j) => [p.det.world[j].x, p.det.world[j].y]));
    const d = diag2d(joints.map((j) => p.px[j]));
    if (d > 1) p.mpp = w / d;
  }
}

// 레이어 한 장을 백그라운드에서 인식한다. 첫 후보가 나오는 대로 바로 보여 주고, 나머지는 이어서 받는다.
// 그 사이 새 획이 들어오면 markDirty가 남은 계산을 취소하고, 처음부터 다시 한다.
async function analyze(p) {
  const bitmap = await createImageBitmap(board.layers[p.id]);
  if (p.dirty) return bitmap.close();
  const found = [];
  p.job = recognition.run(bitmap, $('#model').value, (ev) => {
    if (ev.type === 'box') {
      p.box = ev.box;
      if (!p.box) return;
      if (!state.order.includes(p.id)) state.order.push(p.id);
      p.mannequin ??= new Mannequin(p.color);
      ensureBody(p);
      return;
    }
    if (p.dirty) return;
    found.push({ label: ev.label, score: ev.score, px: ev.px, det: { image: ev.image, world: ev.world } });
    found.sort((a, b) => b.score - a.score);
    p.candidates = found;
    const before = p.det;
    // 다시 그려도 사용자가 고른 해석을 유지한다
    useCandidate(p, found.findIndex((c) => c.label === p.pick));
    if (p.det !== before) refresh();
  });
  try {
    await p.job.promise;
  } finally {
    p.job = null;
  }
  if (p.dirty) return;
  p.candidates = found;
  if (!p.box) p.det = null;
  else useCandidate(p, found.findIndex((c) => c.label === p.pick));
}

// 고른 체형의 인체 모델을 불러와 붙인다. 불러오는 동안은 단순 인형이 보인다.
function ensureBody(p) {
  const kind = `${p.style}-${p.sex}`;
  if (p.bodyKind === kind) return;
  p.bodyKind = kind;
  createBody(kind, p.color)
    .then((body) => {
      if (p.bodyKind !== kind) return;
      p.mannequin.setBody(body);
      refresh();
    })
    .catch((err) => {
      console.error(err);
      setStatus('인체 모델을 불러오지 못했어요');
    });
}

// 획이 끝날 때마다 바뀐 인물만 다시 인식한다. 인식 중에 또 그리면 끝난 뒤 이어서 처리한다.
let timer = null, running = false;
function markDirty(ids) {
  for (const id of ids) {
    persons[id].dirty = true;
    persons[id].job?.cancel();
  }
  clearTimeout(timer);
  if (state.auto) timer = setTimeout(processDirty, DEBOUNCE_MS);
  else setStatus([summary(), '다 그리면 인식을 눌러요'].filter(Boolean).join(' · '));
  updateRecognize();
}

async function processDirty() {
  if (running) return;
  running = true;
  setStatus('인식 중', true);
  try {
    let p;
    while ((p = persons.find((x) => x.dirty))) {
      p.dirty = false;
      await analyze(p);
      refresh();
    }
    setStatus(summary());
    updateRecognize();
  } catch (err) {
    console.error(err);
    setStatus('인식하지 못했어요 · ' + (err.message || err));
  } finally {
    running = false;
  }
}

function summary() {
  const figs = placed();
  const waiting = figures().length - figs.length;
  const low = figs.filter((f) => f.low.length).length;
  const weak = recognition.device === 'CPU' && '이 기기에서는 인식이 약할 수 있어요';
  return [figs.length && `인물 ${figs.length}명`, low && `불확실 ${low}`, waiting && `인식 대기 ${waiting}`, weak].filter(Boolean).join(' · ');
}

// --- 배치 ---

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function diag2d(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

// 그림 속 위치를 그대로 옮겨 배치한다. 모든 인물이 같은 축척을 쓰고, 사용자가 옮긴 만큼은 유지한다.
function layout() {
  const figs = placed();
  const ratios = [];
  const v = new THREE.Vector3();
  for (const f of figs) {
    f.mannequin.root.position.set(0, 0, 0);
    f.mannequin.root.scale.setScalar(1);
    f.mannequin.root.rotation.set(0, 0, 0);
    poseFigure(f);
    f.mannequin.root.updateWorldMatrix(true, true);
    const joints = KEY_JOINTS.slice(1);
    const p3 = joints.map(([, bone]) => f.mannequin.bones[bone].getWorldPosition(v).toArray());
    const d2 = diag2d(joints.map(([i]) => f.px[i]));
    if (d2 > 1) ratios.push(diag2d(p3) / d2);
  }
  // 그리다 만 그림의 엉뚱한 인식 결과가 배치를 흔들지 않도록, 인물 키가 종이 높이의 1/8~1 사이인 범위로 묶는다
  const s = THREE.MathUtils.clamp(ratios.length ? median(ratios) : 1.7 / PAPER[1], 1.7 / PAPER[1], 8 * 1.7 / PAPER[1]); // m/px
  for (const f of figs) f.mannequin.root.position.set((f.anchor[0] - PAPER[0] / 2) * s, -f.anchor[1] * s - 1.0, 0);
  // 가장 낮은 발이 바닥(y=0)에 닿도록 전체를 올린다
  let minY = Infinity;
  for (const f of figs) minY = Math.min(minY, f.mannequin.bounds().min.y);
  figs.forEach((f, i) => {
    const root = f.mannequin.root;
    root.position.y -= minY;
    root.position.z = (i - (figs.length - 1) / 2) * DEPTH_STEP;
    f.auto.copy(root.position);
    root.position.add(f.offset);
    root.scale.setScalar(f.scale);
    root.rotation.y = THREE.MathUtils.degToRad(f.yaw);
  });
}

function refresh() {
  const figs = placed();
  if (figs.length !== viewer.figures.length || figs.some((f, i) => viewer.figures[i] !== f)) viewer.setFigures(figs);
  board.setOrder(state.order);
  if (figs.length) {
    layout();
    viewer.setStage();
  }
  if (state.autoFrame && figs.length) viewer.frameAll();
  if (state.selected && !figures().includes(state.selected)) state.selected = null;
  viewer.select(state.selected?.det ? state.selected : null);
  renderChips();
  renderCard();
  updateGuides();
  updateCameraInfo();
  $('#empty').hidden = figures().length > 0;
  $('#export-png').disabled = $('#export-zip').disabled = !figs.length;
}

function updateGuides() {
  const thr = +$('#threshold').value;
  board.setGuides(
    figures()
      .filter((f) => f.det)
      .map((f) => ({
        id: f.id,
        color: f.color,
        lines: BONES_2D.map(([a, b]) => [shownPx(f, a), shownPx(f, b)]),
        points: KEY_JOINTS.map(([i]) => ({ index: i, x: shownPx(f, i)[0], y: shownPx(f, i)[1], low: (f.det.image[i].visibility ?? 1) < thr })),
      }))
  );
}

// --- 관절 옮기기 ---
// 옮긴 양은 인식 결과(앞뒤 반전 전)에 더하는 이동량으로 둔다. 그래서 다시 그리거나 해석을 바꿔도 유지되고,
// 그림 위의 점과 3D 인형이 같은 값을 본다.

const mirrorOf = (i) => {
  for (const [a, b] of MIRROR) if (i === a) return b; else if (i === b) return a;
  return i;
};

// 그림 위에 보여 줄 관절 위치: 인식된 위치 + 옮긴 양 (그림 기준)
function shownPx(f, i) {
  const d = f.edits[i];
  return d ? [f.px[i][0] + d.x / f.mpp, f.px[i][1] - d.y / f.mpp] : f.px[i];
}

// 관절과 함께 따라 움직이는 끝 점들 (손가락, 발끝, 귀)
const FOLLOW_2D = { 0: [7, 8], 15: [17, 19, 21], 16: [18, 20, 22], 27: [29, 31], 28: [30, 32] };
// 3D에서 관절을 옮기면 그 아래 마디가 통째로 따라온다
const FOLLOW_3D = {
  0: [7, 8], 11: [13, 15, 17, 19, 21], 12: [14, 16, 18, 20, 22], 13: [15, 17, 19, 21], 14: [16, 18, 20, 22],
  15: [17, 19, 21], 16: [18, 20, 22], 23: [25, 27, 29, 31], 24: [26, 28, 30, 32], 25: [27, 29, 31], 26: [28, 30, 32],
  27: [29, 31], 28: [30, 32],
};
// 팔꿈치·손목·무릎·발목은 윗마디 관절을 축으로 돈다: [윗마디 관절 번호, 그 관절의 뼈]
const PIVOT = {
  13: [11, 'LeftArm'], 15: [13, 'LeftForeArm'], 14: [12, 'RightArm'], 16: [14, 'RightForeArm'],
  25: [23, 'LeftUpLeg'], 27: [25, 'LeftLeg'], 26: [24, 'RightUpLeg'], 28: [26, 'RightLeg'],
};

function addEdit(f, i, dx, dy, dz) {
  const d = (f.edits[i] ??= new THREE.Vector3());
  d.x += dx;
  d.y += dy;
  d.z += dz;
}

// 그림 위에서 관절 점 index(인식 결과 번호)를 (x, y)로 옮긴다. 깊이는 그대로 둔다.
function moveJointTo2D(f, index, x, y) {
  const [sx, sy] = shownPx(f, index);
  const dx = (x - sx) * f.mpp, dy = -(y - sy) * f.mpp;
  for (const i of [index, ...(FOLLOW_2D[index] ?? [])]) addEdit(f, i, dx, dy, 0);
}

// 3D에서 관절 index(인형 쪽 번호)를 장면의 point로 옮긴다
function moveJointTo3D(f, index, point) {
  const m = f.mannequin;
  const { lm } = figureLandmarks(f);
  const local = (v) => m.root.worldToLocal(v.clone());
  const cursor = local(point);
  let target;
  if (PIVOT[index]) {
    // 윗마디 관절을 축으로, 뼈가 커서를 향하게 돌린다 (뼈 길이는 그대로)
    const [parent, bone] = PIVOT[index];
    const pivot = local(m.bones[bone].getWorldPosition(new THREE.Vector3()));
    const len = lm[index].distanceTo(lm[parent]);
    target = lm[parent].clone().add(cursor.sub(pivot).normalize().multiplyScalar(len));
  } else {
    const handle = local(m.handles[index].getWorldPosition(new THREE.Vector3()));
    target = lm[index].clone().add(cursor.sub(handle));
  }
  const delta = target.sub(lm[index]);
  // 인형 쪽(앞뒤 반전 후) 이동량을 인식 결과(반전 전) 기준으로 되돌려 저장한다
  for (const i of [index, ...(FOLLOW_3D[index] ?? [])]) {
    let dz = delta.z;
    for (const [key, [, chain]] of Object.entries(LIMBS)) if (f.flips[key] && chain.includes(i)) dz = -dz;
    if (f.flips.body) dz = -dz;
    addEdit(f, f.flips.body ? mirrorOf(i) : i, delta.x, delta.y, dz);
  }
}

// 끄는 동안에는 그 인물만 다시 자세를 잡는다 (전체 배치를 다시 하면 바닥에 맞추느라 인형이 들썩인다)
let liveFrame = 0;
function livePose(f) {
  cancelAnimationFrame(liveFrame);
  liveFrame = requestAnimationFrame(() => {
    poseFigure(f);
    updateGuides();
  });
}

// --- 오른쪽 UI ---

function rankLabel(fig) {
  const figs = placed(), n = figs.length;
  if (n < 2 || !fig.det) return '';
  const rank = n - figs.indexOf(fig);
  return rank === 1 ? '맨 앞' : rank === n ? '맨 뒤' : `앞 ${rank}`;
}

function stateOf(fig) {
  if (!fig.det) return { text: '아직 사람으로 인식되지 않았어요', cls: 'bad' };
  if (fig.low.length) return { text: `불확실: ${fig.low.join(', ')}`, cls: 'warn' };
  return { text: '잘 인식됐어요', cls: '' };
}

function renderChips() {
  const host = $('#chips');
  host.innerHTML = '';
  for (const fig of [...figures()].reverse()) {
    const b = document.createElement('button');
    b.className = 'chip' + (fig === state.selected ? ' on' : '');
    const st = stateOf(fig);
    b.innerHTML = `<span class="dot"></span><span class="name"></span><span class="rank"></span>${st.cls ? `<span class="mark ${st.cls}"></span>` : ''}`;
    b.querySelector('.dot').style.setProperty('--c', fig.color);
    b.querySelector('.name').textContent = fig.name;
    b.querySelector('.rank').textContent = rankLabel(fig);
    b.title = st.text;
    b.addEventListener('click', () => select(fig === state.selected ? null : fig));
    host.appendChild(b);
    // 3D 이름표는 번호만: 이름과 순서는 칩에 있다
    if (fig.label) viewer.updateLabel(fig, String(fig.id + 1), fig.color);
  }
}

function renderCard() {
  const fig = state.selected;
  $('#card').hidden = !fig;
  $('.app').classList.toggle('card-open', !!fig);
  if (!fig) return;
  const figs = placed(), i = figs.indexOf(fig);
  $('#card-dot').style.setProperty('--c', fig.color);
  $('#card-title').textContent = [fig.name, rankLabel(fig)].filter(Boolean).join(' · ');
  const st = stateOf(fig);
  $('#card-state').textContent = st.text;
  $('#card-state').className = 'muted ' + st.cls;
  const n = fig.candidates.length, ci = fig.candidates.findIndex((c) => c.det === fig.det);
  $('#cand-label').textContent = n ? `${fig.candidates[ci].label} · ${ci + 1}/${n}` : '없음';
  $('#prev-cand').disabled = $('#next-cand').disabled = n < 2;
  for (const btn of document.querySelectorAll('[data-flip]')) {
    btn.classList.toggle('on', !!fig.flips[btn.dataset.flip]);
    btn.disabled = !fig.det;
  }
  for (const btn of document.querySelectorAll('[data-sex]')) btn.classList.toggle('on', btn.dataset.sex === fig.sex);
  for (const btn of document.querySelectorAll('[data-style]')) btn.classList.toggle('on', btn.dataset.style === fig.style);
  $('#to-front').disabled = i < 0 || i === figs.length - 1;
  $('#to-back').disabled = i <= 0;
  $('#scale').value = fig.scale;
  $('#scale-val').textContent = fig.scale.toFixed(2);
  setYawLabel(fig);
}

function setYawLabel(fig) {
  $('#yaw').value = fig.yaw;
  $('#yaw-val').textContent = `${fig.yaw}°`;
}

function select(fig) {
  const wasOpen = !!state.selected;
  state.selected = fig ?? null;
  viewer.select(state.selected?.det ? state.selected : null);
  renderChips();
  renderCard();
  // 패널이 열리거나 닫히면 3D 영역 크기가 바뀌므로, 자동 맞춤 중이면 새 크기에 맞춰 다시 맞춘다
  if (wasOpen !== !!state.selected && state.autoFrame) requestAnimationFrame(() => requestAnimationFrame(() => viewer.frameAll()));
}

function move(fig, dir) {
  const figs = placed(), i = figs.indexOf(fig), j = i + dir;
  if (j < 0 || j >= figs.length) return;
  const a = state.order.indexOf(fig.id), b = state.order.indexOf(figs[j].id);
  [state.order[a], state.order[b]] = [state.order[b], state.order[a]];
  refresh();
}

function updateCameraInfo() {
  const info = viewer.cameraInfo();
  $('#camera-info').textContent =
    `위치 ${info.position_cm.join(', ')} cm\n` +
    `주시점 ${info.target_cm.join(', ')} cm\n` +
    `거리 ${info.distance_cm} cm\n` +
    `yaw ${info.rotation_deg.yaw}° · pitch ${info.rotation_deg.pitch}° · roll ${info.rotation_deg.roll}°\n` +
    `세로 ${info.vertical_fov_deg}° · 가로 ${info.horizontal_fov_deg}° · 35mm 환산 ${info.focal_length_35mm}mm`;
}

// --- 내보내기 ---

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const canvasBytes = (c) => new Promise((r) => c.toBlob(r, 'image/png')).then((b) => b.arrayBuffer()).then((b) => new Uint8Array(b));

async function exportZip() {
  board.commitSelection();
  const figs = placed();
  const files = {
    'view.png': new Uint8Array(await (await viewer.capture()).arrayBuffer()),
    'sketch.png': await canvasBytes(board.composite(state.order)),
  };
  const list = figs.map((f, i) => {
    const file = `${String(i + 1).padStart(2, '0')}_person${f.id + 1}.bvh`;
    files[file] = strToU8(toBVH(f.mannequin));
    const hips = f.mannequin.bones.Hips.getWorldPosition(new THREE.Vector3());
    return {
      file, name: f.name, color: f.color, order: rankLabel(f) || '맨 앞',
      hips_position_cm: hips.toArray().map((n) => +(n * 100).toFixed(1)),
      scale: f.scale,
      rotation_y_deg: f.yaw,
      body: f.bodyKind,
      flips: f.flips,
      low_confidence: f.low,
    };
  });
  const meta = { units: 'cm', up: '+Y', front: '+Z (카메라 쪽)', camera: viewer.cameraInfo(), lights: viewer.lightInfo(), figures: list };
  files['camera.json'] = strToU8(JSON.stringify(meta, null, 2));
  files['README.txt'] = strToU8(README_TXT);
  download(new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }), 'rkgk-pose.zip');
}

const README_TXT = `rkgk-to-3d 내보내기 묶음

view.png    웹에서 저장한 현재 시점 이미지
sketch.png  그린 스케치
NN_*.bvh    인물별 포즈 (1프레임, Mixamo식 뼈 이름, cm 단위). 번호가 클수록 앞
camera.json 카메라 수치, 주·보조 광원 방향, 인물별 위치·크기·회전·보정 내용

클립 스튜디오에서 쓰기 (Ver. 3.1 이상, BVH 지원 버전)
1. 3D 레이어에 데생 인형을 인물 수만큼 올린다.
2. 각 데생 인형에 BVH 파일을 하나씩 적용한다.
3. 배치를 유지하려면 "위치 고정"을 끈다. 모든 BVH의 위치는 같은 좌표계(cm) 기준이다.
4. view.png를 반투명하게 깔고 카메라를 맞춘다. camera.json의 수치를 참고한다.
5. 광원은 camera.json의 lights를 참고한다 (방위: 정면에서 오른쪽으로 잰 각도, 높이: 바닥에서 위로 잰 각도).
6. 손끝 같은 세부는 클립 스튜디오에서 조정한다.

웹에서 돌린 방향은 BVH에 담기지만, 바꾼 크기는 BVH에 담기지 않는다. 데생 인형 크기는 camera.json의 scale을 보고 맞춘다.
`;

// --- 왼쪽 UI 연결 ---

const swatches = $('#swatches');
COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' on' : '');
  b.style.setProperty('--c', c);
  b.title = `인물 ${i + 1} (${i + 1})`;
  b.setAttribute('aria-label', `인물 ${i + 1}`);
  b.addEventListener('click', () => setActive(i));
  swatches.appendChild(b);
});

function setActive(i) {
  board.setActive(i);
  swatches.querySelectorAll('.swatch').forEach((b, j) => b.classList.toggle('on', i === j));
}

function setTool(tool) {
  board.setTool(tool);
  // 관절 도구는 관절 점을 옮기는 도구라, 점이 꺼져 있으면 켠다
  if (tool === 'joint' && !$('#guides').classList.contains('on')) $('#guides').click();
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  const size = board.sizes[tool];
  $('#size').disabled = !size;
  if (size) {
    $('#size').value = size;
    $('#size-val').textContent = size;
  }
}

function setSize(v) {
  v = Math.max(1, Math.min(60, v));
  board.setSize(v);
  $('#size').value = v;
  $('#size-val').textContent = v;
}

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#size').addEventListener('input', () => setSize(+$('#size').value));
$('#undo').addEventListener('click', () => board.undo());
$('#redo').addEventListener('click', () => board.redo());
$('#clear').addEventListener('click', () => board.clearAll());
$('#guides').addEventListener('click', () => {
  const on = !$('#guides').classList.contains('on');
  $('#guides').classList.toggle('on', on);
  board.toggleGuides(on);
});
$('#undo').disabled = $('#redo').disabled = true;

window.addEventListener('keydown', (e) => {
  if (e.target.closest('select')) return;
  const mod = e.ctrlKey || e.metaKey;
  // 한글 입력 상태에서도 동작하도록 e.code를 쓴다
  if (mod && e.code === 'KeyZ') {
    e.preventDefault();
    e.shiftKey ? board.redo() : board.undo();
  } else if (mod && e.code === 'KeyY') {
    e.preventDefault();
    board.redo();
  } else if (mod || e.altKey) {
    return;
  } else if (e.code === 'KeyB' || e.code === 'KeyP') setTool('pen');
  else if (e.code === 'KeyE') setTool('eraser');
  else if (e.code === 'KeyL') setTool('lasso');
  else if (e.code === 'KeyV') setTool('joint');
  else if (e.code === 'KeyR') setAuto(!state.auto);
  else if (e.code === 'Enter' && !state.auto) recognizeNow();
  else if (/^Digit[1-6]$/.test(e.code)) setActive(+e.code.slice(5) - 1);
  else if (e.code === 'BracketLeft') setSize(board.sizes[board.tool] - 2);
  else if (e.code === 'BracketRight') setSize(board.sizes[board.tool] + 2);
  else if ((e.code === 'Delete' || e.code === 'Backspace') && board.hasSelection) {
    e.preventDefault();
    board.commitSelection(true);
  } else if (e.code === 'Escape') {
    if (board.hasSelection) board.commitSelection();
    else select(null);
  }
});

// --- 오른쪽 UI 연결 ---

for (const btn of document.querySelectorAll('[data-flip]')) {
  btn.addEventListener('click', () => {
    const f = state.selected;
    if (!f) return;
    f.flips[btn.dataset.flip] = !f.flips[btn.dataset.flip];
    refresh();
  });
}
for (const btn of document.querySelectorAll('[data-sex], [data-style]')) {
  btn.addEventListener('click', () => {
    const f = state.selected;
    if (!f) return;
    if (btn.dataset.sex) f.sex = btn.dataset.sex;
    if (btn.dataset.style) f.style = btn.dataset.style;
    ensureBody(f);
    renderCard();
  });
}
function stepCandidate(dir) {
  const f = state.selected;
  if (!f || f.candidates.length < 2) return;
  const n = f.candidates.length;
  const i = (f.candidates.findIndex((c) => c.det === f.det) + dir + n) % n;
  f.pick = f.candidates[i].label;
  useCandidate(f, i);
  refresh();
}
$('#prev-cand').addEventListener('click', () => stepCandidate(-1));
$('#next-cand').addEventListener('click', () => stepCandidate(1));
$('#to-front').addEventListener('click', () => state.selected && move(state.selected, 1));
$('#to-back').addEventListener('click', () => state.selected && move(state.selected, -1));
$('#scale').addEventListener('input', () => {
  const f = state.selected;
  if (!f) return;
  f.scale = +$('#scale').value;
  f.mannequin.root.scale.setScalar(f.scale);
  viewer.updateShadows();
  $('#scale-val').textContent = f.scale.toFixed(2);
});
$('#yaw').addEventListener('input', () => {
  const f = state.selected;
  if (!f) return;
  f.yaw = +$('#yaw').value;
  f.mannequin.root.rotation.y = THREE.MathUtils.degToRad(f.yaw);
  viewer.updateShadows();
  setYawLabel(f);
});
$('#reset-pos').addEventListener('click', () => {
  const f = state.selected;
  if (!f) return;
  f.offset.set(0, 0, 0);
  f.scale = 1;
  f.yaw = 0;
  refresh();
});
$('#reset-joints').addEventListener('click', () => {
  const f = state.selected;
  if (!f) return;
  f.edits = {};
  refresh();
});
$('#deselect').addEventListener('click', () => select(null));

// 수동 모드에서는 다 그린 뒤 인식 버튼(Enter)으로 인식한다. R은 자동/수동 전환.
function recognizeNow() {
  clearTimeout(timer);
  processDirty();
}
// 인식 버튼은 수동 모드에서만 보이고, 아직 인식하지 않은 획이 있을 때만 진하게 눌린다
function updateRecognize() {
  const pending = persons.some((p) => p.dirty);
  $('#recognize').disabled = !pending;
  $('#recognize').classList.toggle('on', pending);
}
function setAuto(on) {
  state.auto = on;
  saveSetting('auto', on);
  $('#mode-auto').classList.toggle('on', on);
  $('#mode-manual').classList.toggle('on', !on);
  $('#recognize').hidden = on;
  updateRecognize();
  if (on && persons.some((p) => p.dirty)) recognizeNow();
}
$('#mode-auto').addEventListener('click', () => setAuto(true));
$('#mode-manual').addEventListener('click', () => setAuto(false));
$('#recognize').addEventListener('click', recognizeNow);
setAuto(state.auto);

$('#threshold').addEventListener('input', () => {
  $('#threshold-val').textContent = (+$('#threshold').value).toFixed(2);
  refresh();
  setStatus(summary());
});
$('#model').addEventListener('change', () => markDirty(figures().map((f) => f.id)));
$('#fov').addEventListener('input', () => {
  $('#fov-val').textContent = `${$('#fov').value}°`;
  viewer.setFov(+$('#fov').value);
  updateCameraInfo();
});
$('#grid').addEventListener('change', () => (viewer.grid.visible = $('#grid').checked));
$('#frame').addEventListener('click', () => {
  state.autoFrame = true;
  viewer.frameAll();
  updateCameraInfo();
});
$('#export-png').addEventListener('click', async () => download(await viewer.capture(), 'rkgk-view.png'));
$('#export-zip').addEventListener('click', () => exportZip().catch((e) => setStatus(e.message)));

// 오프라인에서도 쓸 수 있도록 서비스 워커를 등록한다. 새 버전은 다음에 열 때 자동으로 적용된다.
registerSW({ immediate: true });

setStatus('모델 준비 중', true);
recognition.preload($('#model').value);

// 3D 재질의 셰이더를 미리 컴파일해 둔다. 안 하면 처음 인물이 나타날 때 화면이 0.5초쯤 멈춘다.
createBody('anime-female', COLORS[0])
  .then((body) => {
    const dummy = new Mannequin(COLORS[0]);
    dummy.setBody(body);
    dummy.showHandles(true);
    for (const m of Object.values(dummy.markers)) m.visible = true;
    return viewer.warmUp(dummy.root);
  })
  .catch((err) => console.warn('셰이더 미리 컴파일 실패', err));
updateCameraInfo();
