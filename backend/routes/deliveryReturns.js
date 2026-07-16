const express = require('express');
const { fetchOrdersByStatus } = require('../kaspiClient');

const router = express.Router();

// Сколько дней заказ может провисеть в статусе "Отменяется/возврат" в Kaspi Доставке, прежде
// чем считать его подозрительным (возможно потерян Kaspi при возврате на склад) — обычные
// возвраты обрабатываются заметно быстрее, порог согласован с владельцем магазина.
const SUSPICIOUS_DAYS_THRESHOLD = 45;

// На сколько дней назад просматривать историю в поиске "зависших" отмен.
const SCAN_DAYS_BACK = 30;
const CHUNK_DAYS = 10;

router.get('/', async (req, res) => {
  try {
    const orders = await fetchOrdersByStatus('KASPI_DELIVERY', 'CANCELLING', SCAN_DAYS_BACK, CHUNK_DAYS);
    const now = Date.now();

    const list = orders
      .map((o) => {
        const attrs = o.attributes || {};
        const daysSince = Math.floor((now - attrs.creationDate) / (24 * 60 * 60 * 1000));
        return {
          order_number: attrs.code,
          creation_date: attrs.creationDate,
          days_since: daysSince,
          total_price: attrs.totalPrice,
          cancellation_reason: attrs.cancellationReason,
          delivery_mode: attrs.deliveryMode,
          origin_city: attrs.originAddress && attrs.originAddress.city ? attrs.originAddress.city.name : null,
          suspicious: daysSince >= SUSPICIOUS_DAYS_THRESHOLD,
        };
      })
      .sort((a, b) => b.days_since - a.days_since);

    res.json({ orders: list, threshold_days: SUSPICIOUS_DAYS_THRESHOLD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список отменённых при доставке заказов' });
  }
});

module.exports = router;
