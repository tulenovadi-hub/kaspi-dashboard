const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const VALID_WAREHOUSES = ['Алматы', 'Астана', 'Талдыкорган', 'Юбилейное'];
const VALID_STATUSES = ['in_transit', 'received'];
const VALID_CURRENCIES = ['KZT', 'USD', 'CNY'];

// Справочные поля курса валюты — необязательные, поэтому пустое/некорректное значение
// просто превращается в null, а не в ошибку валидации всей поставки.
function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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
      `SELECT id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
              purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate
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
  const {
    product_id, product_name, purchase_price, logistics_cost, note, warehouse, quantity, received_date, status,
    purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate,
  } = req.body;

  if (!product_id || !product_name) {
    return res.status(400).json({ error: 'Не указан товар' });
  }
  if (!warehouse || !VALID_WAREHOUSES.includes(warehouse)) {
    return res.status(400).json({ error: 'Не указан склад (город)' });
  }
  const purchasePrice = Number(purchase_price);
  const logisticsCost = Number(logistics_cost || 0);
  const qty = Number(quantity);
  const batchStatus = VALID_STATUSES.includes(status) ? status : 'received';
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
  const purchaseCurrency = VALID_CURRENCIES.includes(purchase_currency) ? purchase_currency : null;
  const purchaseAmountForeign = optionalNumber(purchase_amount_foreign);
  const purchaseRate = optionalNumber(purchase_rate);
  const logisticsCurrency = VALID_CURRENCIES.includes(logistics_currency) ? logistics_currency : null;
  const logisticsAmountForeign = optionalNumber(logistics_amount_foreign);
  const logisticsRate = optionalNumber(logistics_rate);

  try {
    const result = await pool.query(
      `INSERT INTO product_batches (product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status,
                                     purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
                 purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate`,
      [product_id, product_name, costPrice, purchasePrice, logisticsCost, note || null, warehouse, qty, received_date, batchStatus,
        purchaseCurrency, purchaseAmountForeign, purchaseRate, logisticsCurrency, logisticsAmountForeign, logisticsRate]
    );
    res.status(201).json({ batch: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось добавить партию' });
  }
});

// Редактирование существующей партии. Если меняется количество — остаток (remaining_quantity)
// сдвигается на ту же разницу, чтобы не потерять уже проданную часть партии.
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    warehouse, purchase_price, logistics_cost, note, quantity, received_date, status,
    purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate,
  } = req.body;

  if (!warehouse || !VALID_WAREHOUSES.includes(warehouse)) {
    return res.status(400).json({ error: 'Не указан склад (город)' });
  }
  const purchasePrice = Number(purchase_price);
  const logisticsCost = Number(logistics_cost || 0);
  const qty = Number(quantity);
  const batchStatus = VALID_STATUSES.includes(status) ? status : 'received';
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
  const purchaseCurrency = VALID_CURRENCIES.includes(purchase_currency) ? purchase_currency : null;
  const purchaseAmountForeign = optionalNumber(purchase_amount_foreign);
  const purchaseRate = optionalNumber(purchase_rate);
  const logisticsCurrency = VALID_CURRENCIES.includes(logistics_currency) ? logistics_currency : null;
  const logisticsAmountForeign = optionalNumber(logistics_amount_foreign);
  const logisticsRate = optionalNumber(logistics_rate);

  try {
    const existing = await pool.query(`SELECT quantity, remaining_quantity FROM product_batches WHERE id = $1`, [id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Партия не найдена' });
    }
    const oldQuantity = Number(existing.rows[0].quantity);
    const oldRemaining = Number(existing.rows[0].remaining_quantity);
    const newRemaining = Math.max(0, oldRemaining + (qty - oldQuantity));

    const result = await pool.query(
      `UPDATE product_batches
       SET cost_price = $1, purchase_price = $2, logistics_cost = $3, note = $4, warehouse = $5,
           quantity = $6, remaining_quantity = $7, received_date = $8, status = $9,
           purchase_currency = $10, purchase_amount_foreign = $11, purchase_rate = $12,
           logistics_currency = $13, logistics_amount_foreign = $14, logistics_rate = $15
       WHERE id = $16
       RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
                 purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate`,
      [costPrice, purchasePrice, logisticsCost, note || null, warehouse, qty, newRemaining, received_date, batchStatus,
        purchaseCurrency, purchaseAmountForeign, purchaseRate, logisticsCurrency, logisticsAmountForeign, logisticsRate, id]
    );
    res.json({ batch: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить изменения' });
  }
});

// Быстрая отметка "Прибыло" (для партий со статусом in_transit) — переводит статус в received
// и проставляет фактическую дату поступления = сегодня (до этого там была ожидаемая дата).
router.post('/:id/receive', async (req, res) => {
  const { id } = req.params;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `UPDATE product_batches SET status = 'received', received_date = $1
       WHERE id = $2
       RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
                 purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate`,
      [today, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Партия не найдена' });
    }
    res.json({ batch: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось отметить поставку как прибывшую' });
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
