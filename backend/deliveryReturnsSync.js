// deliveryReturnsSync.js — находит заказы, отменённые при доставке (Kaspi Доставка), и
// сохраняет их в delivery_cancellations. Запускается либо разово на широкий диапазон дат
// (первоначальный бэкфилл), либо каждую ночь на последние пару дней (см. server.js).

const { pool } = require('./db');
const { fetchOrdersByStatus } = require('./kaspiClient');

async function syncDeliveryCancellations(dateFromMs, dateToMs) {
  const orders = await fetchOrdersByStatus('KASPI_DELIVERY', 'CANCELLING', dateFromMs, dateToMs);

  let count = 0;
  for (const order of orders) {
    const attrs = order.attributes || {};
    const originCity = attrs.originAddress && attrs.originAddress.city ? attrs.originAddress.city.name : null;

    await pool.query(
      `INSERT INTO delivery_cancellations (order_number, creation_date, total_price, cancellation_reason, delivery_mode, origin_city)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6)
       ON CONFLICT (order_number) DO UPDATE SET
         total_price = EXCLUDED.total_price,
         cancellation_reason = EXCLUDED.cancellation_reason,
         delivery_mode = EXCLUDED.delivery_mode,
         origin_city = EXCLUDED.origin_city`,
      [attrs.code, attrs.creationDate, attrs.totalPrice, attrs.cancellationReason, attrs.deliveryMode, originCity]
    );
    count += 1;
  }

  return count;
}

module.exports = { syncDeliveryCancellations };
