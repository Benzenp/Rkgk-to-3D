import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { registerSW } from 'virtual:pwa-register';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { inkBounds, cropForDetection, silhouette } from './input.js';
import { detectPose, preload } from './pose.js';
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
  flips: {}, offset: new THREE.Vector3(), scale: 1, auto: new THREE.Vector3(), dirty: false,
  sex: 'female', style: 'anime', bodyKind: null,
}));
// 처음 그린 순서 (뒤 → 앞). 나중에 그린 인물일수록 앞
const state = { order: [], selected: null, autoFrame: true };
const figures = () => state.order.map((id) => persons[id]).filter((p) => p.box);
// 3D에 올리는 인물: 사람으로 인식된 것만
const placed = () => figures().filter((p) => p.det);

const viewer = new Viewer($('#viewport'), {
  onSelect: (f) => select(f),
  onMove: (f) => {
    if (f) f.offset.copy(f.mannequin.root.position).sub(f.auto);
    updateCameraInfo();
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
  const thr = +$('#threshold').value;
  const low = KEY_JOINTS.filter(([i]) => vis[i] < thr);
  fig.low = low.map(([, , label]) => label);
  m.setLowConfidence(low.map(([, bone]) => bone));
}

// 원본 → 실루엣 → 선을 두껍게 한 실루엣 순서로 인식해 보고, 주요 관절 신뢰도 평균이 가장 높은 결과를 쓴다
async function detectBest(canvas, model) {
  const score = (det) => KEY_JOINTS.reduce((a, [i]) => a + (det.image[i].visibility ?? 1), 0) / KEY_JOINTS.length;
  let best = null, bestScore = -1;
  for (const make of [() => canvas, () => silhouette(canvas), () => silhouette(canvas, 0.02)]) {
    const det = await detectPose(make(), model);
    const s = det ? score(det) : -1;
    if (s > bestScore) [best, bestScore] = [det, s];
    if (bestScore >= 0.9) break;
  }
  return best;
}

async function analyze(p) {
  const layer = board.layers[p.id];
  p.box = inkBounds(layer);
  if (!p.box) {
    p.det = null;
    return;
  }
  if (!state.order.includes(p.id)) state.order.push(p.id);
  p.mannequin ??= new Mannequin(p.color);
  ensureBody(p);
  const crop = cropForDetection(layer, p.box);
  p.det = await detectBest(crop.canvas, $('#model').value);
  p.px = p.det ? p.det.image.map((l) => crop.toSource(l.x, l.y)) : null;
  p.anchor = p.det
    ? [(p.px[23][0] + p.px[24][0]) / 2, (p.px[23][1] + p.px[24][1]) / 2]
    : [p.box.x + p.box.w / 2, p.box.y + p.box.h / 2];
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
  for (const id of ids) persons[id].dirty = true;
  clearTimeout(timer);
  timer = setTimeout(processDirty, DEBOUNCE_MS);
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
  return [figs.length && `인물 ${figs.length}명`, low && `불확실 ${low}`, waiting && `인식 대기 ${waiting}`].filter(Boolean).join(' · ');
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
  for (const f of figs) {
    // 인체 모델의 경계는 현재 자세·위치로 다시 계산한다
    f.mannequin.root.updateMatrixWorld(true);
    for (const m of f.mannequin.body?.meshes ?? []) m.boundingBox = null;
    minY = Math.min(minY, new THREE.Box3().setFromObject(f.mannequin.root).min.y);
  }
  figs.forEach((f, i) => {
    const root = f.mannequin.root;
    root.position.y -= minY;
    root.position.z = (i - (figs.length - 1) / 2) * DEPTH_STEP;
    f.auto.copy(root.position);
    root.position.add(f.offset);
    root.scale.setScalar(f.scale);
  });
}

function refresh() {
  const figs = placed();
  if (figs.length !== viewer.figures.length || figs.some((f, i) => viewer.figures[i] !== f)) viewer.setFigures(figs);
  board.setOrder(state.order);
  if (figs.length) layout();
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
        color: f.color,
        lines: BONES_2D.map(([a, b]) => [f.px[a], f.px[b]]),
        points: KEY_JOINTS.map(([i]) => [...f.px[i], (f.det.image[i].visibility ?? 1) < thr]),
      }))
  );
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
    if (fig.label) viewer.updateLabel(fig, [fig.name, rankLabel(fig)].filter(Boolean).join(' · '), fig.color);
  }
}

