// kaspiClient.js — всё общение с Kaspi API сосредоточено здесь
const axios = require('axios');

const BASE_URL = 'https://kaspi.kz/shop/api/v2';

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'X-Auth-Token': process.env.KASPI_API_TOKEN,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
    },
    timeout: 30000,
  });
}

// Kaspi отдаёт максимум 100 заказов на страницу — поэтому забираем все страницы по очереди.
// dateFromMs / dateToMs — границы периода в миллисекундах (формат, который ждёт Kaspi).
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

    if (orders.length === 0 || fetchedSoFar >= totalCount) {
      break;
    }
    page += 1;
  }

  return allOrders;
}

// Для каждого заказа состав (товары) приходит отдельным запросом.
// orderId здесь — это ID в кодировке Kaspi (поле "id" у заказа).
async function fetchOrderEntries(orderId) {
  const http = client();
  const response = await http.get(`/orders/${orderId}/entries`);
  const entries = response.data.data || [];
  const results = [];

  for (const entry of entries) {
    const attrs = entry.attributes || {};
    let productName = entry.id;

    try {
      const productRes = await http.get(`/orderentries/${entry.id}/product`);
      const productData = productRes.data.data;
      if (productData && productData.attributes) {
        productName = productData.attributes.name || productData.attributes.title || entry.id;
      }
    } catch (e) {
      productName = attrs.name || attrs.title || entry.id;
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

module.exports = { fetchOrders, fetchOrderEntries };
