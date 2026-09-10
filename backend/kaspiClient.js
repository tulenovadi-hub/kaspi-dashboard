const axios = require('axios');

const BASE_URL = 'https://kaspi.kz/shop/api/v2';

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
    const response = await http.get('/orders', {
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
// Сколько запросов к Kaspi держим одновременно внутри одного поиска. Замер 11.09.2026:
// поиск отмен за 20 дней занимал 48 секунд, потому что и куски дат, и страницы внутри куска
// шли строго по очереди — а Kaspi отвечает медленно, и всё время уходило в ожидание.
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
  const firstResponse = await http.get('/orders', { params: { ...params, 'page[number]': 0, 'page[size]': pageSize } });
  const first = firstResponse.data.data || [];
  const totalCount = firstResponse.data.meta ? firstResponse.data.meta.totalCount : first.length;

  const totalPages = Math.ceil((totalCount || first.length) / pageSize);
  if (totalPages <= 1) return first;

  const restPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  const rest = await mapLimit(restPages, SEARCH_CONCURRENCY, async (page) => {
    const response = await http.get('/orders', { params: { ...params, 'page[number]': page, 'page[size]': pageSize } });
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

// Внутренний id заказа у Kaspi — это просто base64 от номера заказа (code), который видит
// продавец: "915440447" -> "OTE1NDQwNDQ3". Позволяет получить live-статус КОНКРЕТНОГО заказа
// по номеру, без обхода по датам — нужно, чтобы перепроверять уже отслеживаемые отмены
// (например, перешёл ли заказ из "отменяется" в архив, и вернулся ли на склад).
function encodeOrderId(code) {
  return Buffer.from(String(code), 'utf-8').toString('base64');
}

async function fetchOrderByCode(code) {
  const http = client();
  const response = await http.get(`/orders/${encodeOrderId(code)}`);
  return response.data.data;
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
  const response = await http.get(`/orders/${orderId}/entries`);
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

module.exports = { fetchOrders, fetchOrderEntries, fetchOrdersByStatus, fetchOrderByCode };