function renderCard() {
  const fig = state.selected;
  $('#card').hidden = !fig;
  if (!fig) return;
  const figs = placed(), i = figs.indexOf(fig);
  $('#card-dot').style.setProperty('--c', fig.color);
  $('#card-title').textContent = [fig.name, rankLabel(fig)].filter(Boolean).join(' · ');
  const st = stateOf(fig);
  $('#card-state').textContent = st.text;
  $('#card-state').className = 'muted ' + st.cls;
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
}

function select(fig) {
  state.selected = fig ?? null;
  viewer.select(state.selected?.det ? state.selected : null);
  renderChips();
  renderCard();
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
      body: f.bodyKind,
      flips: f.flips,
      low_confidence: f.low,
    };
  });
  const meta = { units: 'cm', up: '+Y', front: '+Z (카메라 쪽)', camera: viewer.cameraInfo(), figures: list };
  files['camera.json'] = strToU8(JSON.stringify(meta, null, 2));
  files['README.txt'] = strToU8(README_TXT);
  download(new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }), 'rkgk-pose.zip');
}

const README_TXT = `rkgk-to-3d 내보내기 묶음

view.png    웹에서 저장한 현재 시점 이미지
sketch.png  그린 스케치
NN_*.bvh    인물별 포즈 (1프레임, Mixamo식 뼈 이름, cm 단위). 번호가 클수록 앞
camera.json 카메라 수치와 인물별 위치·크기·보정 내용

클립 스튜디오에서 쓰기 (Ver. 3.1 이상, BVH 지원 버전)
1. 3D 레이어에 데생 인형을 인물 수만큼 올린다.
2. 각 데생 인형에 BVH 파일을 하나씩 적용한다.
3. 배치를 유지하려면 "위치 고정"을 끈다. 모든 BVH의 위치는 같은 좌표계(cm) 기준이다.
4. view.png를 반투명하게 깔고 카메라를 맞춘다. camera.json의 수치를 참고한다.
5. 손끝 같은 세부는 클립 스튜디오에서 조정한다.

웹에서 바꾼 크기는 BVH에 담기지 않는다. 데생 인형 크기는 camera.json의 scale을 보고 맞춘다.
`;

// --- 왼쪽 UI 연결 ---

const swatches = $('#swatches');
COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' on' : '');
  b.style.setProperty('--c', c);
  b.title = `인물 ${i + 1} (${i + 1})`;
  b.addEventListener('click', () => setActive(i));
  swatches.appendChild(b);
});

function setActive(i) {
  board.setActive(i);
  swatches.querySelectorAll('.swatch').forEach((b, j) => b.classList.toggle('on', i === j));
}

function setTool(tool) {
  board.setTool(tool);
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
$('#to-front').addEventListener('click', () => state.selected && move(state.selected, 1));
$('#to-back').addEventListener('click', () => state.selected && move(state.selected, -1));
$('#scale').addEventListener('input', () => {
  const f = state.selected;
  if (!f) return;
  f.scale = +$('#scale').value;
  f.mannequin.root.scale.setScalar(f.scale);
  $('#scale-val').textContent = f.scale.toFixed(2);
});
$('#reset-pos').addEventListener('click', () => {
  const f = state.selected;
  if (!f) return;
  f.offset.set(0, 0, 0);
  f.scale = 1;
  refresh();
});
$('#deselect').addEventListener('click', () => select(null));

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
preload($('#model').value)
  .then(() => !running && setStatus(summary()))
  .catch(() => setStatus('인식 모델을 불러오지 못했어요'));
updateCameraInfo();
