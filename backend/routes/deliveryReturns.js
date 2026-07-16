const express = require('express');
const { pool } = require('../db');
const { syncDeliveryCancellations, refreshTrackedOrders, refreshTrackingStatuses } = require('../deliveryReturnsSync');

const router = express.Router();

// Сколько дней без движения (или без единого трек-события вообще) — повод считать заказ
// подозрительным. Порог согласован с владельцем магазина.
const SUSPICIOUS_DAYS_THRESHOLD = 45;

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_number, creation_date, total_price, cancellation_reason, delivery_mode,
              origin_city, state, status, tracking_status, tracking_active, last_track_at
       FROM delivery_cancellations
       ORDER BY creation_date ASC`
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
        suspicious,
      };
    });

    res.json({ orders, threshold_days: SUSPICIOUS_DAYS_THRESHOLD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список отменённых при доставке заказов' });
  }
});

// Ручной запуск проверки: находит новые отмены за диапазон (по умолчанию последние 2 дня —
// то же самое, что и ночная синхронизация; можно передать { "from": "2026-01-01" } для
// разового бэкфилла), перепроверяет статус ещё не архивных заказов в основном API, и
// обновляет реальный трекинг доставки/возврата для всех незавершённых заказов.
router.post('/sync', async (req, res) => {
  try {
    const dateToMs = Date.now();
    const dateFromMs = req.body && req.body.from
      ? new Date(req.body.from).getTime()
      : dateToMs - 2 * 24 * 60 * 60 * 1000;

    const foundNew = await syncDeliveryCancellations(dateFromMs, dateToMs);
    const refreshed = await refreshTrackedOrders();
    const trackingChecked = await refreshTrackingStatuses();
    res.json({ ok: true, found_new: foundNew, refreshed, tracking_checked: trackingChecked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось проверить отменённые заказы' });
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
