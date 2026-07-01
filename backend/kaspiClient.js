const axios = require('axios');

const BASE_URL = 'https://kaspi.kz/shop/api/v2';

// Справочник товаров: артикул → название
const PRODUCT_NAMES = {
  '230273701': 'TOMMILI LumenPro TM-D34',
  '305435303': 'Проектор TOMMILI T15 PRO',
  '707062070': 'Проектор TOMMILI LUMIX HD',
  '426553': 'Проектор TOMMILI HY320',
  '107802641': 'TOMMILI MasterClean черный',
  '116138814': 'Проектор TOMMILI X6',
  '302817922': 'Проектор TOMMILI X6',
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

    // Ищем артикул в ID позиции заказа
    let productName = null;
    for (const [sku, name] of Object.entries(PRODUCT_NAMES)) {
      if (entry.id && entry.id.includes(sku)) {
        productName = name;
        break;
      }
    }

    if (!productName) {
      productName = attrs.name || attrs.title || `Товар ${entry.id ? entry.id.slice(-8) : '?'}`;
    }

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
