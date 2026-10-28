import * as THREE from 'three';

// Mixamo식 뼈대. [이름, 부모, 부모 기준 휴지(T) 자세 오프셋(m)]
// 인형은 +z를 바라보고 +y가 위, +x가 인형의 왼쪽이다. 휴지 자세에서는 모든 회전이 0이다.
export const BONE_DEFS = [
  ['Hips', null, [0, 1.0, 0]],
  ['Spine', 'Hips', [0, 0.10, 0]],
  ['Spine1', 'Spine', [0, 0.12, 0]],
  ['Spine2', 'Spine1', [0, 0.12, 0]],
  ['Neck', 'Spine2', [0, 0.14, 0]],
  ['Head', 'Neck', [0, 0.10, 0]],
  ['LeftShoulder', 'Spine2', [0.05, 0.10, 0]],
  ['LeftArm', 'LeftShoulder', [0.12, 0, 0]],
  ['LeftForeArm', 'LeftArm', [0.27, 0, 0]],
  ['LeftHand', 'LeftForeArm', [0.25, 0, 0]],
  ['RightShoulder', 'Spine2', [-0.05, 0.10, 0]],
  ['RightArm', 'RightShoulder', [-0.12, 0, 0]],
  ['RightForeArm', 'RightArm', [-0.27, 0, 0]],
  ['RightHand', 'RightForeArm', [-0.25, 0, 0]],
  ['LeftUpLeg', 'Hips', [0.09, -0.05, 0]],
  ['LeftLeg', 'LeftUpLeg', [0, -0.43, 0]],
  ['LeftFoot', 'LeftLeg', [0, -0.42, 0]],
  ['LeftToeBase', 'LeftFoot', [0, -0.06, 0.12]],
  ['RightUpLeg', 'Hips', [-0.09, -0.05, 0]],
  ['RightLeg', 'RightUpLeg', [0, -0.43, 0]],
  ['RightFoot', 'RightLeg', [0, -0.42, 0]],
  ['RightToeBase', 'RightFoot', [0, -0.06, 0.12]],
];

// 말단 뼈의 끝점 (BVH End Site)
export const END_SITES = {
  Head: [0, 0.18, 0],
  LeftHand: [0.08, 0, 0],
  RightHand: [-0.08, 0, 0],
  LeftToeBase: [0, 0, 0.06],
  RightToeBase: [0, 0, 0.06],
};

// MediaPipe Pose 관절 번호
export const LM = {
  nose: 0, lEar: 7, rEar: 8,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28, lToe: 31, rToe: 32,
};

// 신뢰도를 표시할 주요 관절과, 표시 마커를 붙일 뼈
export const KEY_JOINTS = [
  [0, 'Head', '머리'],
  [11, 'LeftArm', '왼어깨'], [12, 'RightArm', '오른어깨'],
  [13, 'LeftForeArm', '왼팔꿈치'], [14, 'RightForeArm', '오른팔꿈치'],
  [15, 'LeftHand', '왼손목'], [16, 'RightHand', '오른손목'],
  [23, 'LeftUpLeg', '왼골반'], [24, 'RightUpLeg', '오른골반'],
  [25, 'LeftLeg', '왼무릎'], [26, 'RightLeg', '오른무릎'],
  [27, 'LeftFoot', '왼발목'], [28, 'RightFoot', '오른발목'],
];

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const FOOT_DIR = new THREE.Vector3(0, -0.06, 0.18).normalize();

