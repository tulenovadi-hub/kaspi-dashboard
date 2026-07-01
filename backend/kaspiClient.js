const axios = require('axios');

const BASE_URL = 'https://kaspi.kz/shop/api/v2';

// Справочник товаров: base64-ID → название
const PRODUCT_NAMES = {
  'MTU1NDc2NTAy': 'Стеклоочиститель TOMMILI MasterClean',
  'OTgyNzA1ODk2IyMw': 'Проектор TOMMILI T15 PRO',
  'MTQxOTYxNDYz': 'Экран TOMMILI LumenPro TM-D34',
  'MTUzMzYwODUw': 'Неизвестный товар',
  'MTE2MTM4ODE0': 'Проектор TOMMILI X6',
  'MTM2NTE3NjA2': 'Проектор TOMMILI LUMIX HD',
  'MTUxNDc4ODA1': 'Проектор TOMMILI T15 PRO',
  'MTE2MTM4Nzk5': 'Проектор TOMMILI HY320',
};

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

async function fetchOrderEntries(orderId) {
  const http = client();
  const response = await http.get(`/orders/${orderId}/entries`);
  const entries = response.data.data || [];
  const results = [];

  for (const entry of entries) {
    const attrs = entry.attributes || {};
    const productName = PRODUCT_NAMES[entry.id] || attrs.name || `Товар ${entry.id.slice(-6)}`;

    results.push({
      id: entry.id,
      productId: entry.id,
      productName,
      quantity: attrs.quantity || 1,
      totalPrice: attrs.totalPrice || 0,
    });
  }

  return results;
}

module.exports = { fetchOrders, fetchOrderEntries };
