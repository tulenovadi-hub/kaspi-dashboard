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

// Уведомляем открытые страницы, что фоновое обновление принесло ДРУГИЕ данные (не просто
// "запрос прошёл", а именно "тело ответа реально изменилось") — по этому сигналу страница
// может сама перечитать (уже свежий) кэш и обновить экран, пока пользователь смотрит.
// pathname, а не полный URL с query — чтобы страница могла подписаться на "/api/batches"
// целиком, не завязываясь на конкретные даты/фильтры в строке запроса.
async function notifyClients(pathname) {
  const clientsList = await self.clients.matchAll({ type: 'window' });
  for (const client of clientsList) {
    client.postMessage({ type: 'kaspi-data-updated', pathname });
  }
}

// cacheKey отдельно от request — нужно для POST-запроса картинок товаров (см. ниже),
// где в кэш кладём/ищем не по URL (он у всех таких запросов одинаковый), а по телу запроса.
async function staleWhileRevalidate(event, request, cacheName, cacheKey = request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(cacheKey);

  const networkFetch = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        // Сравниваем с уже закэшированным, ДО того как перезаписать его — если это первый
        // заход (cached нет) или тело не поменялось, никого дёргать не нужно.
        if (cached) {
          const [oldText, newText] = await Promise.all([cached.clone().text(), response.clone().text()]);
          if (oldText !== newText) {
            notifyClients(new URL(request.url).pathname);
          }
        }
        cache.put(cacheKey, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Не ждём сеть — сразу отдаём то, что уже есть. Фоновый фетч (см. waitUntil) успеет
    // обновить кэш (и уведомить страницу, если данные реально другие), даже если respondWith
    // уже вернул ответ и страница получила данные.
    event.waitUntil(networkFetch);
    return cached;
  }

  // Кэша ещё нет (первое обращение к этому запросу) — отдать нечего, приходится ждать сеть.
  const response = await networkFetch;
  if (response) return response;
  throw new Error('Нет сети и нет кэша для этого запроса');
}

// Единственное исключение из правила "кэшируем только GET": картинки товаров запрашиваются
// через POST со списком product_id в теле (список бывает длинным, в GET-строку не убрать).
// По сути это чтение, а не мутация, поэтому его тоже стоит кэшировать — иначе на "Складе"/
// "Закупе" офлайн вместо фото остаются пустые плашки. Кэшировать по одному URL нельзя (он
// один и тот же для любого списка id) — собираем синтетический ключ из отсортированных id,
// чтобы разные страницы с разным набором товаров не подменяли друг другу картинки.
async function cacheKeyForProductImages(request) {
  let ids = [];
  try {
    const body = await request.clone().json();
    if (Array.isArray(body.product_ids)) ids = body.product_ids.slice().sort();
  } catch (err) {
    // тело не распарсилось — используем пустой ключ, лучше промах кэша, чем чужие картинки
  }
  return new Request(`${request.url}?ids=${encodeURIComponent(ids.join(','))}`);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const isOwnOrigin = url.origin === self.location.origin;

  if (request.method === 'GET') {
    event.respondWith(isOwnOrigin ? networkFirst(request, STATIC_CACHE) : staleWhileRevalidate(event, request, API_CACHE));
    return;
  }

  if (!isOwnOrigin && request.method === 'POST' && url.pathname === '/api/product-images') {
    event.respondWith(
      cacheKeyForProductImages(request).then((cacheKey) => staleWhileRevalidate(event, request, API_CACHE, cacheKey))
    );
    return;
  }

  // Остальные мутации (создание/изменение/удаление) никогда не кэшируем и не подменяем
  // офлайн-ответом — если сети нет, такой запрос должен честно упасть с ошибкой.
});
