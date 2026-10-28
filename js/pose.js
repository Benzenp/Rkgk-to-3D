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

// 실제로 인식을 돌리는 장치. CPU는 러프한 스케치를 GPU보다 훨씬 못 잡는다.
export let device = null;

// 모델 파일은 한 번만 받아 메모리에 둔다. 다운로드가 한 번 끊겼다고 GPU를 포기하지 않도록, 받는 일과 장치 고르는 일을 나눈다.
async function fetchModel(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (i >= tries) throw new Error(`인식 모델을 받지 못했어요 (${err.message})`);
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

function getLandmarker(model) {
  if (cache[model]) return cache[model];
  cache[model] = (async () => {
    const [fileset, bytes] = await Promise.all([wasmFileset(), fetchModel(MODELS[model])]);
    // 스케치는 사진보다 인식 점수가 낮게 나오므로 검출 기준을 느슨하게 둔다
    const options = (delegate) => ({
      baseOptions: { modelAssetBuffer: bytes.slice(), delegate },
      runningMode: 'IMAGE',
      numPoses: 1,
      minPoseDetectionConfidence: 0.1,
      minPosePresenceConfidence: 0.1,
    });
    // 모델은 이미 받았으니, 여기서 실패하면 정말로 이 기기에서 GPU를 쓸 수 없는 것이다
    try {
      const landmarker = await PoseLandmarker.createFromOptions(fileset, options('GPU'));
      device = 'GPU';
      return landmarker;
    } catch (err) {
      console.warn('GPU 인식을 쓸 수 없어 CPU로 돌립니다', err);
      const landmarker = await PoseLandmarker.createFromOptions(fileset, options('CPU'));
      device = 'CPU';
      return landmarker;
    }
  })();
  // 실패한 시도는 기억하지 않아서, 다음 획에서 다시 받아 본다
  cache[model].catch(() => delete cache[model]);
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
