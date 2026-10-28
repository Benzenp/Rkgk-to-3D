// 보이는 인체 모델. 포즈는 mannequin.js의 뼈대가 계산하고, 모델은 그 회전을 그대로 따라 한다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BONE_DEFS } from './mannequin.js';

export const BODY_KINDS = ['anime-female', 'anime-male', 'real-female', 'real-male'];

// 휴지 자세의 뼈 방향을 우리 뼈대에 맞출 팔다리 뼈 (몸통·머리·쇄골은 모델 고유의 모양을 둔다)
const ALIGN = /^(Left|Right)(Arm|ForeArm|Hand|UpLeg|Leg|Foot)$/;
const OFFSET = Object.fromEntries(BONE_DEFS.map(([name, , off]) => [name, new THREE.Vector3(...off)]));
const CHILD = { Arm: 'ForeArm', ForeArm: 'Hand', UpLeg: 'Leg', Leg: 'Foot', Foot: 'ToeBase' };

const templates = {};

// 모델을 우리 인형 공간에 맞춘다: +z를 바라보고, 엉덩이 높이 1.0, 엉덩이가 원점 바로 위
function prepare(scene) {
  const wrap = new THREE.Group();
  wrap.add(scene);
  const bone = (n) => scene.getObjectByName(n);
  const pos = (n) => bone(n).getWorldPosition(new THREE.Vector3());
  wrap.updateMatrixWorld(true);
  if (pos('LeftArm').x < pos('RightArm').x) wrap.rotation.y = Math.PI; // VRM 0.x는 -z를 바라본다
  wrap.updateMatrixWorld(true);
  wrap.scale.setScalar(1 / pos('Hips').y);
  wrap.updateMatrixWorld(true);
  const hips = pos('Hips');
  wrap.position.set(-hips.x, 0, -hips.z);
  wrap.updateMatrixWorld(true);

  // 휴지 자세의 월드 회전과, 팔다리 방향을 우리 휴지 자세로 돌리는 보정
  const rest = {};
  for (const [name] of BONE_DEFS) {
    const b = bone(name);
    if (!b) continue;
    const r0 = b.getWorldQuaternion(new THREE.Quaternion());
    let fix = new THREE.Quaternion();
    const child = CHILD[name.replace(/^(Left|Right)/, '')];
    const side = name.match(/^(Left|Right)/)?.[0];
    if (ALIGN.test(name) && bone(side + child)) {
      const dirModel = pos(side + child).sub(pos(name)).normalize();
      const dirOurs = OFFSET[side + child].clone().normalize();
      fix = new THREE.Quaternion().setFromUnitVectors(dirModel, dirOurs);
    }
    rest[name] = { r0, fix };
  }

  // 인형의 왼쪽(+x)을 조금 밝게, 오른쪽을 조금 어둡게 칠한다 (보정 버튼 안내와 맞춘다)
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isSkinnedMesh && !o.isMesh) return;
    const p = o.geometry.attributes.position;
    const colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      const c = 0.9 + 0.1 * THREE.MathUtils.clamp(v.x / 0.08, -1, 1);
      colors.set([c, c, c], i * 3);
    }
    o.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  });
  return { wrap, rest };
}

function loadTemplate(kind) {
  templates[kind] ??= new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}assets/bodies/${kind}.glb`).then((g) => prepare(g.scene));
  return templates[kind];
}

export async function createBody(kind, color) {
  const { wrap, rest } = await loadTemplate(kind);
  const root = cloneSkinned(wrap);
  // 회색 바탕에 인물 색을 살짝 섞는다
  const tint = new THREE.Color(0xd2d2d0).lerp(new THREE.Color(color), 0.18);
  const material = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.7, vertexColors: true });
  const meshes = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = material;
    o.frustumCulled = false;
    o.castShadow = true;
    meshes.push(o);
  });
  const bones = {};
  for (const [name] of BONE_DEFS) {
    const b = root.getObjectByName(name);
    if (b && rest[name]) bones[name] = b;
  }
  return { kind, root, meshes, material, bones, rest };
}

// 우리 뼈대(mannequin)의 회전을 모델 뼈에 옮긴다
export function applyBody(body, mannequin) {
  const figure = mannequin.root;
  figure.updateWorldMatrix(true, true);
  const figInv = figure.getWorldQuaternion(new THREE.Quaternion()).invert();
  const figQ = figure.getWorldQuaternion(new THREE.Quaternion());
  const parentQ = new THREE.Quaternion();
  for (const [name] of BONE_DEFS) {
    const b = body.bones[name];
    if (!b) continue;
    // 휴지 자세에서 지금 자세까지 우리 뼈가 돈 만큼 (인형 공간 기준)
    const w = figInv.clone().multiply(mannequin.bones[name].getWorldQuaternion(new THREE.Quaternion()));
    const { r0, fix } = body.rest[name];
    const target = figQ.clone().multiply(w).multiply(fix).multiply(r0);
    b.parent.updateWorldMatrix(true, false);
    b.parent.getWorldQuaternion(parentQ);
    b.quaternion.copy(parentQ.invert().multiply(target));
    b.updateMatrixWorld(true);
  }
}
