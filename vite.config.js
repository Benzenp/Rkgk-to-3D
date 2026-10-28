import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// MediaPipe의 wasm 파일은 패키지 exports로 가져올 수 없어서 public/mediapipe로 복사해 그대로 내보낸다
function copyMediapipeWasm() {
  return {
    name: 'copy-mediapipe-wasm',
    buildStart() {
      const src = 'node_modules/@mediapipe/tasks-vision/wasm';
      const dst = 'public/mediapipe';
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    },
  };
}

export default defineConfig({
  // 어느 경로(예: GitHub Pages의 /저장소이름/)에 올려도 동작하도록 상대 경로로 만든다
  base: './',
  // three.js와 MediaPipe가 한 덩어리라 큰 것이 정상이다
  build: { chunkSizeWarningLimit: 1000 },
  plugins: [
    copyMediapipeWasm(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/icon.svg'],
      manifest: {
        name: 'rkgk to 3D',
        short_name: 'rkgk',
        description: '졸라맨 스케치를 그리면 바로 3D 포즈 레퍼런스로',
        lang: 'ko',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: '#fbfbfa',
        background_color: '#fbfbfa',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 처음 방문할 때 앱, 글꼴, 인체 모델, 인식 엔진, 기본 인식 모델까지 받아 두어 오프라인에서도 그린다
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,glb,wasm,task}'],
        globIgnores: ['**/*nosimd*'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        runtimeCaching: [
          // SIMD를 못 쓰는 오래된 브라우저용 엔진
          { urlPattern: /nosimd/, handler: 'CacheFirst', options: { cacheName: 'mediapipe-nosimd' } },
          // 정밀(heavy) 인식 모델은 고를 때만 Google 저장소에서 받는다
          {
            urlPattern: /^https:\/\/storage\.googleapis\.com\/mediapipe-models\//,
            handler: 'CacheFirst',
            options: { cacheName: 'pose-models', cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
});
