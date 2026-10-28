// 그린 레이어를 포즈 인식에 넣기 좋은 모양으로 다듬는다.

// 화면에서도, 백그라운드 워커(DOM 없음)에서도 쓸 수 있는 캔버스
export function newCanvas(w, h) {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
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
// close(0~1)는 선을 두껍게 했다가 다시 깎아서(닫기) 굵기는 그대로 두고 끊긴 틈만 메운다. 러프한 선 그림에 쓴다.
export function silhouette(canvas, { thicken = 0, close = 0 } = {}) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = d[i * 4] < 200 || d[i * 4 + 1] < 200 || d[i * 4 + 2] < 200 ? 1 : 0;
  const grow = (m, r) => dilate1d(dilate1d(m, w, h, r, true), w, h, r, false);
  const invert = (m) => m.map((v) => 1 - v);
  const r = Math.round(Math.max(w, h) * thicken);
  if (r > 0) mask = grow(mask, r);
  const rc = Math.round(Math.max(w, h) * close);
  if (rc > 0) mask = invert(grow(invert(grow(mask, rc)), rc));
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
  const out = newCanvas(w, h);
  const o = out.getContext('2d').createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = outside[i] ? 255 : 51;
    o.data[i * 4] = o.data[i * 4 + 1] = o.data[i * 4 + 2] = v;
    o.data[i * 4 + 3] = 255;
  }
  out.getContext('2d').putImageData(o, 0, 0);
  return out;
}
