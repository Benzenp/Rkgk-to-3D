// 인식을 화면과 다른 스레드에서 돌려서, 인식하는 동안에도 그리기가 끊기지 않게 한다.
import { createRecognizer } from './recognizer.js';

let recognizer;
const cancelled = new Set();

self.onmessage = async ({ data: m }) => {
  if (m.type === 'init') {
    recognizer = createRecognizer(m.config);
  } else if (m.type === 'cancel') {
    cancelled.add(m.job);
  } else if (m.type === 'preload') {
    try {
      await recognizer.preload(m.model);
      self.postMessage({ type: 'ready', device: recognizer.device });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  } else if (m.type === 'run') {
    try {
      await recognizer.run(m.bitmap, m.model, (ev) => self.postMessage({ ...ev, job: m.job }), () => cancelled.has(m.job));
      self.postMessage({ type: 'done', job: m.job, device: recognizer.device });
    } catch (err) {
      self.postMessage({ type: 'error', job: m.job, message: err.message });
    } finally {
      cancelled.delete(m.job);
      m.bitmap.close();
    }
  }
};
