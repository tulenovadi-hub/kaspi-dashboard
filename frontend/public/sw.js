// Service worker: кэширует и статику сайта, и ответы backend-API, чтобы дашборд
// открывался офлайн с последними загруженными данными (на телефоне это особенно
// заметно — сеть часто нестабильна). Стратегия — "network first, cache fallback":
// пока есть сеть, всегда показываем свежие данные и обновляем кэш; как только сети
// нет, отдаём последнюю сохранённую версию вместо ошибки/пустого экрана.
const STATIC_CACHE = 'kaspi-static-v1';
const API_CACHE = 'kaspi-api-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== API_CACHE).map((k) => caches.delete(k)))
      ),
      self.clients.claim(),
    ])
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Кэшируем только успешные ответы — ошибку сервера или чужого 404 запоминать не нужно.
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Мутации (создание/изменение/удаление) никогда не кэшируем и не подменяем офлайн-ответом —
  // если сети нет, такой запрос должен честно упасть с ошибкой, а не притвориться успешным.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isOwnOrigin = url.origin === self.location.origin;

  // Свой домен (HTML/JS/CSS/иконки, включая переход между страницами SPA) — STATIC_CACHE.
  // Чужой домен (backend API на Render) — API_CACHE, отдельно от статики.
  event.respondWith(networkFirst(request, isOwnOrigin ? STATIC_CACHE : API_CACHE));
});
