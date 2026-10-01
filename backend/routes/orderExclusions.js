const express = require('express');
const { pool } = require('../db');
const { buildSummary, excludeOrder, restoreOrder } = require('../orderExclusions');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_number, reason, excluded_by, excluded_at, snapshot
       FROM excluded_orders ORDER BY excluded_at DESC`
    );
    res.json({
      orders: result.rows.map(({ snapshot, ...row }) => ({ ...row, summary: buildSummary(snapshot || {}) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить исключённые заказы' });
  }
});

router.post('/', async (req, res) => {
  const orderNumber = String(req.body.order_number || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!/^\d{6,15}$/.test(orderNumber)) return res.status(400).json({ error: 'Укажите корректный номер заказа' });
  if (reason.length < 5) return res.status(400).json({ error: 'Кратко укажите причину исключения' });

  try {
    const summary = await excludeOrder(orderNumber, reason, req.user && req.user.username);
    res.json({ ok: true, order_number: orderNumber, summary });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Не удалось исключить заказ' });
  }
});

router.post('/:orderNumber/restore', async (req, res) => {
  const orderNumber = String(req.params.orderNumber || '').trim();
  try {
    const summary = await restoreOrder(orderNumber);
    res.json({ ok: true, order_number: orderNumber, summary });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Не удалось вернуть заказ в учёт' });
  }
});

module.exports = router;
