// Простой service worker — нужен, чтобы браузер считал сайт "полноценным PWA".
// Офлайн-кэширование сознательно не делаем: дашборд всегда должен показывать
// свежие данные, а не устаревшую кэшированную версию.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Просто пропускаем все запросы напрямую в сеть, ничего не кэшируем.
self.addEventListener('fetch', () => {});
