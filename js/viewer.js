import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const R2D = THREE.MathUtils.radToDeg;

function makeLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(0.6, 0.15, 1);
  sprite.renderOrder = 20;
  sprite.userData.canvas = canvas;
  return sprite;
}

function drawLabel(sprite, text, color) {
  const c = sprite.userData.canvas, ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(20,20,24,0.8)';
  ctx.beginPath();
  ctx.roundRect(2, 8, c.width - 4, c.height - 16, 20);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2, c.width - 24);
  sprite.material.map.needsUpdate = true;
}

export class Viewer {
  constructor(container, { onSelect, onMove }) {
    this.container = container;
    this.onSelect = onSelect;
    this.figures = [];
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f4f2);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x888899, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(20, 40, 0xb0b0b8, 0xd6d6dc);
    this.scene.add(this.grid);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
    this.camera.position.set(0, 1.2, 6);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.9, 0);
    this.orbit.enableDamping = true;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.size = 0.8;
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (!e.value) onMove?.();
    });
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);

    // 끌지 않고 클릭했을 때만 선택한다 (카메라 회전과 구분)
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || this.gizmo.dragging) return;
      this.#pick(e);
    });

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

  #pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.figures.flatMap((f) => f.mannequin.meshes), false);
    const fig = hits.length ? this.figures.find((f) => f.mannequin.meshes.includes(hits[0].object)) : null;
    this.onSelect(fig);
  }

  #render() {
    this.orbit.update();
    const head = new THREE.Vector3();
    for (const f of this.figures) {
      f.mannequin.bones.Head.getWorldPosition(head);
      f.label.position.copy(head).add(new THREE.Vector3(0, 0.38 * f.mannequin.root.scale.y, 0));
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
    for (const f of this.figures) f.mannequin.setSelected(f === fig);
    if (fig) this.gizmo.attach(fig.mannequin.root);
    else this.gizmo.detach();
  }

  // 모든 인물이 화면에 들어오도록 카메라를 정면에 둔다
  frameAll() {
    const box = new THREE.Box3();
    for (const f of this.figures) box.expandByObject(f.mannequin.root);
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
    const hidden = [this.gizmoHelper, ...this.figures.flatMap((f) => [f.label, ...Object.values(f.mannequin.markers)])];
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
    this.select(this.gizmo.object ? this.figures.find((f) => f.mannequin.root === this.gizmo.object) : null);
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
