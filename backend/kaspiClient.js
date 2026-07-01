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

async function fetchOrderEntries(orderId) {
  const http = client();

  // Запрашиваем позиции заказа вместе с данными о товаре
  const response = await http.get(`/orders/${orderId}/entries`, {
    params: { include: 'masterproduct' },
  });

  const entries = response.data.data || [];
  const included = response.data.included || [];

  // Логируем первый ответ для отладки
  if (entries.length > 0 && included.length > 0) {
    console.log('INCLUDED TYPE:', included[0].type, 'ATTRS:', JSON.stringify(included[0].attributes).slice(0, 200));
  }

  return entries.map((entry) => {
    const attrs = entry.attributes || {};

    // Ищем товар в included по любому типу
    const productRel = entry.relationships && entry.relationships.product && entry.relationships.product.data;
    const productId = productRel ? productRel.id : null;
    const productInfo = included.find((inc) => inc.id === productId);
    const productName = (productInfo && productInfo.attributes && (
      productInfo.attributes.name ||
      productInfo.attributes.title ||
      productInfo.attributes.displayName
    )) || attrs.name || `Товар ${entry.id.slice(-6)}`;

    return {
      id: entry.id,
      productId: productId || entry.id,
      productName,
      quantity: attrs.quantity || 1,
      totalPrice: attrs.totalPrice || 0,
    };
  });
}

module.exports = { fetchOrders, fetchOrderEntries };
