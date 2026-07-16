// deliveryReturnsSync.js — находит заказы, отменённые при доставке (Kaspi Доставка), и
// сохраняет их в delivery_cancellations. Запускается либо разово на широкий диапазон дат
// (первоначальный бэкфилл), либо каждую ночь на последние пару дней (см. server.js).

const { pool } = require('./db');
const { fetchOrdersByStatus, fetchOrderByCode } = require('./kaspiClient');

function upsertFromAttrs(client, attrs) {
  const originCity = attrs.originAddress && attrs.originAddress.city ? attrs.originAddress.city.name : null;
  const returnedToWarehouse = attrs.kaspiDelivery ? attrs.kaspiDelivery.returnedToWarehouse : null;

  return client.query(
    `INSERT INTO delivery_cancellations
       (order_number, creation_date, total_price, cancellation_reason, delivery_mode, origin_city, state, status, returned_to_warehouse)
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (order_number) DO UPDATE SET
       total_price = EXCLUDED.total_price,
       cancellation_reason = EXCLUDED.cancellation_reason,
       delivery_mode = EXCLUDED.delivery_mode,
       origin_city = EXCLUDED.origin_city,
       state = EXCLUDED.state,
       status = EXCLUDED.status,
       returned_to_warehouse = EXCLUDED.returned_to_warehouse`,
    [attrs.code, attrs.creationDate, attrs.totalPrice, attrs.cancellationReason, attrs.deliveryMode, originCity, attrs.state, attrs.status, returnedToWarehouse]
  );
}

// Ищет НОВЫЕ отмены за диапазон дат — и ещё идущие (KASPI_DELIVERY/CANCELLING), и уже
// в архиве (ARCHIVE/CANCELLED), чтобы не терять заказы, которые успели разрешиться ещё
// до того, как мы их впервые увидели (см. историю переписки — заказ 915440447).
async function syncDeliveryCancellations(dateFromMs, dateToMs) {
  const [cancelling, archived] = await Promise.all([
    fetchOrdersByStatus('KASPI_DELIVERY', 'CANCELLING', dateFromMs, dateToMs),
    fetchOrdersByStatus('ARCHIVE', 'CANCELLED', dateFromMs, dateToMs),
  ]);

  let count = 0;
  for (const order of [...cancelling, ...archived]) {
    await upsertFromAttrs(pool, order.attributes || {});
    count += 1;
  }
  return count;
}

// Перепроверяет уже отслеживаемые заказы, которые ещё не в архиве — ловит момент, когда
// Kaspi наконец разрешает отмену (переходит в ARCHIVE/CANCELLED) и появляется настоящий
// признак returnedToWarehouse. Диапазон дат тут не при чём — просто дёргаем каждый заказ
// по его номеру напрямую.
async function refreshTrackedOrders() {
  const result = await pool.query(`SELECT order_number FROM delivery_cancellations WHERE status IS DISTINCT FROM 'CANCELLED'`);

  let count = 0;
  for (const row of result.rows) {
    const order = await fetchOrderByCode(row.order_number);
    if (order && order.attributes) {
      await upsertFromAttrs(pool, order.attributes);
      count += 1;
    }
  }
  return count;
}

module.exports = { syncDeliveryCancellations, refreshTrackedOrders };
