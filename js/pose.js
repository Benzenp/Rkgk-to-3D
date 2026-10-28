import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
export const MODELS = {
  full: `${MODEL_BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  heavy: `${MODEL_BASE}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
};

const cache = {};

function getLandmarker(model) {
  cache[model] ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
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

// canvas에서 한 사람의 관절을 찾는다. 못 찾으면 null
export async function detectPose(canvas, model) {
  const landmarker = await getLandmarker(model);
  const r = landmarker.detect(canvas);
  if (!r.landmarks.length) return null;
  return { image: r.landmarks[0], world: r.worldLandmarks[0] };
}
