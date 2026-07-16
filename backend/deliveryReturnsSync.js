// deliveryReturnsSync.js — находит заказы, отменённые при доставке (Kaspi Доставка), и
// сохраняет их в delivery_cancellations. Запускается либо разово на широкий диапазон дат
// (первоначальный бэкфилл), либо каждую ночь на последние пару дней (см. server.js).

const { pool } = require('./db');
const { fetchOrdersByStatus, fetchOrderByCode } = require('./kaspiClient');
const { fetchTrackingStatus } = require('./kaspiLogistics');

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
// Kaspi наконец разрешает отмену и переходит в ARCHIVE/CANCELLED. Диапазон дат тут не при
// чём — просто дёргаем каждый заказ по его номеру напрямую.
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

// Подтягивает настоящий статус трекинга (публичный logistics.kaspi.kz) для всех заказов, по
// которым мы ещё не видели подтверждённый возврат — как только видим, статус уже не
// изменится, дальше можно не перепроверять.
//
// ВАЖНО: верхнеуровневые поля ответа (orderStatus/active/lastActualTrack) оказались
// ненадёжными — на заказе 773482186 они показывали "ещё едет" (active: true, lastActualTrack:
// null), хотя в массиве tracks того же ответа явно есть событие "RETURNED" с датой. Поэтому
// ориентируемся только на сам массив tracks: если там есть код RETURNED — заказ точно
// вернулся, и берём дату САМОГО ПОЗДНЕГО события из tracks как last_track_at (а не
// lastActualTrack, который тоже может быть пустым при непустой истории).
async function refreshTrackingStatuses() {
  const result = await pool.query(`SELECT order_number FROM delivery_cancellations WHERE tracking_status IS DISTINCT FROM 'RETURNED'`);

  let count = 0;
  for (const row of result.rows) {
    const data = await fetchTrackingStatus(row.order_number);
    if (!data) continue;

    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    const hasReturned = tracks.some((t) => t.code === 'RETURNED');
    const lastTrack = tracks.reduce((latest, t) => {
      if (!t.actualDateTime) return latest;
      if (!latest || new Date(t.actualDateTime) > new Date(latest.actualDateTime)) return t;
      return latest;
    }, null);

    // "Активно возвращается" — только если ПОСЛЕДНЕЕ по времени событие начинается с RETURN_
    // (реально в процессе обратной перевозки). Любой другой код последним (CANCELLED, ожидание
    // в пункте выдачи и т.п.) означает, что процесс так или иначе завершился без явного
    // подтверждения RETURNED — это не повод считать заказ зависшим, просто у него не было
    // отдельного этапа возврата (например, отменили ещё до отправки).
    const lastCode = lastTrack ? lastTrack.code : null;
    const isActivelyReturning = !!(lastCode && lastCode.startsWith('RETURN_'));

    const trackingStatus = hasReturned ? 'RETURNED' : lastCode;
    const trackingActive = hasReturned ? false : isActivelyReturning;
    const lastTrackAt = lastTrack ? lastTrack.actualDateTime : null;

    await pool.query(
      `UPDATE delivery_cancellations
       SET tracking_status = $2, tracking_active = $3, last_track_at = $4
       WHERE order_number = $1`,
      [row.order_number, trackingStatus, trackingActive, lastTrackAt]
    );
    count += 1;
  }
  return count;
}

module.exports = { syncDeliveryCancellations, refreshTrackedOrders, refreshTrackingStatuses };
