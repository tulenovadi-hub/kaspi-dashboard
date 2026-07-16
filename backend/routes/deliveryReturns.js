const express = require('express');
const { pool } = require('../db');
const { syncDeliveryCancellations, refreshTrackedOrders } = require('../deliveryReturnsSync');

const router = express.Router();

// Сколько дней заказ может провисеть в статусе "Отменяется" (ещё не в архиве), прежде чем
// считать его подозрительным — обычные отмены обрабатываются заметно быстрее, порог
// согласован с владельцем магазина. Для заказов, уже попавших в архив (state=ARCHIVE/
// status=CANCELLED), надёжный признак другой — returned_to_warehouse (см. ниже).
const SUSPICIOUS_DAYS_THRESHOLD = 45;

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_number, creation_date, total_price, cancellation_reason, delivery_mode,
              origin_city, state, status, returned_to_warehouse
       FROM delivery_cancellations
       ORDER BY creation_date ASC`
    );

    const now = Date.now();
    const orders = result.rows.map((r) => {
      const daysSince = Math.floor((now - new Date(r.creation_date).getTime()) / (24 * 60 * 60 * 1000));
      const isArchived = r.status === 'CANCELLED';
      // В архиве returnedToWarehouse — надёжный признак ("false" = Kaspi не подтвердил возврат,
      // похоже на утерю). Пока заказ ещё "отменяется" — это поле всегда false и ни о чём не
      // говорит, там ориентируемся просто на то, сколько дней он уже висит в этом статусе.
      const suspicious = isArchived ? r.returned_to_warehouse === false : daysSince >= SUSPICIOUS_DAYS_THRESHOLD;
      return {
        order_number: r.order_number,
        creation_date: r.creation_date,
        days_since: daysSince,
        total_price: Number(r.total_price),
        cancellation_reason: r.cancellation_reason,
        delivery_mode: r.delivery_mode,
        origin_city: r.origin_city,
        state: r.state,
        status: r.status,
        returned_to_warehouse: r.returned_to_warehouse,
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
// разового бэкфилла) И перепроверяет уже отслеживаемые незавершённые заказы на предмет того,
// не переехали ли они в архив.
router.post('/sync', async (req, res) => {
  try {
    const dateToMs = Date.now();
    const dateFromMs = req.body && req.body.from
      ? new Date(req.body.from).getTime()
      : dateToMs - 2 * 24 * 60 * 60 * 1000;

    const [foundNew, refreshed] = await Promise.all([
      syncDeliveryCancellations(dateFromMs, dateToMs),
      refreshTrackedOrders(),
    ]);
    res.json({ ok: true, found_new: foundNew, refreshed });
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
