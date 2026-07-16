const express = require('express');
const { pool } = require('../db');
const { syncDeliveryCancellations } = require('../deliveryReturnsSync');

const router = express.Router();

// Сколько дней заказ может провисеть в статусе "Отменяется/возврат" в Kaspi Доставке, прежде
// чем считать его подозрительным (возможно потерян Kaspi при возврате на склад) — обычные
// возвраты обрабатываются заметно быстрее, порог согласован с владельцем магазина.
const SUSPICIOUS_DAYS_THRESHOLD = 45;

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_number, creation_date, total_price, cancellation_reason, delivery_mode, origin_city
       FROM delivery_cancellations
       ORDER BY creation_date ASC`
    );

    const now = Date.now();
    const orders = result.rows.map((r) => {
      const daysSince = Math.floor((now - new Date(r.creation_date).getTime()) / (24 * 60 * 60 * 1000));
      return {
        order_number: r.order_number,
        creation_date: r.creation_date,
        days_since: daysSince,
        total_price: Number(r.total_price),
        cancellation_reason: r.cancellation_reason,
        delivery_mode: r.delivery_mode,
        origin_city: r.origin_city,
        suspicious: daysSince >= SUSPICIOUS_DAYS_THRESHOLD,
      };
    });

    res.json({ orders, threshold_days: SUSPICIOUS_DAYS_THRESHOLD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список отменённых при доставке заказов' });
  }
});

// Ручной запуск проверки — по умолчанию последние 2 дня (то же самое, что и ночная
// синхронизация в server.js), но можно передать более широкий диапазон для разового бэкфилла,
// например { "from": "2026-01-01" } чтобы подтянуть всю историю с начала года.
router.post('/sync', async (req, res) => {
  try {
    const dateToMs = Date.now();
    const dateFromMs = req.body && req.body.from
      ? new Date(req.body.from).getTime()
      : dateToMs - 2 * 24 * 60 * 60 * 1000;

    const count = await syncDeliveryCancellations(dateFromMs, dateToMs);
    res.json({ ok: true, checked: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось проверить отменённые заказы' });
  }
});

// Пользователь убирает заказ из списка вручную, когда разобрался с ним на Kaspi (вернулся на
// склад, оформлен возврат и т.п.) — автоматически определить это мы не можем (см. deliveryReturnsSync.js).
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
