import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { loadLayers, inkBounds, cropForDetection, silhouette } from './input.js';
import { detectPose } from './pose.js';
import { Mannequin, KEY_JOINTS } from './mannequin.js';
import { toBVH } from './bvh.js';
import { Viewer } from './viewer.js';

const $ = (s) => document.querySelector(s);
const COLORS = ['#e0745a', '#4f8fd6', '#5cb06b', '#b57fd0', '#d9a83c', '#3fb3b3', '#d0679b', '#8a8f3a'];
const DEPTH_STEP = 0.6; // 레이어 한 칸당 앞뒤 간격(m)

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

const state = { figures: [], selected: null, canvasH: 1000 };

const viewer = new Viewer($('#viewport'), {
  onSelect: (f) => select(f),
  onMove: () => updateCameraInfo(),
});
viewer.orbit.addEventListener('change', () => updateCameraInfo());

function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

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
  if (!fig.det) {
    m.setDefaultPose();
    m.setLowConfidence([]);
    fig.low = [];
    return;
  }
  const { lm, vis } = figureLandmarks(fig);
  m.applyLandmarks(lm);
  const thr = +$('#threshold').value;
  const low = KEY_JOINTS.filter(([i]) => vis[i] < thr);
  fig.low = low.map(([, , label]) => label);
  m.setLowConfidence(low.map(([, bone]) => bone));
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function diag2d(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

// 레이어 순서대로 앞뒤 간격을 준다. 나중 레이어(배열 뒤쪽)일수록 카메라 쪽(+z)
function applyDepth() {
  const n = state.figures.length;
  state.figures.forEach((f, i) => {
    f.mannequin.root.position.z = (i - (n - 1) / 2) * DEPTH_STEP;
    f.home.z = f.mannequin.root.position.z;
  });
}

// 스케치 속 위치를 그대로 옮겨 인물들을 배치한다. 모든 인물은 같은 축척을 쓴다.
function layout() {
  const figs = state.figures;
  const ratios = [];
  const v = new THREE.Vector3();
  for (const f of figs) {
    f.mannequin.root.position.set(0, 0, 0);
    f.mannequin.root.scale.setScalar(1);
    poseFigure(f);
    if (!f.det) continue;
    f.mannequin.root.updateWorldMatrix(true, true);
    const joints = KEY_JOINTS.slice(1);
    const p3 = joints.map(([, bone]) => f.mannequin.bones[bone].getWorldPosition(v).toArray());
    const p2 = joints.map(([i]) => f.px[i]);
    const d2 = diag2d(p2);
    if (d2 > 1) ratios.push(diag2d(p3) / d2);
  }
  const s = ratios.length ? median(ratios) : 1.7 / state.canvasH; // m/px
  const cx = figs.reduce((a, f) => a + f.anchor[0], 0) / figs.length;
  for (const f of figs) f.mannequin.root.position.set((f.anchor[0] - cx) * s, -f.anchor[1] * s - 1.0, 0);
  // 가장 낮은 발이 바닥(y=0)에 닿도록 전체를 올린다
  let minY = Infinity;
  for (const f of figs) minY = Math.min(minY, new THREE.Box3().setFromObject(f.mannequin.root).min.y);
  for (const f of figs) {
    f.mannequin.root.position.y -= minY;
    f.home = f.mannequin.root.position.clone();
  }
  applyDepth();
}

function drawThumb(fig) {
  const c = document.createElement('canvas');
  const size = 120;
  const b = fig.box, pad = Math.max(b.w, b.h) * 0.1;
  const sw = b.w + pad * 2, sh = b.h + pad * 2, k = size / Math.max(sw, sh);
  c.width = Math.round(sw * k);
  c.height = Math.round(sh * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(fig.canvas, b.x - pad, b.y - pad, sw, sh, 0, 0, c.width, c.height);
  if (fig.det) {
    const P = (i) => [(fig.px[i][0] - b.x + pad) * k, (fig.px[i][1] - b.y + pad) * k];
    const thr = +$('#threshold').value;
    ctx.lineWidth = 2;
    ctx.strokeStyle = fig.color;
    for (const [a, z] of BONES_2D) {
      ctx.beginPath();
      ctx.moveTo(...P(a));
      ctx.lineTo(...P(z));
      ctx.stroke();
    }
    for (const [i] of KEY_JOINTS) {
      ctx.fillStyle = (fig.det.image[i].visibility ?? 1) < thr ? '#ff2a2a' : fig.color;
      ctx.beginPath();
      ctx.arc(...P(i), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

function rankLabel(fig) {
  const n = state.figures.length;
  const rank = n - state.figures.indexOf(fig);
  return rank === 1 ? '맨 앞' : rank === n ? '맨 뒤' : `앞 ${rank}`;
}

function statusText(fig) {
  if (!fig.det) return { text: '인식 실패 · 기본 자세', cls: 'bad' };
  if (fig.low.length) return { text: `신뢰도 낮음: ${fig.low.join(', ')}`, cls: 'warn' };
  return { text: '인식 양호', cls: 'ok' };
}

function renderList() {
  const ul = $('#figures');
  ul.innerHTML = '';
  // 클튜 레이어 패널처럼 앞(나중 레이어)을 위에 보여 준다
  for (const fig of [...state.figures].reverse()) {
    const li = document.createElement('li');
    li.className = 'figure' + (fig === state.selected ? ' selected' : '');
    li.style.setProperty('--fig', fig.color);
    const st = statusText(fig);
    li.innerHTML = `
      <div class="thumb"></div>
      <div class="meta">
        <div class="name"><span class="rank"></span><span class="label"></span></div>
        <div class="state ${st.cls}"></div>
      </div>
      <div class="order">
        <button class="icon" data-dir="1" title="더 앞으로">▲</button>
        <button class="icon" data-dir="-1" title="더 뒤로">▼</button>
      </div>`;
    li.querySelector('.thumb').appendChild(drawThumb(fig));
    li.querySelector('.rank').textContent = rankLabel(fig);
    li.querySelector('.label').textContent = fig.name;
    li.querySelector('.state').textContent = st.text;
    li.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-dir]');
      if (btn) move(fig, +btn.dataset.dir);
      else select(fig);
    });
    ul.appendChild(li);
    viewer.updateLabel(fig, `${rankLabel(fig)} · ${fig.name}`, fig.color);
  }
  $('#empty').hidden = state.figures.length > 0;
  $('#export-png').disabled = $('#export-zip').disabled = !state.figures.length;
}

function move(fig, dir) {
  const a = state.figures, i = a.indexOf(fig), j = i + dir;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  applyDepth();
  renderList();
}

function select(fig) {
  state.selected = fig ?? null;
  viewer.select(state.selected);
  const panel = $('#fig-panel');
  panel.hidden = !fig;
  if (fig) {
    $('#fig-title').textContent = `${rankLabel(fig)} · ${fig.name}`;
    $('#fig-title').style.color = fig.color;
    for (const btn of panel.querySelectorAll('[data-flip]')) btn.classList.toggle('on', !!fig.flips[btn.dataset.flip]);
    $('#scale').value = fig.mannequin.root.scale.x;
    $('#scale-val').textContent = (+$('#scale').value).toFixed(2);
    panel.querySelectorAll('[data-flip]:not([data-flip=body])').forEach((b) => (b.disabled = !fig.det));
    panel.querySelector('[data-flip=body]').disabled = !fig.det;
  }
  renderList();
}

async function handleFiles(files) {
  if (!files.length) return;
  try {
    setStatus('파일을 읽는 중…');
    const layers = await loadLayers(files, { colorSplit: $('#color-split').checked });
    const skipped = [];
    const figs = [];
    for (const layer of layers) {
      const box = inkBounds(layer.canvas);
      if (!box) {
        skipped.push(layer.name);
        continue;
      }
      const color = COLORS[figs.length % COLORS.length];
      figs.push({
        name: layer.name, canvas: layer.canvas, box, color,
        mannequin: new Mannequin(color),
        flips: {}, det: null, px: null, low: [], home: new THREE.Vector3(),
      });
    }
    if (!figs.length) throw new Error('선이 그려진 레이어를 찾지 못했습니다');
    state.figures = figs;
    state.canvasH = Math.max(...figs.map((f) => f.canvas.height));
    viewer.setFigures(figs);
    await detectAll();
    if (skipped.length) setStatus(`${$('#status').textContent} · 빈 레이어 건너뜀: ${skipped.join(', ')}`);
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
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

async function detectAll() {
  const figs = state.figures;
  const model = $('#model').value;
  for (const [i, f] of figs.entries()) {
    setStatus(`포즈 인식 중… (${i + 1}/${figs.length}) ${f.name}${i === 0 ? ' · 처음에는 모델을 내려받느라 시간이 걸립니다' : ''}`);
    const crop = cropForDetection(f.canvas, f.box);
    f.det = await detectBest(crop.canvas, model);
    f.px = f.det ? f.det.image.map((p) => crop.toSource(p.x, p.y)) : null;
    f.anchor = f.det
      ? [(f.px[23][0] + f.px[24][0]) / 2, (f.px[23][1] + f.px[24][1]) / 2]
      : [f.box.x + f.box.w / 2, f.box.y + f.box.h / 2];
  }
  layout();
  viewer.frameAll();
  select(null);
  updateCameraInfo();
  const failed = figs.filter((f) => !f.det).length;
  const low = figs.filter((f) => f.det && f.low.length).length;
  setStatus(`인물 ${figs.length}명` + (failed ? ` · 인식 실패 ${failed}명` : '') + (low ? ` · 신뢰도 낮은 관절이 있는 인물 ${low}명` : ''));
}

function updateCameraInfo() {
  const info = viewer.cameraInfo();
  $('#camera-info').textContent =
    `위치(cm)  ${info.position_cm.join(', ')}\n` +
    `주시점(cm) ${info.target_cm.join(', ')}\n` +
    `거리 ${info.distance_cm}cm\n` +
    `회전  yaw ${info.rotation_deg.yaw}° · pitch ${info.rotation_deg.pitch}° · roll ${info.rotation_deg.roll}°\n` +
    `화각  세로 ${info.vertical_fov_deg}° · 가로 ${info.horizontal_fov_deg}° (35mm 환산 ${info.focal_length_35mm}mm)`;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const safeName = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

async function exportZip() {
  const png = new Uint8Array(await (await viewer.capture()).arrayBuffer());
  const files = { 'view.png': png };
  const figures = state.figures.map((f, i) => {
    const file = `${String(i + 1).padStart(2, '0')}_${safeName(f.name)}.bvh`;
    files[file] = strToU8(toBVH(f.mannequin));
    const hips = f.mannequin.bones.Hips.getWorldPosition(new THREE.Vector3());
    return {
      file, name: f.name, order: rankLabel(f),
      hips_position_cm: hips.toArray().map((n) => +(n * 100).toFixed(1)),
      scale: +f.mannequin.root.scale.x.toFixed(3),
      flips: f.flips,
      recognized: !!f.det,
      low_confidence: f.low,
    };
  });
  const meta = { units: 'cm', up: '+Y', front: '+Z (카메라 쪽)', camera: viewer.cameraInfo(), figures };
  files['camera.json'] = strToU8(JSON.stringify(meta, null, 2));
  files['README.txt'] = strToU8(README_TXT);
  download(new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }), 'rkgk-pose.zip');
}

const README_TXT = `rkgk-to-3d 내보내기 묶음

view.png    웹에서 저장한 현재 시점 이미지
NN_*.bvh    인물별 포즈 (1프레임, Mixamo식 뼈 이름, cm 단위). 번호가 클수록 앞 레이어
camera.json 카메라 수치와 인물별 위치·크기·보정 내용

클립 스튜디오에서 쓰기 (Ver. 3.1 이상, BVH 지원 버전)
1. 3D 레이어에 데생 인형을 인물 수만큼 올린다.
2. 각 데생 인형에 BVH 파일을 하나씩 적용한다.
3. 배치를 유지하려면 "위치 고정"을 끈다. 모든 BVH의 위치는 같은 좌표계(cm) 기준이다.
4. view.png를 반투명하게 깔고 카메라를 맞춘다. camera.json의 수치를 참고한다.
5. 손끝 같은 세부는 클립 스튜디오에서 조정한다.

웹에서 바꾼 크기는 BVH에 담기지 않는다. 데생 인형 크기는 camera.json의 scale을 보고 맞춘다.
`;

// --- UI 연결 ---
$('#file').addEventListener('change', (e) => handleFiles(e.target.files));
const drop = $('#drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over')));
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => (e.preventDefault(), handleFiles(e.dataTransfer.files)));

$('#threshold').addEventListener('input', () => {
  $('#threshold-val').textContent = (+$('#threshold').value).toFixed(2);
  for (const f of state.figures) poseFigure(f);
  renderList();
});
$('#model').addEventListener('change', () => state.figures.length && detectAll().catch((e) => setStatus(e.message, true)));

for (const btn of document.querySelectorAll('[data-flip]')) {
  btn.addEventListener('click', () => {
    const f = state.selected;
    if (!f) return;
    f.flips[btn.dataset.flip] = !f.flips[btn.dataset.flip];
    poseFigure(f);
    select(f);
  });
}
$('#scale').addEventListener('input', () => {
  if (!state.selected) return;
  state.selected.mannequin.root.scale.setScalar(+$('#scale').value);
  $('#scale-val').textContent = (+$('#scale').value).toFixed(2);
});
$('#reset-pos').addEventListener('click', () => {
  const f = state.selected;
  if (!f) return;
  f.mannequin.root.position.copy(f.home);
  f.mannequin.root.scale.setScalar(1);
  select(f);
});
$('#deselect').addEventListener('click', () => select(null));

$('#fov').addEventListener('input', () => {
  $('#fov-val').textContent = $('#fov').value;
  viewer.setFov(+$('#fov').value);
  updateCameraInfo();
});
$('#grid').addEventListener('change', () => (viewer.grid.visible = $('#grid').checked));
$('#frame').addEventListener('click', () => (viewer.frameAll(), updateCameraInfo()));
$('#export-png').addEventListener('click', async () => download(await viewer.capture(), 'rkgk-view.png'));
$('#export-zip').addEventListener('click', () => exportZip().catch((e) => setStatus(e.message, true)));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
});

updateCameraInfo();
renderList();
