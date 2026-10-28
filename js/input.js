// 업로드한 파일을 인물별 레이어 [{ name, canvas }]로 바꾼다.
// 배열 순서는 뒤 → 앞 (나중에 만든 레이어일수록 앞).

const AG_PSD = 'https://cdn.jsdelivr.net/npm/ag-psd@20.2.0/dist/bundle.js';

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function imageToCanvas(file) {
  const bmp = await createImageBitmap(file);
  const c = newCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  return c;
}

let agPsdPromise;
function loadAgPsd() {
  agPsdPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = AG_PSD;
    s.onload = () => resolve(window.agPsd);
    s.onerror = () => reject(new Error('PSD 읽기 라이브러리를 불러오지 못했습니다'));
    document.head.appendChild(s);
  });
  return agPsdPromise;
}

function drawPsdNode(ctx, node) {
  if (node.hidden) return;
  if (node.children) {
    for (const child of node.children) drawPsdNode(ctx, child);
  } else if (node.canvas) {
    ctx.globalAlpha = node.opacity ?? 1;
    ctx.drawImage(node.canvas, node.left ?? 0, node.top ?? 0);
    ctx.globalAlpha = 1;
  }
}

// PSD의 최상위 레이어(또는 폴더) 하나를 인물 한 명으로 본다. ag-psd의 children은 아래 → 위 순서다.
async function psdToLayers(file) {
  const agPsd = await loadAgPsd();
  const psd = agPsd.readPsd(await file.arrayBuffer());
  const layers = [];
  for (const node of psd.children ?? []) {
    if (node.hidden) continue;
    const c = newCanvas(psd.width, psd.height);
    drawPsdNode(c.getContext('2d'), node);
    layers.push({ name: node.name || `레이어 ${layers.length + 1}`, canvas: c });
  }
  return layers;
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max ? d / max : 0, max / 255];
}

// 한 장에 인물마다 다른 색으로 그린 그림을 색상(hue)별로 나눈다.
// 검정·회색 선은 어느 인물에도 넣지 않는다. 기본 순서는 왼쪽 → 오른쪽.
function splitByColor(src, name) {
  const { width: w, height: h } = src;
  const data = src.getContext('2d').getImageData(0, 0, w, h).data;
  const BINS = 36;
  const binOf = new Int16Array(w * h).fill(-1);
  const hist = new Array(BINS).fill(0);
  let colored = 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    if (data[p + 3] < 40) continue;
    const [hue, sat, val] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
    if (sat < 0.3 || val < 0.2) continue;
    const bin = Math.floor(hue / (360 / BINS)) % BINS;
    binOf[i] = bin;
    hist[bin]++;
    colored++;
  }
  // 픽셀이 충분한 칸을 이어 붙여 색 덩어리를 만든다 (색상환이므로 끝과 처음도 이어진다)
  const on = hist.map((n) => n > colored * 0.01);
  const cluster = new Int16Array(BINS).fill(-1);
  let start = on.findIndex((v) => !v);
  if (start < 0) start = 0;
  let k = -1;
  for (let j = 1; j <= BINS; j++) {
    const b = (start + j) % BINS;
    if (!on[b]) continue;
    if (!on[(b + BINS - 1) % BINS] || k < 0) k++;
    cluster[b] = k;
  }
  const n = k + 1;
  const outs = Array.from({ length: n }, () => newCanvas(w, h));
  const imgs = outs.map((c) => c.getContext('2d').createImageData(w, h));
  const sumX = new Array(n).fill(0), cnt = new Array(n).fill(0), sumRGB = outs.map(() => [0, 0, 0]);
  for (let i = 0; i < w * h; i++) {
    const c = binOf[i] < 0 ? -1 : cluster[binOf[i]];
    if (c < 0) continue;
    const p = i * 4;
    imgs[c].data.set(data.subarray(p, p + 4), p);
    sumX[c] += i % w;
    cnt[c]++;
    for (let t = 0; t < 3; t++) sumRGB[c][t] += data[p + t];
  }
  const hex = (c) => '#' + sumRGB[c].map((v) => Math.round(v / cnt[c]).toString(16).padStart(2, '0')).join('');
  return outs
    .map((c, i) => {
      c.getContext('2d').putImageData(imgs[i], 0, 0);
      return { name: `${name} · 색 ${hex(i)}`, canvas: c, x: sumX[i] / cnt[i] };
    })
    .sort((a, b) => a.x - b.x)
    .map(({ name, canvas }) => ({ name, canvas }));
}

