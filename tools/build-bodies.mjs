// 원본 캐릭터 모델을 웹용 마네킹 GLB로 바꾼다.
//   node tools/build-bodies.mjs <Quaternius "Godot - UE" 폴더> <VRoid 샘플 폴더>
// 텍스처·모프·옷·머리카락을 빼고, 뼈 이름을 js/mannequin.js의 뼈 이름으로 통일한다.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const OUT = path.resolve(import.meta.dirname, '../public/assets/bodies');

const SIDES = [['l', 'left', 'Left'], ['r', 'right', 'Right']];

// Quaternius Universal Base Characters (언리얼식 이름)
const UE_BONES = {
  pelvis: 'Hips', spine_01: 'Spine', spine_02: 'Spine1', spine_03: 'Spine2', neck_01: 'Neck', Head: 'Head',
};
for (const [s, , S] of SIDES) {
  Object.assign(UE_BONES, {
    [`clavicle_${s}`]: `${S}Shoulder`, [`upperarm_${s}`]: `${S}Arm`, [`lowerarm_${s}`]: `${S}ForeArm`, [`hand_${s}`]: `${S}Hand`,
    [`thigh_${s}`]: `${S}UpLeg`, [`calf_${s}`]: `${S}Leg`, [`foot_${s}`]: `${S}Foot`, [`ball_${s}`]: `${S}ToeBase`,
  });
}

// VRM 0.x 휴머노이드 뼈
const VRM_BONES = { hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head' };
for (const [, s, S] of SIDES) {
  Object.assign(VRM_BONES, {
    [`${s}Shoulder`]: `${S}Shoulder`, [`${s}UpperArm`]: `${S}Arm`, [`${s}LowerArm`]: `${S}ForeArm`, [`${s}Hand`]: `${S}Hand`,
    [`${s}UpperLeg`]: `${S}UpLeg`, [`${s}LowerLeg`]: `${S}Leg`, [`${s}Foot`]: `${S}Foot`, [`${s}Toes`]: `${S}ToeBase`,
  });
}

function readGlb(file) {
  const b = fs.readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const bin = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
  return { json, bin };
}

function readGltf(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bin = fs.readFileSync(path.join(path.dirname(file), json.buffers[0].uri));
  delete json.buffers[0].uri;
  return { json, bin };
}

// 텍스처·확장·모프를 JSON 단계에서 걷어 낸다 (원본에 빠진 텍스처 파일이 있어도 읽히도록)
function strip(json, keepPrimitive) {
  for (const m of json.materials ?? []) {
    delete m.extensions;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
  }
  delete json.images;
  delete json.textures;
  delete json.samplers;
  delete json.extensions;
  delete json.extensionsUsed;
  delete json.extensionsRequired;
  for (const mesh of json.meshes) {
    mesh.primitives = mesh.primitives.filter((p) => keepPrimitive(json.materials?.[p.material]?.name ?? ''));
    for (const p of mesh.primitives) {
      delete p.targets;
      delete p.extensions;
    }
    delete mesh.weights;
    delete mesh.extras;
  }
}

function renameBones(json, mapping) {
  const used = new Set(Object.values(mapping));
  json.nodes.forEach((n, i) => {
    if (mapping[i]) n.name = mapping[i];
    else if (used.has(n.name)) n.name = `${n.name}_orig`;
  });
  const missing = [...used].filter((name) => !json.nodes.some((n) => n.name === name));
  if (missing.length) console.warn('  빠진 뼈:', missing.join(', '));
}

async function write(name, { json, bin }) {
  json.buffers = [{ byteLength: bin.length }];
  const io = new NodeIO();
  const doc = await io.readJSON({ json, resources: { '@glb.bin': bin } });
  for (const mesh of doc.getRoot().listMeshes()) if (!mesh.listPrimitives().length) mesh.dispose();
  await doc.transform(prune());
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, `${name}.glb`);
  fs.writeFileSync(out, await io.writeBinary(doc));
  console.log(`${name}.glb  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

async function quaternius(file, name) {
  const src = readGltf(file);
  const mapping = {};
  src.json.nodes.forEach((n, i) => UE_BONES[n.name] && (mapping[i] = UE_BONES[n.name]));
  renameBones(src.json, mapping);
  // 머리카락·눈썹 메쉬는 없고, 눈과 몸만 있다
  strip(src.json, () => true);
  await write(name, src);
}

async function vroid(file, name) {
  const src = readGlb(file);
  const mapping = {};
  for (const { bone, node } of src.json.extensions.VRM.humanoid.humanBones) if (VRM_BONES[bone]) mapping[node] = VRM_BONES[bone];
  // upperChest가 없는 모델은 chest를 Spine2로 쓴다
  if (!Object.values(mapping).includes('Spine2')) {
    const chest = Object.keys(mapping).find((k) => mapping[k] === 'Spine1');
    if (chest) mapping[chest] = 'Spine2';
  }
  renameBones(src.json, mapping);
  // 맨몸 마네킹: 피부와 흰자만 남기고 옷·머리카락·눈동자·속눈썹 같은 장식은 뺀다
  strip(src.json, (mat) => /_SKIN$|EyeWhite/.test(mat));
  await write(name, src);
}

const [ueDir, vroidDir] = process.argv.slice(2);
if (!ueDir || !vroidDir) {
  console.error('사용법: node tools/build-bodies.mjs <Quaternius "Godot - UE" 폴더> <VRoid 샘플 폴더>');
  process.exit(1);
}
await quaternius(path.join(ueDir, 'Superhero_Male_FullBody.gltf'), 'real-male');
await quaternius(path.join(ueDir, 'Superhero_Female_FullBody.gltf'), 'real-female');
await vroid(path.join(vroidDir, 'HairSample_Male.vrm'), 'anime-male');
await vroid(path.join(vroidDir, 'HairSample_Female.vrm'), 'anime-female');
