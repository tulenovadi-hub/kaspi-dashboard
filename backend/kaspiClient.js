const axios = require('axios');

const BASE_URL = 'https://kaspi.kz/shop/api/v2';
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30000;

let activeRequests = 0;
const requestQueue = [];

function acquireRequestSlot() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => requestQueue.push(resolve));
}

function releaseRequestSlot() {
  const next = requestQueue.shift();
  if (next) {
    next();
    return;
  }
  activeRequests -= 1;
}

async function withRequestSlot(fn) {
  await acquireRequestSlot();
  try {
    return await fn();
  } finally {
    releaseRequestSlot();
  }
}

function isRetryableError(err) {
  const status = err && err.response ? Number(err.response.status) : null;
  return !status || status === 429 || status >= 500;
}

function retryDelayMs(err, attempt) {
  const retryAfter = err && err.response && err.response.headers
    ? err.response.headers['retry-after']
    : null;
  if (retryAfter !== undefined && retryAfter !== null && retryAfter !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }

  return Math.min(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
}

function wait(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function kaspiGet(http, path, config) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await withRequestSlot(() => http.get(path, config));
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === MAX_REQUEST_ATTEMPTS) throw err;
      const delay = retryDelayMs(err, attempt);
      console.warn(`Kaspi API: повтор GET ${path}, попытка ${attempt + 1}/${MAX_REQUEST_ATTEMPTS} через ${delay} мс`);
      await wait(delay);
    }
  }
  throw lastError;
}

function getHeaders() {
  return {
    'X-Auth-Token': process.env.KASPI_API_TOKEN,
    'Content-Type': 'application/vnd.api+json',
    Accept: 'application/vnd.api+json',
  };
}

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: getHeaders(),
    timeout: 30000,
  });
}

async function fetchOrders(dateFromMs, dateToMs) {
  const http = client();
  const allOrders = [];
  let page = 0;
  const pageSize = 100;

  while (true) {
    const response = await kaspiGet(http, '/orders', {
      params: {
        'page[number]': page,
        'page[size]': pageSize,
        'filter[orders][creationDate][$ge]': dateFromMs,
        'filter[orders][creationDate][$le]': dateToMs,
      },
    });

    const orders = response.data.data || [];
    allOrders.push(...orders);

    const totalCount = response.data.meta ? response.data.meta.totalCount : orders.length;
    const fetchedSoFar = (page + 1) * pageSize;

    if (orders.length === 0 || fetchedSoFar >= totalCount) break;
    page += 1;
  }

  return allOrders;
}

// Заказы с конкретными state/status (например "отменяется при доставке" — KASPI_DELIVERY/
// CANCELLING) за широкое окно дат. В отличие от fetchOrders, Kaspi ограничивает диапазон
// creationDate максимум 14 днями за один запрос, поэтому идём чанками (по умолчанию 10 дней,
// как и обычная синхронизация заказов в syncJob.js).
// Число параллельных задач поиска. Реальные HTTP-запросы дополнительно проходят через общий
// лимитер выше, поэтому даже вложенная параллельность периодов и страниц не превысит четыре
// одновременных обращения к Kaspi во всём процессе.
const SEARCH_CONCURRENCY = 4;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// Один кусок дат целиком. Первую страницу берём отдельно: только из её meta.totalCount
// известно, сколько всего страниц, — зато остальные после этого качаются параллельно, а не
// по одной, как было.
async function fetchOrdersChunk(http, params, pageSize) {
  const firstResponse = await kaspiGet(http, '/orders', { params: { ...params, 'page[number]': 0, 'page[size]': pageSize } });
  const first = firstResponse.data.data || [];
  const totalCount = firstResponse.data.meta ? firstResponse.data.meta.totalCount : first.length;

  const totalPages = Math.ceil((totalCount || first.length) / pageSize);
  if (totalPages <= 1) return first;

  const restPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  const rest = await mapLimit(restPages, SEARCH_CONCURRENCY, async (page) => {
    const response = await kaspiGet(http, '/orders', { params: { ...params, 'page[number]': page, 'page[size]': pageSize } });
    return response.data.data || [];
  });

  return [first, ...rest].flat();
}

