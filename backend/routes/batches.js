const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const { ALL_CITIES: VALID_WAREHOUSES } = require('../warehouseMapping');
const VALID_STATUSES = ['in_transit', 'received'];
const VALID_CURRENCIES = ['KZT', 'USD', 'CNY'];

// Справочные поля курса валюты — необязательные, поэтому пустое/некорректное значение
// просто превращается в null, а не в ошибку валидации всей поставки.
function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Прочие расходы на партию (сертификаты, НДС, растаможка и т.п.) — произвольный список,
// названия придумывает пользователь. Приводим к чистому виду: выкидываем строки без
// названия или без суммы, отрезаем слишком длинные названия, валюту берём только из
// известного списка. Ошибку не кидаем: это необязательная часть формы, и одна кривая
// строка не должна мешать сохранить всю поставку.
const MAX_EXPENSE_NAME_LENGTH = 60;
// Артикул (product_id) — это offer.code из заказа Kaspi, ключ, по которому партия связывается
// с продажами при FIFO-списании. Название — только для отображения.
const MAX_PRODUCT_ID_LENGTH = 100;
const MAX_PRODUCT_NAME_LENGTH = 200;
const MAX_EXTRA_EXPENSES = 20;

function normalizeExtraExpenses(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = String(item.name || '').trim().slice(0, MAX_EXPENSE_NAME_LENGTH);
      const amount = optionalNumber(item.amount);
      if (!name || amount === null || amount < 0) return null;
      const currency = VALID_CURRENCIES.includes(item.currency) ? item.currency : 'KZT';
      // Для тенге курс всегда 1, для остальных валют — что указали (по умолчанию тоже 1,
      // чтобы сумма не превратилась в ноль, если курс забыли заполнить).
      const rate = currency === 'KZT' ? 1 : (optionalNumber(item.rate) || 1);
      return { name, amount, currency, rate };
    })
    .filter(Boolean)
    .slice(0, MAX_EXTRA_EXPENSES);
}

// Прочие расходы указываются суммой за ВСЮ партию, а cost_price — за 1 шт,
// поэтому делим на количество (как закупку и логистику на фронтенде).
function extraExpensesPerUnit(expenses, qty) {
  if (!qty) return 0;
  const totalKzt = expenses.reduce((sum, e) => sum + e.amount * e.rate, 0);
  return totalKzt / qty;
}

// Список товаров для выпадающего списка при добавлении партии — чтобы не вводить название
// руками и не ошибиться в артикуле. Источников два:
//   1) order_items — всё, что когда-либо продавалось (приходит из API Kaspi при синхронизации);
//   2) product_batches — товары, добавленные вручную на "Поставках".
// Второй источник нужен для НОВОГО товара: карточка на Kaspi уже создана, товар едет, но
// продаж ещё не было — значит в order_items его нет и в списке он бы не появился. Один раз
// введя его вручную, дальше его можно выбирать из списка как обычно.
// from_sales показывает, есть ли по товару реальные продажи: у введённого вручную артикула
// это false, и на фронтенде рядом с ним видна пометка — если артикул набран с ошибкой,
// продажи к нему никогда не привяжутся, и такая пометка останется навсегда.
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query(
      `WITH all_products AS (
         SELECT product_id, product_name, true AS from_sales
         FROM order_items
         WHERE product_id IS NOT NULL
         UNION ALL
         SELECT product_id, product_name, false
         FROM product_batches
         WHERE product_id IS NOT NULL
       )
       SELECT product_id,
              -- если товар есть и в продажах, и в поставках, показываем название из продаж:
              -- оно приходит от Kaspi и всегда актуальнее того, что набрали руками
              (array_agg(product_name ORDER BY from_sales DESC))[1] AS product_name,
              bool_or(from_sales) AS from_sales
       FROM all_products
       GROUP BY product_id
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
              purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses
       FROM product_batches
       ORDER BY product_name, received_date, id`
    );
    // Список складов отдаём вместе с партиями, чтобы фронтенду не приходилось держать
    // собственную копию — источник правды один, backend/warehouseMapping.js.
    res.json({ batches: result.rows, warehouses: VALID_WAREHOUSES });
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
    extra_expenses,
  } = req.body;

  // product_id/product_name могут прийти как из выпадающего списка, так и набранными вручную
  // (новый товар, которого ещё не было в продажах), поэтому чистим и ограничиваем длину.
  const productId = String(product_id || '').trim().slice(0, MAX_PRODUCT_ID_LENGTH);
  const productName = String(product_name || '').trim().slice(0, MAX_PRODUCT_NAME_LENGTH);
  if (!productId || !productName) {
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

  const extraExpenses = normalizeExtraExpenses(extra_expenses);
  // Прочие расходы входят в себестоимость наравне с закупкой и логистикой — значит
  // автоматически учитываются в FIFO-списании, оценке склада и расчёте прибыли.
  const costPrice = purchasePrice + logisticsCost + extraExpensesPerUnit(extraExpenses, qty);
  const purchaseCurrency = VALID_CURRENCIES.includes(purchase_currency) ? purchase_currency : null;
  const purchaseAmountForeign = optionalNumber(purchase_amount_foreign);
  const purchaseRate = optionalNumber(purchase_rate);
  const logisticsCurrency = VALID_CURRENCIES.includes(logistics_currency) ? logistics_currency : null;
  const logisticsAmountForeign = optionalNumber(logistics_amount_foreign);
  const logisticsRate = optionalNumber(logistics_rate);

  try {
    const result = await pool.query(
      `INSERT INTO product_batches (product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status,
                                     purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
                 purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses`,
      [productId, productName, costPrice, purchasePrice, logisticsCost, note || null, warehouse, qty, received_date, batchStatus,
        purchaseCurrency, purchaseAmountForeign, purchaseRate, logisticsCurrency, logisticsAmountForeign, logisticsRate,
        JSON.stringify(extraExpenses)]
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
    extra_expenses,
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

  const extraExpenses = normalizeExtraExpenses(extra_expenses);
  // Прочие расходы входят в себестоимость наравне с закупкой и логистикой — значит
  // автоматически учитываются в FIFO-списании, оценке склада и расчёте прибыли.
  const costPrice = purchasePrice + logisticsCost + extraExpensesPerUnit(extraExpenses, qty);
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
           logistics_currency = $13, logistics_amount_foreign = $14, logistics_rate = $15,
           extra_expenses = $16
       WHERE id = $17
       RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
                 purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses`,
      [costPrice, purchasePrice, logisticsCost, note || null, warehouse, qty, newRemaining, received_date, batchStatus,
        purchaseCurrency, purchaseAmountForeign, purchaseRate, logisticsCurrency, logisticsAmountForeign, logisticsRate,
        JSON.stringify(extraExpenses), id]
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
                 purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses`,
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
