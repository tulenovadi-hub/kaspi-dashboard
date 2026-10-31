const express = require('express');
const { pool } = require('../db');
const { MARKED_SELF_BUY_CITY } = require('../warehouseMapping');

const router = express.Router();

// Самовыкуп с реального склада не должен трогать остаток и себестоимость. Метка меняет только orders: origin_city указывает на город без партий (см. warehouseMapping.js), и
// остальной код считает заказ самовыкупом без отдельных условий. Снятие метки возвращает склад точки продаж.

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.code AS order_number, o.total_price, o.status, o.creation_date, o.self_buy_marked_by, o.self_buy_marked_at,
              w.city AS warehouse, COALESCE(SUM(oi.quantity), 0)::int AS item_quantity
       FROM orders o
       LEFT JOIN warehouses w ON w.pickup_point_id = o.pickup_point_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.self_buy_marked = true
       GROUP BY o.id, w.city
       ORDER BY o.self_buy_marked_at DESC`
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить отмеченные самовыкупы' });
  }
});

router.post('/', async (req, res) => {
  const orderNumber = String(req.body.order_number || '').trim();
  if (!/^\d{6,15}$/.test(orderNumber)) return res.status(400).json({ error: 'Укажите корректный номер заказа' });

  try {
    const updated = await pool.query(
      `UPDATE orders
       SET self_buy_marked = true, self_buy_marked_by = $1, self_buy_marked_at = now(), origin_city = $2
       WHERE code = $3 AND self_buy_marked = false`,
      [req.user ? req.user.username : null, MARKED_SELF_BUY_CITY, orderNumber]
    );
    if (updated.rowCount === 0) {
      const existing = await pool.query('SELECT 1 FROM orders WHERE code = $1', [orderNumber]);
      return existing.rowCount > 0
        ? res.status(409).json({ error: 'Этот заказ уже отмечен как самовыкуп' })
        : res.status(404).json({ error: `Заказ ${orderNumber} не найден в данных сайта` });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось отметить заказ' });
  }
});

router.delete('/:orderNumber', async (req, res) => {
  try {
    const updated = await pool.query(
      `UPDATE orders
       SET self_buy_marked = false, self_buy_marked_by = NULL, self_buy_marked_at = NULL,
           origin_city = (SELECT w.city FROM warehouses w WHERE w.pickup_point_id = orders.pickup_point_id)
       WHERE code = $1 AND self_buy_marked = true`,
      [String(req.params.orderNumber)]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Заказ не отмечен как самовыкуп' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось снять отметку' });
  }
});

module.exports = router;
