import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { inkOn } from './color.js';
import { overlaySprite } from './mannequin.js';

const R2D = THREE.MathUtils.radToDeg;
const UP = new THREE.Vector3(0, 1, 0);

// 광원 손잡이: 가운데가 하얗게 타고 바깥으로 번지는 빛 덩어리. 주·보조는 색으로만 구별한다.
function makeLightOrb(name, color) {
  return overlaySprite(`orb-${name}`, (g, n) => {
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.16, '#ffffff');
    grad.addColorStop(0.3, color);
    grad.addColorStop(0.55, color + '66');
    grad.addColorStop(1, color + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  }, 0.3, { order: 21 });
}

// 인형 위아래 이동 손잡이: 짙은 원에 위아래 화살표
const drawLift = (g, n) => {
  g.beginPath();
  g.arc(n / 2, n / 2, n * 0.4, 0, Math.PI * 2);
  g.fillStyle = 'rgba(22,22,22,0.85)';
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = n * 0.06;
  g.lineCap = g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(n * 0.5, n * 0.27);
  g.lineTo(n * 0.5, n * 0.73);
  g.moveTo(n * 0.38, n * 0.38);
  g.lineTo(n * 0.5, n * 0.26);
  g.lineTo(n * 0.62, n * 0.38);
  g.moveTo(n * 0.38, n * 0.62);
  g.lineTo(n * 0.5, n * 0.74);
  g.lineTo(n * 0.62, n * 0.62);
  g.stroke();
};

function makeLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace; // 인물 색이 칩·색 버튼과 같게 보이도록
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false }));
  sprite.scale.set(0.11, 0.11, 1);
  sprite.renderOrder = 20;
  sprite.userData.canvas = canvas;
  return sprite;
}

// 인물 번호를 인물 색 원 안에 쓴다. 색 버튼의 번호와 같은 모양이다.
function drawLabel(sprite, text, color) {
  const c = sprite.userData.canvas, ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = inkOn(color);
  ctx.font = '600 32px "Pretendard Variable", Pretendard, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  sprite.material.map.needsUpdate = true;
}

