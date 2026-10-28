// 화면 쪽에서 쓰는 인식 창구. 배포 빌드에서는 워커로 보내고, 개발 서버나 워커를 못 쓰는 브라우저에서는 화면에서 직접 돌린다.

const abs = (p) => new URL(p, document.baseURI).href;
const CONFIG = {
  wasmBase: abs(`${import.meta.env.BASE_URL}mediapipe/`),
  models: {
    full: abs(`${import.meta.env.BASE_URL}models/pose_landmarker_full.task`),
    // 정밀 모델(30MB)은 고를 때만 Google 저장소에서 받는다
    heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
  },
};

function startWorker() {
  // MediaPipe는 일반(classic) 워커에서만 돈다. 개발 서버는 워커를 모듈로만 내보내서 화면에서 돌린다.
  if (import.meta.env.DEV || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const w = new Worker(new URL('./pose-worker.js', import.meta.url));
    w.postMessage({ type: 'init', config: CONFIG });
    return w;
  } catch {
    return null;
  }
}

export function createRecognition({ onReady, onError }) {
  const worker = startWorker();
  // 워커를 못 쓸 때만 인식 코드를 화면 쪽으로 불러온다
  let localRec = null;
  const local = worker ? null : import('./recognizer.js').then((m) => (localRec = m.createRecognizer(CONFIG)));
  const jobs = new Map();
  let nextJob = 1;
  let device = null;

  if (worker) {
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'ready') {
        device = m.device;
        onReady?.(device);
        return;
      }
      const job = jobs.get(m.job);
      if (m.type === 'error' && !job) return onError?.(new Error(m.message));
      if (!job) return;
      if (m.device) device = m.device;
      if (m.type === 'box' || m.type === 'cand') job.emit(m);
      else if (m.type === 'done') (jobs.delete(m.job), job.resolve());
      else if (m.type === 'error') (jobs.delete(m.job), job.reject(new Error(m.message)));
    };
  }

  return {
    get device() {
      return device ?? localRec?.device ?? null;
    },
    preload(model) {
      if (worker) return worker.postMessage({ type: 'preload', model });
      local.then((rec) => rec.preload(model)).then(() => onReady?.(localRec.device), (err) => onError?.(err));
    },
    // 레이어 한 장을 인식한다. { promise, cancel } — 새 획이 들어오면 cancel로 남은 후보 계산을 버린다.
    run(bitmap, model, emit) {
      const id = nextJob++;
      let cancelled = false;
      const promise = new Promise((resolve, reject) => {
        if (worker) {
          jobs.set(id, { emit, resolve, reject });
          worker.postMessage({ type: 'run', job: id, bitmap, model }, [bitmap]);
        } else {
          local.then((rec) => rec.run(bitmap, model, emit, () => cancelled)).then(resolve, reject).finally(() => bitmap.close());
        }
      });
      const cancel = () => {
        cancelled = true;
        worker?.postMessage({ type: 'cancel', job: id });
      };
      return { promise, cancel };
    },
  };
}
