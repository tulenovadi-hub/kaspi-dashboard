const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Список всех продуктов, которые когда-либо продавались — нужно для выпадающего
// списка при добавлении новой партии, чтобы не вводить название вручную и не ошибиться.
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT product_id, product_name
       FROM order_items
       WHERE product_id IS NOT NULL
       ORDER BY product_name`
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список товаров' });
  }
});

// Список всех партий, сгруппированных по товару, отсортированных по дате поступления (FIFO-порядок)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, created_at
       FROM product_batches
       ORDER BY product_name, received_date, id`
    );
    res.json({ batches: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список партий' });
  }
});

// Добавление новой партии
router.post('/', async (req, res) => {
  const { product_id, product_name, purchase_price, logistics_cost, note, warehouse, quantity, received_date } = req.body;

  if (!product_id || !product_name) {
    return res.status(400).json({ error: 'Не указан товар' });
  }
  if (!warehouse || !['Алматы', 'Астана'].includes(warehouse)) {
    return res.status(400).json({ error: 'Не указан склад (город)' });
  }
  const purchasePrice = Number(purchase_price);
  const logisticsCost = Number(logistics_cost || 0);
  const qty = Number(quantity);
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
    return res.status(400).json({ error: 'Закупочная цена указана некорректно' });
  }
  if (!Number.isFinite(logisticsCost) || logisticsCost < 0) {
    return res.status(400).json({ error: 'Логистика указана некорректно' });
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Количество должно быть целым числом больше нуля' });
  }
  if (!received_date || !/^\d{4}-\d{2}-\d{2}$/.test(received_date)) {
    return res.status(400).json({ error: 'Дата поступления указана некорректно' });
  }

  const costPrice = purchasePrice + logisticsCost;

  try {
    const result = await pool.query(
      `INSERT INTO product_batches (product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
       RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, created_at`,
      [product_id, product_name, costPrice, purchasePrice, logisticsCost, note || null, warehouse, qty, received_date]
    );
    res.status(201).json({ batch: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось добавить партию' });
  }
});

// Удаление партии (на случай, если ввели по ошибке)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`DELETE FROM product_batches WHERE id = $1 RETURNING id`, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Партия не найдена' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить партию' });
  }
});

module.exports = router;