// a를 주축, b를 보조축으로 하는 정규직교 기저
function frame(a, b) {
  const x = a.clone().normalize();
  let y = b.clone().addScaledVector(x, -b.dot(x));
  if (y.lengthSq() < 1e-8) {
    y = Math.abs(x.y) < 0.9 ? Y.clone() : Z.clone();
    y.addScaledVector(x, -y.dot(x));
  }
  y.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

// 휴지 자세 축 (restA, restB)를 목표 축 (tA, tB)로 보내는 회전
function align(restA, restB, tA, tB) {
  const m = frame(tA, tB).multiply(frame(restA, restB).transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// 부모 회전을 유지한 채 뼈 방향만 목표로 꺾는다 (비틀림 없음)
function swing(parentW, restA, target) {
  const cur = restA.clone().applyQuaternion(parentW).normalize();
  return new THREE.Quaternion().setFromUnitVectors(cur, target.clone().normalize()).multiply(parentW);
}

// 팔다리 윗마디: 관절이 굽는 방향(restB)이 실제 굽은 방향을 향하도록 비틀림까지 정한다
function limb(parentW, restA, restB, j0, j1, j2) {
  const tA = j1.clone().sub(j0);
  const d = j2.clone().sub(j1).normalize();
  const n = tA.clone().normalize();
  const perp = d.addScaledVector(n, -d.dot(n));
  const tB = perp.length() > 0.2 ? perp : restB.clone().applyQuaternion(parentW);
  return align(restA, restB, tA, tB);
}

export class Mannequin {
  constructor(color) {
    this.root = new THREE.Group();
    this.bones = {};
    for (const [name, parent, off] of BONE_DEFS) {
      const b = new THREE.Object3D();
      b.name = name;
      b.position.fromArray(off);
      (parent ? this.bones[parent] : this.root).add(b);
      this.bones[name] = b;
    }
    const base = new THREE.Color(color);
    const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0 });
    // 왼쪽은 밝게, 오른쪽은 어둡게 칠해서 방향 반전을 눈으로 확인할 수 있게 한다
    this.mats = {
      c: mat(base),
      l: mat(base.clone().offsetHSL(0, 0, 0.15)),
      r: mat(base.clone().offsetHSL(0, 0, -0.18)),
    };
    this.meshes = [];
    this.#buildBody();
    this.markers = {};
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, depthTest: false, transparent: true, opacity: 0.85 });
    for (const [, bone] of KEY_JOINTS) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), markerMat);
      m.renderOrder = 10;
      m.visible = false;
      if (bone === 'Head') m.position.set(0, 0.1, 0);
      this.bones[bone].add(m);
      this.markers[bone] = m;
    }
  }

  #seg(bone, from, to, r, side) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), this.mats[side]);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(Y, b.clone().sub(a).normalize());
    this.bones[bone].add(m);
    this.meshes.push(m);
  }

  #buildBody() {
    const s = this.#seg.bind(this);
    s('Hips', [-0.09, -0.03, 0], [0.09, -0.03, 0], 0.095, 'c');
    s('Hips', [0, 0, 0], [0, 0.1, 0], 0.1, 'c');
    s('Spine', [0, 0, 0], [0, 0.12, 0], 0.105, 'c');
    s('Spine1', [0, 0, 0], [0, 0.12, 0], 0.115, 'c');
    s('Spine2', [-0.1, 0.07, 0], [0.1, 0.07, 0], 0.1, 'c');
    s('Neck', [0, 0, 0], [0, 0.1, 0], 0.045, 'c');
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.mats.c);
    head.scale.set(0.09, 0.115, 0.1);
    head.position.set(0, 0.1, 0.01);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 10), this.mats.c);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.09, 0.12);
    this.bones.Head.add(head, nose);
    this.meshes.push(head, nose);
    for (const [S, sx, side] of [['Left', 1, 'l'], ['Right', -1, 'r']]) {
      s(S + 'Shoulder', [0, 0, 0], [0.12 * sx, 0, 0], 0.045, side);
      s(S + 'Arm', [0, 0, 0], [0.27 * sx, 0, 0], 0.05, side);
      s(S + 'ForeArm', [0, 0, 0], [0.25 * sx, 0, 0], 0.04, side);
      s(S + 'Hand', [0, 0, 0], [0.08 * sx, 0, 0], 0.032, side);
      s(S + 'UpLeg', [0, 0, 0], [0, -0.43, 0], 0.07, side);
      s(S + 'Leg', [0, 0, 0], [0, -0.42, 0], 0.055, side);
      s(S + 'Foot', [0, 0, 0], [0, -0.06, 0.12], 0.045, side);
      s(S + 'ToeBase', [0, 0, 0], [0, 0, 0.06], 0.035, side);
    }
  }

  setSelected(on) {
    for (const m of Object.values(this.mats)) m.emissive.setHex(on ? 0x333333 : 0x000000);
  }

  // 인식 실패 시 쓰는 기본 자세 (팔을 내린 A자세)
  setDefaultPose() {
    for (const b of Object.values(this.bones)) b.quaternion.identity();
    this.bones.LeftArm.rotation.z = -1.2;
    this.bones.RightArm.rotation.z = 1.2;
  }

  // lm: 인물 공간 좌표(m, 엉덩이 중심, three.js 축)의 MediaPipe 관절 33개
  applyLandmarks(lm) {
    const sub = (a, b) => lm[a].clone().sub(lm[b]);
    const mid = (a, b) => lm[a].clone().add(lm[b]).multiplyScalar(0.5);
    const W = {};
    const up = mid(LM.lShoulder, LM.rShoulder).sub(mid(LM.lHip, LM.rHip));
    W.Hips = align(X, Y, sub(LM.lHip, LM.rHip), up);
    W.Spine2 = align(X, Y, sub(LM.lShoulder, LM.rShoulder), up);
    W.Spine = W.Hips.clone().slerp(W.Spine2, 1 / 3);
    W.Spine1 = W.Hips.clone().slerp(W.Spine2, 2 / 3);
    W.Head = align(X, Y, sub(LM.lEar, LM.rEar), mid(LM.lEar, LM.rEar).sub(mid(LM.lShoulder, LM.rShoulder)));
    W.Neck = W.Spine2.clone().slerp(W.Head, 0.5);
    for (const [S, sx, sh, el, wr, pk, ix, hp, kn, an, toe] of [
      ['Left', 1, 11, 13, 15, 17, 19, 23, 25, 27, 31],
      ['Right', -1, 12, 14, 16, 18, 20, 24, 26, 28, 32],
    ]) {
      const a = new THREE.Vector3(sx, 0, 0);
      W[S + 'Shoulder'] = W.Spine2.clone();
      W[S + 'Arm'] = limb(W.Spine2, a, Z, lm[sh], lm[el], lm[wr]);
      W[S + 'ForeArm'] = swing(W[S + 'Arm'], a, sub(wr, el));
      W[S + 'Hand'] = swing(W[S + 'ForeArm'], a, mid(pk, ix).sub(lm[wr]));
      const down = Y.clone().negate();
      W[S + 'UpLeg'] = limb(W.Hips, down, Z.clone().negate(), lm[hp], lm[kn], lm[an]);
      W[S + 'Leg'] = swing(W[S + 'UpLeg'], down, sub(an, kn));
      W[S + 'Foot'] = swing(W[S + 'Leg'], FOOT_DIR, sub(toe, an));
      W[S + 'ToeBase'] = W[S + 'Foot'].clone();
    }
    for (const [name, parent] of BONE_DEFS) {
      const local = parent ? W[parent].clone().invert().multiply(W[name]) : W[name];
      this.bones[name].quaternion.copy(local);
    }
  }

  setLowConfidence(boneNames) {
    for (const [bone, m] of Object.entries(this.markers)) m.visible = boneNames.includes(bone);
  }
}
