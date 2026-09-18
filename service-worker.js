const CACHE_NAME = 'lecture-feedback-v2'; // 版本號提升，強制淘汰舊快取
const SHELL_FILES = ['./index.html', './style.css', './manifest.json'];
// 注意：app.js 刻意不放進快取清單，永遠走網路抓最新版，避免程式更新後手機還在跑舊邏輯

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k))) // 啟用時清掉所有舊版快取，不管版本號
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // app.js 永遠優先用網路最新版；網路失敗才退回快取
  if (url.pathname.endsWith('app.js')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
