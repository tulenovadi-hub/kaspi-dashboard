// routes/stats.js — эндпоинты, которые фронтенд использует для построения графиков и таблиц
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Маленький помощник: проверяет, что даты пришли в правильном формате YYYY-MM-DD
function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// GET /api/stats/summary?from=2026-06-01&to=2026-06-29
// Возвращает: общую сумму продаж и количество заказов за период, по дням
router.get('/summary', async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    // Группируем по дню в часовом поясе Алматы (UTC+5), а не в UTC сервера —
    // иначе заказы, сделанные поздно вечером по местному времени, могли бы
    // ошибочно попадать в "следующий день" в статистике.
    const result = await pool.query(
      `SELECT
         (creation_date AT TIME ZONE 'Asia/Almaty')::date AS day,
         COUNT(*) AS orders_count,
         SUM(total_price) AS total_revenue
       FROM orders
       WHERE creation_date >= ($1::date AT TIME ZONE 'Asia/Almaty')
         AND creation_date < (($2::date + interval '1 day') AT TIME ZONE 'Asia/Almaty')
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

// GET /api/stats/products?from=...&to=...
// Возвращает список товаров с суммарными продажами за период — для выбора в выпадающем списке и общего рейтинга
router.get('/products', async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT
         product_id,
         product_name,
         SUM(quantity) AS total_quantity,
         SUM(total_price) AS total_revenue
       FROM order_items
       WHERE creation_date >= ($1::date AT TIME ZONE 'Asia/Almaty')
         AND creation_date < (($2::date + interval '1 day') AT TIME ZONE 'Asia/Almaty')
       GROUP BY product_id, product_name
       ORDER BY total_revenue DESC`,
      [from, to]
    );

    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список товаров' });
  }
});

// GET /api/stats/product/:productId?from=...&to=...
// Возвращает продажи конкретного товара по дням за период — для графика роста/спада
router.get('/product/:productId', async (req, res) => {
  const { productId } = req.params;
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT
         (creation_date AT TIME ZONE 'Asia/Almaty')::date AS day,
         SUM(quantity) AS total_quantity,
         SUM(total_price) AS total_revenue
       FROM order_items
       WHERE product_id = $1
         AND creation_date >= ($2::date AT TIME ZONE 'Asia/Almaty')
         AND creation_date < (($3::date + interval '1 day') AT TIME ZONE 'Asia/Almaty')
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
