const express = require('express');
const { pool } = require('../db');
const { syncDeliveryCancellations, refreshTrackedOrders, refreshTrackingStatuses, refreshWonderReceived, SEARCH_WINDOW_DAYS } = require('../deliveryReturnsSync');

const router = express.Router();

// Сколько дней без движения (или без единого трек-события вообще) — повод считать заказ
// подозрительным. Порог согласован с владельцем магазина.
const SUSPICIOUS_DAYS_THRESHOLD = 45;

router.get('/', async (req, res) => {
  try {
    // Наименование товара берём из order_items — чтобы по строке было видно, что именно едет
    // обратно. У заказа может быть несколько позиций, поэтому склеиваем их в одну строку.
    // LEFT JOIN: состав заказа мог не подтянуться (например, отмена случилась до того, как мы
    // впервые увидели заказ) — такую строку терять нельзя.
    const result = await pool.query(
      `SELECT dc.order_number, dc.creation_date, dc.total_price, dc.cancellation_reason, dc.delivery_mode,
              dc.origin_city, dc.state, dc.status, dc.tracking_status, dc.tracking_active,
              dc.last_track_at, dc.wonder_received, dc.stock_returned_at,
              items.product_names, items.quantity
       FROM delivery_cancellations dc
       LEFT JOIN orders o ON o.code = dc.order_number
       LEFT JOIN LATERAL (
         SELECT STRING_AGG(DISTINCT oi.product_name, ', ') AS product_names, SUM(oi.quantity) AS quantity
         FROM order_items oi
         WHERE oi.order_id = o.id
       ) items ON true
       ORDER BY dc.creation_date ASC`
    );

    const now = Date.now();
    const orders = result.rows.map((r) => {
      const daysSince = Math.floor((now - new Date(r.creation_date).getTime()) / (24 * 60 * 60 * 1000));
      // tracking_active = false — трекинг сам сообщил, что процесс закончен. И "RETURNED"
      // (реально вернулся), и "CANCELLED" (отменили ДО того, как заказ вообще уехал в
      // доставку — возвращать было нечего) — это нормальные, благополучные исходы, не повод
      // для подозрений. Пока трекинг ещё активен ("RETURNING" и т.п.) — подозрительно, только
      // если движения нет уже слишком долго. Если трекинг вообще не нашёлся (null) — данных
      // не хватает, лучше не флагать вслепую, чем повторить ошибку с returnedToWarehouse.
      let suspicious = false;
      let daysSinceLastTrack = null;
      if (r.tracking_active === true) {
        const lastTrackMs = r.last_track_at ? new Date(r.last_track_at).getTime() : null;
        daysSinceLastTrack = lastTrackMs ? Math.floor((now - lastTrackMs) / (24 * 60 * 60 * 1000)) : daysSince;
        suspicious = daysSinceLastTrack >= SUSPICIOUS_DAYS_THRESHOLD;
      }

      return {
        order_number: r.order_number,
        product_names: r.product_names,
        quantity: r.quantity === null ? null : Number(r.quantity),
        stock_returned_at: r.stock_returned_at,
        // "Ждёт добавления в остаток" — товар уехал со склада, возврат по нему идёт или уже
        // доехал по трекингу, но владелец ещё не подтвердила приём кнопкой. Ровно эти заказы
        // вычтены из остатка на "Складе" (см. computeWarehouseStock) и показываются в основной
        // таблице; всё остальное — архив.
        awaiting_stock: r.stock_returned_at === null && (r.tracking_active === true || r.tracking_status === 'RETURNED'),
        creation_date: r.creation_date,
        days_since: daysSince,
        days_since_last_track: daysSinceLastTrack,
        total_price: Number(r.total_price),
        cancellation_reason: r.cancellation_reason,
        delivery_mode: r.delivery_mode,
        origin_city: r.origin_city,
        state: r.state,
        status: r.status,
        tracking_status: r.tracking_status,
        tracking_active: r.tracking_active,
        last_track_at: r.last_track_at,
        wonder_received: r.wonder_received,
        suspicious,
      };
    });

    res.json({ orders, threshold_days: SUSPICIOUS_DAYS_THRESHOLD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список отменённых при доставке заказов' });
  }
});

// Ручной запуск проверки: находит новые отмены за диапазон (по умолчанию последние
// SEARCH_WINDOW_DAYS дней — то же самое, что и ночная синхронизация; можно передать
// { "from": "2026-01-01" } для разового бэкфилла), перепроверяет статус ещё не архивных
// заказов в основном API, и обновляет реальный трекинг доставки/возврата для всех
// незавершённых заказов.
router.post('/sync', async (req, res) => {
  try {
    const dateToMs = Date.now();
    const dateFromMs = req.body && req.body.from
      ? new Date(req.body.from).getTime()
      : dateToMs - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const foundNew = await syncDeliveryCancellations(dateFromMs, dateToMs);
    const refreshed = await refreshTrackedOrders();
    const trackingChecked = await refreshTrackingStatuses();

    // Отдельный try/catch — если у Wonder не задан логин или он сам недоступен, это не должно
    // сбрасывать уже полученные результаты по остальным шагам синхронизации.
    let wonderChecked = 0;
    try {
      wonderChecked = await refreshWonderReceived();
    } catch (err) {
      console.error('Не удалось сверить заказы с Wonder:', err);
    }

    // window_days отдаём наружу, чтобы по ответу было видно, за какой период реально искали
    // (у ручного бэкфилла с { "from": ... } он больше, чем обычные SEARCH_WINDOW_DAYS).
    const windowDays = Math.round((dateToMs - dateFromMs) / (24 * 60 * 60 * 1000));
    res.json({ ok: true, window_days: windowDays, found_new: foundNew, refreshed, tracking_checked: trackingChecked, wonder_checked: wonderChecked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось проверить отменённые заказы' });
  }
});

// "Добавить в остаток" — владелец сама убедилась, что вернувшийся товар физически доехал до
// склада. До нажатия этой кнопки штуки вычтены из остатка на "Складе" (колонка "Возвращается"),
// после — снова в остатке, а заказ уезжает в архив. Автоматически по трекингу Kaspi этого не
// происходит специально: трекинг говорит "вернулся на склад" раньше, чем товар реально доходит.
router.post('/:orderNumber/return-to-stock', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE delivery_cancellations SET stock_returned_at = now()
       WHERE order_number = $1 AND stock_returned_at IS NULL
       RETURNING order_number, stock_returned_at`,
      [req.params.orderNumber]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Заказ не найден или уже добавлен в остаток' });
    }
    res.json({ ok: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось добавить заказ в остаток' });
  }
});

// Пользователь убирает заказ из списка вручную, когда разобрался с ним на Kaspi.
router.delete('/:orderNumber', async (req, res) => {
  try {
    await pool.query('DELETE FROM delivery_cancellations WHERE order_number = $1', [req.params.orderNumber]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить заказ из списка' });
  }
});

module.exports = router;
