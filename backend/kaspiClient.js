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
// creationDate максимум 14 днями за один запрос, поэтому идём чанками (по умолчанию 14 дней назад).
async function fetchOrdersByStatus(state, status, daysBack, chunkDays = 14) {
  const http = client();
  const now = Date.now();
  let cursor = now - daysBack * 24 * 60 * 60 * 1000;
  const allOrders = [];

  while (cursor < now) {
    const chunkEnd = Math.min(cursor + chunkDays * 24 * 60 * 60 * 1000, now);
    let page = 0;
    const pageSize = 100;

    while (true) {
      const response = await http.get('/orders', {
        params: {
          'page[number]': page,
          'page[size]': pageSize,
          'filter[orders][creationDate][$ge]': cursor,
          'filter[orders][creationDate][$le]': chunkEnd,
          'filter[orders][state]': state,
          'filter[orders][status]': status,
        },
      });

      const orders = response.data.data || [];
      allOrders.push(...orders);

      const totalCount = response.data.meta ? response.data.meta.totalCount : orders.length;
      const fetchedSoFar = (page + 1) * pageSize;

      if (orders.length === 0 || fetchedSoFar >= totalCount) break;
      page += 1;
    }

    cursor = chunkEnd;
  }

  return allOrders;
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

module.exports = { fetchOrders, fetchOrderEntries, fetchOrdersByStatus };
