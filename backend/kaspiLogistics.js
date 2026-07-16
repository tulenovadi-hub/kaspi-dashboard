// kaspiLogistics.js — публичный (без авторизации) трекинг Kaspi Delivery, тот же, что видно
// на странице logistics.kaspi.kz/ksl/tracking/order/<номер>. Даёт настоящий статус доставки/
// возврата — в отличие от kaspiDelivery.returnedToWarehouse в основном API заказов, который
// оказался ненадёжным (не обновляется для части заказов даже после фактического возврата).
const axios = require('axios');

async function fetchTrackingStatus(orderNumber) {
  try {
    const response = await axios.get('https://logistics.kaspi.kz/core/api/public/support', {
      params: { orderId: orderNumber },
      timeout: 15000,
    });
    return response.data;
  } catch (err) {
    return null;
  }
}

module.exports = { fetchTrackingStatus };
