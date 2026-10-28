// 그리기 판. 색(인물)마다 레이어 캔버스를 따로 두고, 그 위에 관절 안내선과 도구 표시용 캔버스를 겹친다.

const HISTORY_LIMIT = 80;

function canvas(w, h, cls) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  if (cls) c.className = cls;
  return c;
}

function clampRect(r, w, h) {
  const x = Math.max(0, Math.floor(r.x0)), y = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(w, Math.ceil(r.x1)), y1 = Math.min(h, Math.ceil(r.y1));
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

export class DrawingBoard {
  constructor(host, { width, height, colors, onChange, onJointDrag }) {
    this.W = width;
    this.H = height;
    this.colors = colors;
    this.onChange = onChange;
    this.onJointDrag = onJointDrag;
    this.tool = 'pen';
    this.active = 0;
    this.sizes = { pen: 8, eraser: 36 };
    this.undoStack = [];
    this.redoStack = [];
    this.guides = [];
    this.showGuides = true;

    this.paper = document.createElement('div');
    this.paper.className = 'paper';
    this.layers = colors.map(() => canvas(width, height, 'layer'));
    this.guide = canvas(width, height, 'layer guide');
    this.ui = canvas(width, height, 'layer ui');
    this.paper.append(...this.layers, this.guide, this.ui);
    host.appendChild(this.paper);
    this.snap = canvas(width, height);

    new ResizeObserver(() => this.#fit(host)).observe(host);
    this.#fit(host);
    this.#bindPointer();
  }

  #fit(host) {
    const k = Math.min(host.clientWidth / this.W, host.clientHeight / this.H);
    this.paper.style.width = `${this.W * k}px`;
    this.paper.style.height = `${this.H * k}px`;
  }

  #pos(e) {
    const r = this.ui.getBoundingClientRect();
    return [((e.clientX - r.left) * this.W) / r.width, ((e.clientY - r.top) * this.H) / r.height];
  }

  // 펜은 필압을 쓰고, 마우스·터치는 일정한 굵기로 그린다
  #width(e) {
    const base = this.sizes[this.tool];
    return e.pointerType === 'pen' ? base * (0.15 + 0.85 * (e.pressure || 0)) : base;
  }

  #bindPointer() {
    const el = this.ui;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
      const p = this.#pos(e);
      if (this.tool === 'joint') {
        this.joint = this.#nearestJoint(p);
        el.classList.toggle('dragging', !!this.joint);
      } else if (this.tool === 'lasso') this.#lassoDown(p);
      else this.#strokeStart(p, this.#width(e));
    });
    el.addEventListener('pointermove', (e) => {
      this.hover = this.#pos(e);
      if (this.tool === 'joint') {
        if (this.joint) this.onJointDrag?.(this.joint.id, this.joint.index, ...this.hover, 'move');
        else el.classList.toggle('over', !!this.#nearestJoint(this.hover));
        return;
      }
      if (this.stroke) {
        for (const ev of e.getCoalescedEvents?.() ?? [e]) this.#strokeTo(this.#pos(ev), this.#width(ev));
      } else if (this.lasso) {
        this.lasso.push(this.hover);
      } else if (this.drag) {
        this.float.dx = this.drag.dx + this.hover[0] - this.drag.p[0];
        this.float.dy = this.drag.dy + this.hover[1] - this.drag.p[1];
      }
      this.#drawUI();
    });
    const up = () => {
      if (this.joint) {
        if (this.hover) this.onJointDrag?.(this.joint.id, this.joint.index, ...this.hover, 'end');
        this.joint = null;
        el.classList.remove('dragging');
        return;
      }
      if (this.stroke) this.#strokeEnd();
      else if (this.lasso) this.#lassoLift();
      this.drag = null;
      this.#drawUI();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => {
      this.hover = null;
      this.#drawUI();
    });
  }

  // --- 관절 도구: 인식된 관절 점을 끌어 옮긴다 ---

  #nearestJoint([x, y]) {
    // 화면에서 손가락 하나 정도(약 20px) 안에 있는 가장 가까운 점
    const reach = (20 * this.W) / this.ui.getBoundingClientRect().width;
    let best = null, bestD = reach;
    for (const g of this.guides) {
      for (const p of g.points) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) [best, bestD] = [{ id: g.id, index: p.index }, d];
      }
    }
    return best;
  }

  // --- 펜 · 지우개 ---

  #strokeStart(p, w) {
    const ctx = this.layers[this.active].getContext('2d');
    this.#snapshot();
    this.stroke = { ctx, last: p, w, rect: { x0: p[0], y0: p[1], x1: p[0], y1: p[1] } };
    ctx.save();
    ctx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = ctx.strokeStyle = this.colors[this.active];
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2);
    ctx.fill();
    this.#grow(p, w);
  }

  #strokeTo(p, rawW) {
    const s = this.stroke;
    const w = s.w * 0.6 + rawW * 0.4; // 필압이 튀지 않게 부드럽게
    s.ctx.lineWidth = (s.w + w) / 2;
    s.ctx.beginPath();
    s.ctx.moveTo(...s.last);
    s.ctx.lineTo(...p);
    s.ctx.stroke();
    s.last = p;
    s.w = w;
    this.#grow(p, w);
  }

  #grow(p, w) {
    const r = this.stroke.rect, pad = w / 2 + 2;
    r.x0 = Math.min(r.x0, p[0] - pad);
    r.y0 = Math.min(r.y0, p[1] - pad);
    r.x1 = Math.max(r.x1, p[0] + pad);
    r.y1 = Math.max(r.y1, p[1] + pad);
  }

  #strokeEnd() {
    const { ctx, rect } = this.stroke;
    ctx.restore();
    this.stroke = null;
    this.#record([{ layer: this.active, rect }]);
  }

  // --- 라쏘: 영역을 떼어 내서 옮기거나 지운다 ---

  #lassoDown(p) {
    if (this.float && this.#inFloat(p)) {
      this.drag = { p, dx: this.float.dx, dy: this.float.dy };
      return;
    }
    this.commitSelection();
    this.lasso = [p];
  }

  #path(points, dx = 0, dy = 0) {
    const path = new Path2D();
    points.forEach(([x, y], i) => (i ? path.lineTo(x + dx, y + dy) : path.moveTo(x + dx, y + dy)));
    path.closePath();
    return path;
  }

  #inFloat(p) {
    const f = this.float;
    return this.ui.getContext('2d').isPointInPath(this.#path(f.points, f.dx, f.dy), ...p);
  }

  #lassoLift() {
    const points = this.lasso;
    this.lasso = null;
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const box = clampRect({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, this.W, this.H);
    if (!box || box.w < 4 || box.h < 4) return;
    const layer = this.layers[this.active];
    this.#snapshot();
    const piece = canvas(box.w, box.h);
    const pctx = piece.getContext('2d');
    pctx.clip(this.#path(points, -box.x, -box.y));
    pctx.drawImage(layer, -box.x, -box.y);
    const ctx = layer.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(this.#path(points));
    ctx.restore();
    this.float = { layer: this.active, points, box, piece, dx: 0, dy: 0 };
  }

  get hasSelection() {
    return !!this.float;
  }

  // 떼어 낸 영역을 내려놓는다. remove면 내려놓지 않고 지운다.
  commitSelection(remove = false) {
    const f = this.float;
    if (!f) return;
    this.float = null;
    const ctx = this.layers[f.layer].getContext('2d');
    if (!remove) ctx.drawImage(f.piece, Math.round(f.box.x + f.dx), Math.round(f.box.y + f.dy));
    const b = f.box;
    const rect = {
      x0: Math.min(b.x, b.x + f.dx), y0: Math.min(b.y, b.y + f.dy),
      x1: Math.max(b.x, b.x + f.dx) + b.w + 1, y1: Math.max(b.y, b.y + f.dy) + b.h + 1,
    };
    if (remove || f.dx || f.dy) this.#record([{ layer: f.layer, rect }]);
    this.#drawUI();
  }

  // --- 되돌리기 ---

  #snapshot() {
    const s = this.snap.getContext('2d');
    s.clearRect(0, 0, this.W, this.H);
    s.drawImage(this.layers[this.active], 0, 0);
  }

  #record(parts) {
    const entry = [];
    for (const { layer, rect, before } of parts) {
      const r = clampRect(rect, this.W, this.H);
      if (!r) continue;
      entry.push({
        layer, r,
        before: before ?? this.snap.getContext('2d').getImageData(r.x, r.y, r.w, r.h),
        after: this.layers[layer].getContext('2d').getImageData(r.x, r.y, r.w, r.h),
      });
    }
    if (!entry.length) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.#changed(entry);
  }

  #apply(entry, key) {
    for (const part of entry) this.layers[part.layer].getContext('2d').putImageData(part[key], part.r.x, part.r.y);
    this.#changed(entry);
  }

  #changed(entry) {
    this.onChange?.([...new Set(entry.map((p) => p.layer))]);
  }

  undo() {
    this.commitSelection();
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.#apply([...e].reverse(), 'before');
  }

  redo() {
    this.commitSelection();
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.#apply(e, 'after');
  }

  clearAll() {
    this.commitSelection();
    const full = { x0: 0, y0: 0, x1: this.W, y1: this.H };
    const parts = this.layers.map((c, layer) => {
      const ctx = c.getContext('2d');
      const before = ctx.getImageData(0, 0, this.W, this.H);
      ctx.clearRect(0, 0, this.W, this.H);
      return { layer, rect: full, before };
    });
    this.#record(parts);
  }

  // --- 상태 ---

  setTool(tool) {
    if (tool !== 'lasso') this.commitSelection();
    this.tool = tool;
    this.ui.dataset.tool = tool;
    this.#drawUI();
  }

  setActive(i) {
    this.commitSelection();
    this.active = i;
    this.#drawUI();
  }

  setSize(v) {
    if (this.tool !== 'lasso') this.sizes[this.tool] = v;
  }

  // 앞 인물의 레이어가 위에 오도록 쌓는다
  setOrder(ids) {
    ids.forEach((id, i) => (this.layers[id].style.zIndex = i + 1));
  }

  // 흰 바탕에 모든 레이어를 합친 이미지
  composite(ids) {
    const c = canvas(this.W, this.H), ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.W, this.H);
    for (const id of ids) ctx.drawImage(this.layers[id], 0, 0);
    return c;
  }

  // 인식된 관절을 그림 위에 겹쳐 보여 준다. guides: [{ color, lines: [[a,b]...], points: [[x,y,low]...] }]
  setGuides(guides) {
    this.guides = guides;
    const ctx = this.guide.getContext('2d');
    ctx.clearRect(0, 0, this.W, this.H);
    if (!this.showGuides) return;
    for (const g of guides) {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = g.color;
      ctx.lineWidth = 3;
      ctx.setLineDash([2, 6]);
      ctx.lineCap = 'round';
      for (const [a, b] of g.lines) {
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      for (const { x, y, low } of g.points) {
        ctx.fillStyle = low ? '#ff3b30' : '#fff';
        ctx.strokeStyle = low ? '#ff3b30' : g.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  toggleGuides(on) {
    this.showGuides = on;
    this.setGuides(this.guides);
  }

  #drawUI() {
    const ctx = this.ui.getContext('2d');
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.lineWidth = 1.5;
    if (this.float) {
      const f = this.float;
      ctx.drawImage(f.piece, f.box.x + f.dx, f.box.y + f.dy);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#111';
      ctx.stroke(this.#path(f.points, f.dx, f.dy));
      ctx.setLineDash([]);
    }
    if (this.lasso) {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = '#111';
      ctx.beginPath();
      this.lasso.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.hover && this.tool !== 'lasso' && this.tool !== 'joint') {
      ctx.strokeStyle = this.tool === 'eraser' ? '#999' : this.colors[this.active];
      ctx.beginPath();
      ctx.arc(...this.hover, Math.max(2, this.sizes[this.tool] / 2), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
