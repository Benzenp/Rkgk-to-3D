import * as THREE from 'three';
import { BONE_DEFS, END_SITES } from './mannequin.js';

// Mixamo FBX를 BVH로 바꿨을 때와 같은 뼈 이름을 쓴다
const PREFIX = 'mixamorig:';
const CM = 100;
const f = (v) => (Math.abs(v) < 1e-6 ? 0 : v).toFixed(4);

// 인물 하나를 1프레임 BVH로 만든다. 위치는 장면 공통 좌표(cm)라서 여러 인물을 불러와도 배치가 유지된다.
// 웹에서 바꾼 인물 크기는 BVH에 담을 수 없으므로 위치에만 반영된다.
export function toBVH(mannequin) {
  const children = {};
  for (const [name, parent] of BONE_DEFS) (children[parent] ??= []).push(name);
  const order = [];
  const lines = ['HIERARCHY'];
  const write = (name, depth) => {
    const pad = '\t'.repeat(depth);
    const def = BONE_DEFS.find((d) => d[0] === name);
    const isRoot = !def[1];
    order.push(name);
    lines.push(`${pad}${isRoot ? 'ROOT' : 'JOINT'} ${PREFIX}${name}`, `${pad}{`);
    const off = isRoot ? [0, 0, 0] : def[2];
    lines.push(`${pad}\tOFFSET ${off.map((v) => f(v * CM)).join(' ')}`);
    lines.push(
      isRoot
        ? `${pad}\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`
        : `${pad}\tCHANNELS 3 Zrotation Xrotation Yrotation`
    );
    for (const c of children[name] ?? []) write(c, depth + 1);
    if (END_SITES[name]) {
      lines.push(`${pad}\tEnd Site`, `${pad}\t{`, `${pad}\t\tOFFSET ${END_SITES[name].map((v) => f(v * CM)).join(' ')}`, `${pad}\t}`);
    }
    lines.push(`${pad}}`);
  };
  write('Hips', 0);

  mannequin.root.updateWorldMatrix(true, true);
  const values = [];
  const euler = new THREE.Euler();
  for (const name of order) {
    const bone = mannequin.bones[name];
    let q = bone.quaternion;
    if (name === 'Hips') {
      const p = bone.getWorldPosition(new THREE.Vector3()).multiplyScalar(CM);
      values.push(f(p.x), f(p.y), f(p.z));
      q = mannequin.root.getWorldQuaternion(new THREE.Quaternion()).multiply(bone.quaternion);
    }
    // BVH의 "Zrotation Xrotation Yrotation"은 three.js의 'ZXY' 순서와 같다 (R = Rz·Rx·Ry)
    euler.setFromQuaternion(q, 'ZXY');
    values.push(...[euler.z, euler.x, euler.y].map((r) => f(THREE.MathUtils.radToDeg(r))));
  }
  lines.push('MOTION', 'Frames: 1', 'Frame Time: 0.033333', values.join(' '));
  return lines.join('\n') + '\n';
}
