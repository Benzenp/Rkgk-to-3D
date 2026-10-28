import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { inkOn } from './color.js';

const R2D = THREE.MathUtils.radToDeg;

function makeLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace; // 인물 색이 칩·색 버튼과 같게 보이도록
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthTest: false }));
  sprite.scale.set(0.14, 0.14, 1);
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
  constructor(container, { onSelect, onFigureDrag, onJointDrag }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onFigureDrag = onFigureDrag;
    this.onJointDrag = onJointDrag;
    this.selected = null;
    this.drag = null;
    this.ray = new THREE.Raycaster();
    this.figures = [];
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf6f6f4);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x888899, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
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

  #figureAt(e) {
    const hit = this.#aim(e).intersectObjects(this.figures.flatMap((f) => f.mannequin.meshes), false)[0];
    return hit ? { fig: this.figures.find((f) => f.mannequin.meshes.includes(hit.object)), point: hit.point } : null;
  }

  #down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 오른쪽 드래그는 카메라 이동
    const start = [e.clientX, e.clientY];
    const handle = this.#handleAt(e);
    if (handle) {
      // 관절은 카메라를 향한 평면 위에서 끈다
      const normal = this.camera.getWorldDirection(new THREE.Vector3());
      this.drag = { kind: 'joint', ...handle, start, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, handle.point) };
    } else {
      const body = this.#figureAt(e);
      if (body) {
        // 인형은 잡은 높이의 수평면 위에서 끈다 (발 높이로 두면 카메라가 낮을 때 시선이 평면에 닿지 않는다)
        const root = body.fig.mannequin.root;
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -body.point.y);
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
      this.renderer.domElement.classList.toggle('over', !!this.#handleAt(e));
      return;
    }
    if (d.kind === 'none') return;
    if (!d.moved && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < 4) return;
    d.moved = true;
    const hit = this.#aim(e).ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!hit) return;
    if (d.kind === 'figure') {
      const root = d.fig.mannequin.root;
      root.position.x = hit.x - d.grab.x;
      root.position.z = hit.z - d.grab.z;
      this.onFigureDrag?.(d.fig, 'move');
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
      if (d.kind === 'figure') this.onFigureDrag?.(d.fig, 'end');
      else if (d.kind === 'joint') this.onJointDrag?.(d.fig, d.index, this.#aim(e).ray.intersectPlane(d.plane, new THREE.Vector3()) ?? d.point, 'end');
      if (d.kind === 'figure' && d.fig !== this.selected) this.onSelect(d.fig);
      return;
    }
    // 끌지 않고 눌렀으면 선택: 인형이면 그 인물, 빈 곳이면 선택 해제
    if (d.kind === 'none' && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) > 4) return;
    if (d.kind !== 'joint') this.onSelect(d.kind === 'figure' ? d.fig : null);
  }

  #render() {
    this.orbit.update();
    const head = new THREE.Vector3();
    for (const f of this.figures) {
      f.mannequin.bones.Head.getWorldPosition(head);
      f.label.position.copy(head).add(new THREE.Vector3(0, 0.3 * f.mannequin.root.scale.y, 0));
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

  select(fig) {
    this.selected = fig ?? null;
    for (const f of this.figures) {
      f.mannequin.setSelected(f === fig);
      f.mannequin.showHandles(f === fig);
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
    const hidden = this.figures.flatMap((f) => [f.label, ...Object.values(f.mannequin.markers), ...Object.values(f.mannequin.handles)]);
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
