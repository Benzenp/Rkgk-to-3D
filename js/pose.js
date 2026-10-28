import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

// 인식 엔진과 기본 모델은 앱과 함께 배포한다. 정밀 모델(30MB)만 고를 때 Google 저장소에서 받는다.
const BASE = import.meta.env.BASE_URL;
export const MODELS = {
  full: `${BASE}models/pose_landmarker_full.task`,
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

async function wasmFileset() {
  const name = (await FilesetResolver.isSimdSupported()) ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
  return { wasmLoaderPath: `${BASE}mediapipe/${name}.js`, wasmBinaryPath: `${BASE}mediapipe/${name}.wasm` };
}

const cache = {};

function getLandmarker(model) {
  cache[model] ??= (async () => {
    const fileset = await wasmFileset();
    // 스케치는 사진보다 인식 점수가 낮게 나오므로 검출 기준을 느슨하게 둔다
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODELS[model], delegate },
      runningMode: 'IMAGE',
      numPoses: 1,
      minPoseDetectionConfidence: 0.1,
      minPosePresenceConfidence: 0.1,
    });
    try {
      return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      return PoseLandmarker.createFromOptions(fileset, options('CPU'));
    }
  })();
  return cache[model];
}

// 첫 획을 긋기 전에 모델을 미리 받아 둔다
export function preload(model) {
  return getLandmarker(model);
}

// canvas에서 한 사람의 관절을 찾는다. 못 찾으면 null
export async function detectPose(canvas, model) {
  const landmarker = await getLandmarker(model);
  const r = landmarker.detect(canvas);
  if (!r.landmarks.length) return null;
  return { image: r.landmarks[0], world: r.worldLandmarks[0] };
}
