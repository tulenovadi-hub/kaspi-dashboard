// kaspiClient.js — всё общение с Kaspi API сосредоточено здесь
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

    if (orders.length === 0 || fetchedSoFar >= totalCount) {
      break;
    }
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
    let productName = null;

    try {
      const relatedUrl =
        entry.relationships &&
        entry.relationships.product &&
        entry.relationships.product.links &&
        entry.relationships.product.links.related;

      if (relatedUrl) {
        const productRes = await axios.get(relatedUrl, {
          headers: getHeaders(),
          timeout: 15000,
        });
        const pd = productRes.data && productRes.data.data;
        if (pd && pd.attributes) {
          productName =
            pd.attributes.name ||
            pd.attributes.title ||
            pd.attributes.displayName ||
            null;
        }
      }
    } catch (e) {
      // не получилось — продолжим без названия
    }

    if (!productName) {
      productName = attrs.name || attrs.title || attrs.productName || `Товар ${entry.id.slice(-6)}`;
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