export async function loadLayers(files, { colorSplit }) {
  const list = [...files];
  const psds = list.filter((f) => /\.psd$/i.test(f.name));
  const images = list
    .filter((f) => f.type.startsWith('image/') && !/\.psd$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const layers = [];
  for (const f of psds) layers.push(...(await psdToLayers(f)));
  for (const f of images) {
    const canvas = await imageToCanvas(f);
    const name = f.name.replace(/\.[^.]+$/, '');
    if (colorSplit && images.length === 1 && !psds.length) layers.push(...splitByColor(canvas, name));
    else layers.push({ name, canvas });
  }
  return layers;
}

// 선이 있는 영역. 투명하거나 거의 흰 픽셀은 바탕으로 본다. 선이 거의 없으면 null
export function inkBounds(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (d[p + 3] < 40 || (d[p] > 235 && d[p + 1] > 235 && d[p + 2] > 235)) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (count < 50) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 선 영역을 여백과 함께 잘라 흰 바탕에 올린다. 인식 결과(0~1)를 원본 좌표로 돌려주는 함수도 함께 준다.
export function cropForDetection(canvas, box, size = 768) {
  const pad = Math.max(box.w, box.h) * 0.2;
  const sx = box.x - pad, sy = box.y - pad, sw = box.w + pad * 2, sh = box.h + pad * 2;
  const scale = size / Math.max(sw, sh);
  const c = newCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return { canvas: c, toSource: (nx, ny) => [sx + nx * sw, sy + ny * sh] };
}

// 한 축 방향으로 반경 r 안에 선이 있으면 선으로 만든다 (팽창)
function dilate1d(mask, w, h, r, horizontal) {
  const out = new Uint8Array(w * h);
  const [n, m] = horizontal ? [h, w] : [w, h];
  const at = horizontal ? (line, i) => line * w + i : (line, i) => i * w + line;
  for (let line = 0; line < n; line++) {
    let count = 0;
    for (let i = 0; i < Math.min(r, m); i++) count += mask[at(line, i)];
    for (let i = 0; i < m; i++) {
      if (i + r < m) count += mask[at(line, i + r)];
      if (i - r - 1 >= 0) count -= mask[at(line, i - r - 1)];
      out[at(line, i)] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

// 선 그림을 실루엣으로 바꾼다. 테두리에서 닿는 바탕만 남기고 선으로 둘러싸인 안쪽은 칠한다.
// 포즈 인식 모델은 선만 있는 그림보다 면으로 칠한 인체를 훨씬 잘 잡는다.
// thicken(0~1)은 그림 크기 대비 선을 두껍게 하는 정도로, 졸라맨처럼 선 하나로 된 팔다리에 살을 붙인다.
export function silhouette(canvas, thicken = 0) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = d[i * 4] < 200 || d[i * 4 + 1] < 200 || d[i * 4 + 2] < 200 ? 1 : 0;
  const r = Math.round(Math.max(w, h) * thicken);
  if (r > 0) mask = dilate1d(dilate1d(mask, w, h, r, true), w, h, r, false);
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x);
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1);
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const o = out.getContext('2d').createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = outside[i] ? 255 : 51;
    o.data[i * 4] = o.data[i * 4 + 1] = o.data[i * 4 + 2] = v;
    o.data[i * 4 + 3] = 255;
  }
  out.getContext('2d').putImageData(o, 0, 0);
  return out;
}