export class Viewer {
  constructor(container, { onSelect, onFigureDrag, onFigureRotate, onJointDrag, onLightDrag, onLightToggle }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onFigureDrag = onFigureDrag;
    this.onFigureRotate = onFigureRotate;
    this.onJointDrag = onJointDrag;
    this.onLightDrag = onLightDrag;
    this.onLightToggle = onLightToggle;
    this.selected = null;
    this.drag = null;
    this.ray = new THREE.Raycaster();
    this.figures = [];
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 그림자는 자세·배치·조명이 바뀔 때만 다시 그린다 (매 프레임 그리면 카메라만 돌려도 무겁다)
    this.renderer.shadowMap.autoUpdate = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf6f6f4);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x888899, 1.1));
    // 주 광원(그림자)과 보조 광원. 손잡이를 끌면 인물들 가운데를 비추는 방향이 바뀐다.
    this.stage = { center: new THREE.Vector3(0, 0.9, 0), radius: 2.5, reach: 1 }; // radius: 광원 거리(그림자), reach: 손잡이 거리(화면 안)
    this.lights = {};
    for (const [key, color, intensity, dir] of [
      ['key', '#ffb627', 2.2, [0.45, 0.75, 0.5]],
      ['fill', '#5f9bff', 0.7, [-0.55, 0.35, 0.75]],
    ]) {
      const light = new THREE.DirectionalLight(0xffffff, intensity);
      const handle = makeLightOrb(key, color);
      handle.userData.light = key;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineDashedMaterial({ color, dashSize: 0.04, gapSize: 0.05, depthTest: false, transparent: true, opacity: 0.5 }));
      line.renderOrder = 19;
      this.scene.add(light, light.target, handle, line);
      this.lights[key] = { light, handle, line, dir: new THREE.Vector3(...dir).normalize() };
    }
    const key = this.lights.key.light;
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    // 바닥은 그림자만 받는다
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    // 고른 인형 발밑의 회전 고리. 얇은 고리는 잡기 어려워서 보이지 않는 두꺼운 고리로 판정한다.
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.008, 6, 64),
      new THREE.MeshBasicMaterial({ color: 0x161616, depthTest: false, transparent: true, opacity: 0.55 }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 11;
    this.ring.visible = false;
    this.ringHit = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 6, 32), new THREE.MeshBasicMaterial({ visible: false }));
    this.ring.add(this.ringHit);
    // 고리 오른쪽(화면 기준)의 위아래 이동 손잡이
    this.lift = overlaySprite('lift', drawLift, 0.13, { opacity: 0.85, order: 13 });
    this.lift.visible = false;
    this.scene.add(this.lift);
    this.ringBox = new THREE.Box3();
    this.scene.add(this.ring);
    this.#placeLights();
    this.grid = new THREE.GridHelper(20, 40, 0xd4d4d0, 0xe6e6e2);
    this.scene.add(this.grid);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
    this.camera.position.set(0, 1.2, 6);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.9, 0);
    this.orbit.enableDamping = true;

    // 고른 인물의 관절 손잡이를 끌면 관절이, 인형 몸을 끌면 인형이 바닥 위로 옮겨진다. 빈 곳을 끌면 카메라가 돈다.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.#down(e), true); // 카메라 조작보다 먼저 판단한다
    el.addEventListener('pointermove', (e) => this.#move(e));
    el.addEventListener('pointerup', (e) => this.#up(e));
    el.addEventListener('pointercancel', (e) => this.#up(e));

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#render());
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #aim(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray;
  }

  #handleAt(e) {
    if (!this.selected) return null;
    const hit = this.#aim(e).intersectObjects(Object.values(this.selected.mannequin.handles), false)[0];
    return hit ? { fig: this.selected, index: hit.object.userData.joint, point: hit.object.getWorldPosition(new THREE.Vector3()) } : null;
  }

  // 조명 손잡이나 회전 고리를 눌렀는지
  #gizmoAt(e) {
    const ray = this.#aim(e);
    const handles = Object.values(this.lights).map((l) => l.handle);
    const light = ray.intersectObjects(handles, false)[0];
    if (light) return { kind: 'light', key: light.object.userData.light };
    if (this.selected && this.lift.visible && ray.intersectObject(this.lift, false).length) return { kind: 'lift', fig: this.selected };
    if (this.selected && this.ring.visible && ray.intersectObject(this.ringHit, false).length) return { kind: 'rotate', fig: this.selected };
    return null;
  }

  #figureAt(e) {
    const hit = this.#aim(e).intersectObjects(this.figures.flatMap((f) => f.mannequin.meshes), false)[0];
    return hit ? { fig: this.figures.find((f) => f.mannequin.meshes.includes(hit.object)), point: hit.point } : null;
  }

  #down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 오른쪽 드래그는 카메라 이동
    const start = [e.clientX, e.clientY];
    const gizmo = this.#gizmoAt(e);
    const handle = gizmo ? null : this.#handleAt(e);
    if (gizmo?.kind === 'light') {
      // 조명 손잡이는 인물들을 둘러싼 구의 겉면을 따라 끈다. 카메라 쪽에 있었으면 카메라 쪽 면, 뒤에 있었으면 뒷면.
      const l = this.lights[gizmo.key];
      const toCam = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      const side = Math.sign(l.dir.dot(toCam)) || 1;
      this.drag = { kind: 'light', key: gizmo.key, start, toCam, side, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(toCam, this.stage.center) };
    } else if (gizmo?.kind === 'lift') {
      // 카메라를 마주 보는 세로 평면 위에서 위아래로만 끈다
      const normal = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.lift.position);
      const p = this.ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.lift.position.clone();
      this.drag = { kind: 'lift', fig: gizmo.fig, start, plane, y0: p.y, root0: gizmo.fig.mannequin.root.position.y };
    } else if (gizmo?.kind === 'rotate') {
      // 고리는 바닥면 위에서, 인형 중심을 도는 각도로 돌린다
      const root = gizmo.fig.mannequin.root;
      const plane = new THREE.Plane(UP, -this.ring.position.y);
      const p = this.ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? root.position.clone();
      this.drag = { kind: 'rotate', fig: gizmo.fig, start, plane, angle: Math.atan2(p.x - root.position.x, p.z - root.position.z), yaw: root.rotation.y };
    } else if (handle) {
      // 관절은 카메라를 향한 평면 위에서 끈다
      const normal = this.camera.getWorldDirection(new THREE.Vector3());
      this.drag = { kind: 'joint', ...handle, start, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, handle.point) };
    } else {
      const body = this.#figureAt(e);
      if (body) {
        // 인형은 잡은 높이의 수평면 위에서 끈다 (발 높이로 두면 카메라가 낮을 때 시선이 평면에 닿지 않는다)
        const root = body.fig.mannequin.root;
        const plane = new THREE.Plane(UP, -body.point.y);
        const grab = body.point.clone().sub(root.position);
        this.drag = { kind: 'figure', fig: body.fig, start, plane, grab };
      } else {
        this.drag = { kind: 'none', start };
        return; // 카메라 조작에 맡긴다
      }
    }
    this.orbit.enabled = false;
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
    this.renderer.domElement.classList.add('dragging');
  }

  #move(e) {
    const d = this.drag;
    if (!d) {
      const handle = this.#gizmoAt(e) ? null : this.#handleAt(e);
      this.#hover(handle && this.selected.mannequin.handles[handle.index]);
      this.renderer.domElement.classList.toggle('over', !!(handle || this.#gizmoAt(e)));
      return;
    }
    if (d.kind === 'none') return;
    if (!d.moved && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < 4) return;
    d.moved = true;
    this.updateShadows();
    const hit = this.#aim(e).ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!hit) return;
    if (d.kind === 'figure') {
      const root = d.fig.mannequin.root;
      root.position.x = hit.x - d.grab.x;
      root.position.z = hit.z - d.grab.z;
      this.onFigureDrag?.(d.fig, 'move');
    } else if (d.kind === 'lift') {
      d.fig.mannequin.root.position.y = d.root0 + hit.y - d.y0;
      this.onFigureDrag?.(d.fig, 'move');
    } else if (d.kind === 'rotate') {
      const root = d.fig.mannequin.root;
      const angle = Math.atan2(hit.x - root.position.x, hit.z - root.position.z);
      root.rotation.y = d.yaw + angle - d.angle;
      this.onFigureRotate?.(d.fig, R2D(root.rotation.y), 'move');
    } else if (d.kind === 'light') {
      const dir = hit.sub(this.stage.center);
      const r = this.stage.reach, len = dir.length();
      if (len < r) dir.addScaledVector(d.toCam, d.side * Math.sqrt(r * r - len * len));
      if (dir.lengthSq() < 1e-6) return;
      this.lights[d.key].dir.copy(dir.normalize());
      this.#placeLights();
      this.onLightDrag?.(d.key, 'move');
    } else {
      this.onJointDrag?.(d.fig, d.index, hit, 'move');
    }
  }

  #up(e) {
    const d = this.drag;
    this.drag = null;
    this.orbit.enabled = true;
    this.renderer.domElement.classList.remove('dragging');
    if (!d) return;
    if (d.moved) {
      if (d.kind === 'figure' || d.kind === 'lift') this.onFigureDrag?.(d.fig, 'end');
      else if (d.kind === 'rotate') this.onFigureRotate?.(d.fig, R2D(d.fig.mannequin.root.rotation.y), 'end');
      else if (d.kind === 'light') this.onLightDrag?.(d.key, 'end');
      else if (d.kind === 'joint') this.onJointDrag?.(d.fig, d.index, this.#aim(e).ray.intersectPlane(d.plane, new THREE.Vector3()) ?? d.point, 'end');
      if (d.kind === 'figure' && d.fig !== this.selected) this.onSelect(d.fig);
      return;
    }
    // 광원을 끌지 않고 누르면 켜고 끈다
    if (d.kind === 'light') {
      const on = !this.lights[d.key].light.visible;
      this.setLight(d.key, on);
      this.onLightToggle?.(d.key, on);
      return;
    }
    // 끌지 않고 눌렀으면 선택: 인형이면 그 인물, 빈 곳이면 선택 해제
    if (d.kind === 'none' && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) > 4) return;
    if (d.kind === 'figure' || d.kind === 'none') this.onSelect(d.kind === 'figure' ? d.fig : null);
  }

  #render() {
    this.orbit.update();
    const head = new THREE.Vector3();
    for (const f of this.figures) {
      f.mannequin.bones.Head.getWorldPosition(head);
      f.label.position.copy(head).add(new THREE.Vector3(0, 0.3 * f.mannequin.root.scale.y, 0));
    }
    // 비출 인물이 없으면 광원 손잡이도 숨긴다
    for (const l of Object.values(this.lights)) l.handle.visible = l.line.visible = this.figures.length > 0;
    const sel = this.selected?.mannequin.root;
    this.ring.visible = this.lift.visible = !!sel;
    if (sel) {
      // 그림 속 높이대로 떠 있는 인물도 있으니 바닥이 아니라 그 인형의 발 높이에 둔다
      this.ring.position.set(sel.position.x, this.selected.mannequin.bounds(this.ringBox).min.y + 0.005, sel.position.z);
      this.ring.scale.setScalar(sel.scale.x);
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize();
      this.lift.position.copy(this.ring.position).addScaledVector(right, 0.42 * sel.scale.x + 0.1).add(new THREE.Vector3(0, 0.07, 0));
    }
    this.renderer.render(this.scene, this.camera);
  }

  setFigures(figures) {
    for (const f of this.figures) this.scene.remove(f.mannequin.root, f.label);
    this.figures = figures;
    for (const f of figures) {
      f.label ??= makeLabel();
      this.scene.add(f.mannequin.root, f.label);
    }
  }

  updateLabel(fig, text, color) {
    drawLabel(fig.label, text, color);
  }

  // 조명 손잡이를 인물들 가운데에서 본 방향에 둔다
  #placeLights() {
    const { center, radius, reach } = this.stage;
    for (const l of Object.values(this.lights)) {
      l.handle.position.copy(center).addScaledVector(l.dir, reach);
      l.light.position.copy(center).addScaledVector(l.dir, radius);
      l.light.target.position.copy(center);
      l.line.geometry.setFromPoints([l.handle.position, center]);
      l.line.computeLineDistances();
    }
    const cam = this.lights.key.light.shadow.camera;
    const r = radius * 1.2;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: radius * 3 });
    cam.updateProjectionMatrix();
    this.updateShadows();
  }

  // 꺼진 광원은 빛을 내지 않고, 손잡이만 흐리게 남겨서 다시 켜거나 옮길 수 있게 한다
  setLight(key, on) {
    const l = this.lights[key];
    l.light.visible = on;
    l.handle.material.opacity = on ? 1 : 0.3;
    l.line.material.opacity = on ? 0.5 : 0.15;
    this.updateShadows();
  }

  updateShadows() {
    this.renderer.shadowMap.needsUpdate = true;
  }

  // 인물을 다시 배치한 뒤 부른다: 조명이 모든 인물 가운데를 비추고, 그림자가 모두를 덮게 한다
  setStage() {
    const box = new THREE.Box3(), part = new THREE.Box3();
    for (const f of this.figures) box.union(f.mannequin.bounds(part));
    if (!box.isEmpty()) {
      box.getCenter(this.stage.center);
      const size = box.getSize(new THREE.Vector3());
      this.stage.radius = Math.max(2.5, size.length() * 0.9);
      // 인물들을 맞춘 화면 안에 손잡이가 들어오도록 키에 맞춘다
      this.stage.reach = Math.max(0.5, size.y * 0.55);
    }
    this.#placeLights();
  }

  // 클튜 광원 설정에 옮길 방향 (방위: 정면(+Z)에서 오른쪽(+X)으로, 높이: 바닥에서 위로)
  lightInfo() {
    const out = {};
    for (const [key, l] of Object.entries(this.lights)) {
      out[key] = {
        azimuth_deg: +R2D(Math.atan2(l.dir.x, l.dir.z)).toFixed(1),
        elevation_deg: +R2D(Math.asin(THREE.MathUtils.clamp(l.dir.y, -1, 1))).toFixed(1),
        on: l.light.visible,
        direction: l.dir.toArray().map((n) => +n.toFixed(4)),
        intensity: l.light.intensity,
      };
    }
    return out;
  }

  // 마우스를 올린 관절 손잡이만 진하게
  #hover(handle) {
    if (this.hovered === handle) return;
    if (this.hovered) this.hovered.material.opacity = 0.7;
    if (handle) handle.material.opacity = 1;
    this.hovered = handle;
  }

  select(fig) {
    this.selected = fig ?? null;
    for (const f of this.figures) {
      f.mannequin.setSelected(f === fig);
      f.mannequin.showHandles(f === fig);
      // 번호표는 고른 인물만 또렷하게, 나머지는 옅게
      f.label.material.opacity = !fig || f === fig ? 0.9 : 0.4;
    }
  }

  // 보이지 않는 장면에 넣어 셰이더를 미리 컴파일한다 (이름표 스프라이트도 함께)
  async warmUp(object) {
    const scene = new THREE.Scene();
    scene.add(...this.scene.children.filter((o) => o.isLight).map((l) => l.clone()), object, makeLabel());
    await this.renderer.compileAsync(scene, this.camera);
  }

  // 모든 인물이 화면에 들어오도록 카메라를 정면에 둔다
  frameAll() {
    const box = new THREE.Box3(), part = new THREE.Box3();
    for (const f of this.figures) box.union(f.mannequin.bounds(part));
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = Math.max(size.y, size.x / this.camera.aspect) * 0.6 / Math.tan(vfov / 2);
    this.orbit.target.copy(center);
    this.camera.position.set(center.x, center.y, box.max.z + fit);
    this.orbit.update();
  }

  setFov(fov) {
    // 화각을 바꿔도 화면 속 크기가 비슷하게 유지되도록 거리를 함께 조절한다
    const t = (d) => Math.tan(THREE.MathUtils.degToRad(d) / 2);
    const offset = this.camera.position.clone().sub(this.orbit.target);
    offset.multiplyScalar(t(this.camera.fov) / t(fov));
    this.camera.position.copy(this.orbit.target).add(offset);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  // 현재 시점 그대로 PNG로 만든다. 선택 표시, 이름표, 신뢰도 마커는 빼고 그린다.
  capture(scale = 2) {
    const hidden = [this.ring, this.lift, ...Object.values(this.lights).flatMap((l) => [l.handle, l.line]),
      ...this.figures.flatMap((f) => [f.label, ...Object.values(f.mannequin.markers), ...Object.values(f.mannequin.handles)])];
    const was = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    for (const f of this.figures) f.mannequin.setSelected(false);
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(ratio * scale);
    this.#resize();
    this.renderer.render(this.scene, this.camera);
    const promise = new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    this.renderer.setPixelRatio(ratio);
    this.#resize();
    hidden.forEach((o, i) => (o.visible = was[i]));
    this.select(this.selected);
    return promise;
  }

  // 클튜에서 카메라를 맞출 때 참고할 수치 (cm, 도)
  cameraInfo() {
    const cam = this.camera;
    const cm = (v) => v.toArray().map((n) => +(n * 100).toFixed(1));
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
    const vfov = cam.fov;
    const hfov = R2D(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(vfov) / 2) * cam.aspect));
    return {
      position_cm: cm(cam.position),
      target_cm: cm(this.orbit.target),
      distance_cm: +(cam.position.distanceTo(this.orbit.target) * 100).toFixed(1),
      rotation_deg: { yaw: +R2D(e.y).toFixed(2), pitch: +R2D(e.x).toFixed(2), roll: +R2D(e.z).toFixed(2) },
      vertical_fov_deg: +vfov.toFixed(2),
      horizontal_fov_deg: +hfov.toFixed(2),
      focal_length_35mm: +(18 / Math.tan(THREE.MathUtils.degToRad(hfov) / 2)).toFixed(1),
      aspect: +cam.aspect.toFixed(4),
    };
  }
}
