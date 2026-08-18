// Service worker: кэширует и статику сайта, и ответы backend-API, чтобы дашборд
// открывался быстро и работал офлайн с последними загруженными данными.
//
// Два разных подхода для двух разных источников задержек:
// - STATIC (свой домен, Vercel) — "network first, cache fallback": Vercel и так быстрый,
//   тут важнее не отстать от свежего деплоя, чем выиграть миллисекунды.
// - API (backend на Render, чужой домен) — "stale while revalidate": именно тут бывают
//   реальные задержки (Render на бесплатном тарифе засыпает и просыпается по 10-30 секунд).
//   Поэтому и офлайн, и онлайн сразу отдаём то, что уже есть в кэше (без ожидания сети),
//   а актуальные данные параллельно подгружаются в фоне и тихо ложатся в кэш — следующий
//   запрос (обновление страницы, повторное открытие раздела) получит уже свежую версию.
const STATIC_CACHE = 'kaspi-static-v2';
const API_CACHE = 'kaspi-api-v2';

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

async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Не ждём сеть — сразу отдаём то, что уже есть. Фоновый фетч (см. waitUntil) успеет
    // обновить кэш, даже если respondWith уже вернул ответ и страница получила данные.
    event.waitUntil(networkFetch);
    return cached;
  }

  // Кэша ещё нет (первое обращение к этому запросу) — отдать нечего, приходится ждать сеть.
  const response = await networkFetch;
  if (response) return response;
  throw new Error('Нет сети и нет кэша для этого запроса');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Мутации (создание/изменение/удаление) никогда не кэшируем и не подменяем офлайн-ответом —
  // если сети нет, такой запрос должен честно упасть с ошибкой, а не притвориться успешным.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isOwnOrigin = url.origin === self.location.origin;

  if (isOwnOrigin) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
  } else {
    event.respondWith(staleWhileRevalidate(event, request, API_CACHE));
  }
});