// Заказы с конкретными state/status (например "отменяется при доставке" — KASPI_DELIVERY/
// CANCELLING) за широкое окно дат. В отличие от fetchOrders, Kaspi ограничивает диапазон
// creationDate максимум 14 днями за один запрос, поэтому идём чанками (по умолчанию 10 дней,
// как и обычная синхронизация заказов в syncJob.js). Чанки тоже идут параллельно.
async function fetchOrdersByStatus(state, status, dateFromMs, dateToMs, chunkDays = 10) {
  const http = client();
  const pageSize = 100;
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;

  const chunks = [];
  for (let cursor = dateFromMs; cursor < dateToMs; cursor += chunkMs) {
    chunks.push([cursor, Math.min(cursor + chunkMs, dateToMs)]);
  }

  const perChunk = await mapLimit(chunks, SEARCH_CONCURRENCY, ([from, to]) => {
    // state = null — спрашиваем по статусу во ВСЕХ состояниях сразу. Нужно поиску отмен:
    // "Ожидает отмены" бывает и у заказа в доставке, и у ещё не отгруженного, и угадывать
    // состояние по статусу нельзя (см. syncDeliveryCancellations).
    const params = {
      'filter[orders][creationDate][$ge]': from,
      'filter[orders][creationDate][$le]': to,
      'filter[orders][status]': status,
    };
    if (state) params['filter[orders][state]'] = state;
    return fetchOrdersChunk(http, params, pageSize);
  });

  return perChunk.flat();
}

// Официальный поиск конкретного заказа выполняется фильтром по видимому номеру `code`.
// Нельзя вычислять внутренний JSON:API id через base64: формат id не является частью
// контракта Kaspi и для некоторых заказов такая догадка возвращала ложное "не найдено".
async function fetchOrderByCode(code) {
  const http = client();
  const response = await kaspiGet(http, '/orders', {
    params: {
      'filter[orders][code]': String(code),
      'page[number]': 0,
      'page[size]': 1,
    },
  });
  const orders = response.data.data || [];
  return orders[0] || null;
}

// Kaspi кодирует id ресурса в base64: "MTM2NTE3NjA2" -> "136517606".
// Это тот же код, что виден в публичной ссылке на товар (kaspi.kz/shop/p/.../-<code>/),
// используем его позже, чтобы подтянуть картинку товара с публичной страницы.
function decodeMasterProductCode(relationshipId) {
  if (!relationshipId) return null;
  try {
    return Buffer.from(relationshipId, 'base64').toString('utf-8');
  } catch (err) {
    return null;
  }
}

async function fetchOrderEntries(orderId) {
  const http = client();
  const response = await kaspiGet(http, `/orders/${orderId}/entries`);
  const entries = response.data.data || [];

  return entries.map((entry) => {
    const attrs = entry.attributes || {};
    const productName = (attrs.offer && attrs.offer.name) || attrs.name || 'Неизвестный товар';
    const productId = (attrs.offer && attrs.offer.code) || entry.id;
    const productRelId = entry.relationships && entry.relationships.product && entry.relationships.product.data
      ? entry.relationships.product.data.id
      : null;

    return {
      id: entry.id,
      productId,
      productName,
      quantity: attrs.quantity || 1,
      totalPrice: attrs.totalPrice || 0,
      masterProductCode: decodeMasterProductCode(productRelId),
    };
  });
}

// Низкоуровневый вызов для встроенного API-шлюза. URL сюда приходит уже проверенным и
// относительным (/orders?...), реальный X-Auth-Token всегда берётся только из окружения.
// Редиректы отключены, чтобы Kaspi-токен не мог уйти на другой домен даже при неожиданном
// ответе upstream. Записывающие запросы намеренно не повторяются автоматически.
async function proxyKaspiRequest(method, pathWithQuery, body) {
  const http = client();
  return withRequestSlot(() => http.request({
    method,
    url: pathWithQuery,
    data: ['GET', 'HEAD'].includes(String(method).toUpperCase()) ? undefined : body,
    responseType: 'arraybuffer',
    validateStatus: () => true,
    maxRedirects: 0,
  }));
}

module.exports = {
  fetchOrders,
  fetchOrderEntries,
  fetchOrdersByStatus,
  fetchOrderByCode,
  proxyKaspiRequest,
};
