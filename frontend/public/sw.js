// Service worker: кэш нужен ТОЛЬКО для офлайна. Пока есть сеть, всё (и статика, и API)
// всегда идёт живым запросом на сервер — то есть онлайн пользователь видит только реально
// свежие данные, ровно как без service worker'а. Кэш просто наполняется по пути и достаётся
// лишь тогда, когда сеть недоступна.
//
// Раньше API работал по "stale while revalidate" (мгновенно отдавал кэш даже онлайн, обновляя
// его в фоне) — от этого отказались: экран мгновенно показывал старые цифры без какого-либо
// видимого признака, что они старые, и это вводило в заблуждение. Попытки пометить такие
// данные (притемнение по возрасту ответа) проблему не решили, поэтому вернулись к простой и
// предсказуемой схеме: онлайн = только свежее (и обычный индикатор загрузки), офлайн = кэш.
const STATIC_CACHE = 'kaspi-static-v3';
const API_CACHE = 'kaspi-api-v3';

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

// cacheKey отдельно от request — нужно для POST-запроса картинок товаров (см. ниже),
// где в кэш кладём/ищем не по URL (он у всех таких запросов одинаковый), а по телу запроса.
async function networkFirst(request, cacheName, cacheKey = request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Кэшируем только успешные ответы — ошибку сервера или чужой 404 запоминать не нужно.
    if (response && response.ok) {
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw err;
  }
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
    event.respondWith(networkFirst(request, isOwnOrigin ? STATIC_CACHE : API_CACHE));
    return;
  }

  if (!isOwnOrigin && request.method === 'POST' && url.pathname === '/api/product-images') {
    event.respondWith(
      cacheKeyForProductImages(request).then((cacheKey) => networkFirst(request, API_CACHE, cacheKey))
    );
    return;
  }

  // Остальные мутации (создание/изменение/удаление) никогда не кэшируем и не подменяем
  // офлайн-ответом — если сети нет, такой запрос должен честно упасть с ошибкой.
});
