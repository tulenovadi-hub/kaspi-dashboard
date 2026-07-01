const express = require('express');
const { pool } = require('../db');

const router = express.Router();

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

router.get('/summary', async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT
         (creation_date + interval '5 hours')::date AS day,
         COUNT(*) AS orders_count,
         SUM(total_price) AS total_revenue
       FROM orders
       WHERE creation_date >= $1::timestamp - interval '5 hours'
         AND creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
       GROUP BY day
       ORDER BY day`,
      [from, to]
    );
    res.json({ days: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить статистику' });
  }
});

router.get('/products', async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT
         oi.product_id,
         oi.product_name,
         SUM(oi.quantity) AS total_quantity,
         SUM(oi.total_price) AS total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
         AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
       GROUP BY oi.product_id, oi.product_name
       ORDER BY total_revenue DESC`,
      [from, to]
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список товаров' });
  }
});

router.get('/product/:productId', async (req, res) => {
  const { productId } = req.params;
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT
         (oi.creation_date + interval '5 hours')::date AS day,
         SUM(oi.quantity) AS total_quantity,
         SUM(oi.total_price) AS total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = $1
         AND oi.creation_date >= $2::timestamp - interval '5 hours'
         AND oi.creation_date < $3::timestamp - interval '5 hours' + interval '1 day'
         AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
       GROUP BY day
       ORDER BY day`,
      [productId, from, to]
    );
    res.json({ days: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить статистику по товару' });
  }
});

module.exports = router;
