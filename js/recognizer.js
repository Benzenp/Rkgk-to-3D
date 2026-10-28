// 그린 레이어 한 장에서 사람 관절을 찾는다. 백그라운드 워커에서 돌고, 워커를 못 쓰면 화면 쪽에서 그대로 돈다.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { inkBounds, cropForDetection, silhouette, newCanvas } from './input.js';

// 전처리마다 따로 인식해 본다. 점수가 높다고 늘 맞는 해석은 아니라서, 화면에서 바꿔 볼 수 있게 모두 돌려준다.
const VARIANTS = [
  ['원본', (c) => c],
  ['실루엣', (c) => silhouette(c)],
  ['틈 메우기', (c) => silhouette(c, { close: 0.01 })],
  ['두껍게', (c) => silhouette(c, { thicken: 0.02 })],
];

// 점수에 쓰는 주요 관절 (머리, 어깨, 팔꿈치, 손목, 골반, 무릎, 발목)
const KEY = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const score = (lm) => KEY.reduce((a, i) => a + (lm[i].visibility ?? 1), 0) / KEY.length;

const pause = () => new Promise((r) => setTimeout(r, 0));

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

// config: { wasmBase, models: { full, heavy } } — 모두 절대 주소
export function createRecognizer(config) {
  const cache = {};
  let device = null;

  async function create(model) {
    const simd = await FilesetResolver.isSimdSupported();
    const name = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
    const fileset = { wasmLoaderPath: `${config.wasmBase}${name}.js`, wasmBinaryPath: `${config.wasmBase}${name}.wasm` };
    const bytes = await fetchModel(config.models[model]);
    // 스케치는 사진보다 인식 점수가 낮게 나오므로 검출 기준을 느슨하게 둔다
    const options = (delegate) => ({
      baseOptions: { modelAssetBuffer: bytes.slice(), delegate },
      // 워커에는 DOM이 없어서 GPU가 쓸 캔버스를 직접 준다
      ...(typeof document === 'undefined' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
      runningMode: 'IMAGE',
      numPoses: 1,
      minPoseDetectionConfidence: 0.1,
      minPosePresenceConfidence: 0.1,
    });
    let landmarker;
    // 모델은 이미 받았으니, 여기서 실패하면 정말로 이 기기에서 GPU를 쓸 수 없는 것이다 (CPU는 러프한 스케치를 훨씬 못 잡는다)
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, options('GPU'));
      device = 'GPU';
    } catch (err) {
      console.warn('GPU 인식을 쓸 수 없어 CPU로 돌립니다', err);
      landmarker = await PoseLandmarker.createFromOptions(fileset, options('CPU'));
      device = 'CPU';
    }
    // 첫 인식은 GPU 준비 때문에 오래 걸린다. 빈 그림으로 한 번 미리 돌려 둔다.
    const blank = newCanvas(64, 64);
    const g = blank.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 64, 64);
    landmarker.detect(blank);
    return landmarker;
  }

  function landmarker(model) {
    if (cache[model]) return cache[model];
    cache[model] = create(model);
    // 실패한 시도는 기억하지 않아서, 다음 획에서 다시 받아 본다
    cache[model].catch(() => delete cache[model]);
    return cache[model];
  }

  // bitmap: 레이어 한 장. emit으로 { type: 'box' } 한 번, 찾은 후보마다 { type: 'cand' }를 보낸다.
  async function run(bitmap, model, emit, cancelled) {
    const layer = newCanvas(bitmap.width, bitmap.height);
    layer.getContext('2d').drawImage(bitmap, 0, 0);
    const box = inkBounds(layer);
    emit({ type: 'box', box });
    if (!box) return;
    const crop = cropForDetection(layer, box);
    const lmk = await landmarker(model);
    for (const [label, make] of VARIANTS) {
      if (cancelled()) return;
      const r = lmk.detect(make(crop.canvas));
      if (r.landmarks.length) {
        const image = r.landmarks[0];
        emit({ type: 'cand', label, image, world: r.worldLandmarks[0], score: score(image), px: image.map((l) => crop.toSource(l.x, l.y)) });
      }
      // 사이사이 쉬어서, 새 획이 들어오면 취소 메시지를 받을 수 있게 한다
      await pause();
    }
  }

  return {
    run,
    preload: (model) => landmarker(model),
    get device() {
      return device;
    },
  };
}
