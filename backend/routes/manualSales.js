const express = require('express');
const { pool } = require('../db');
const { STOCK_CUTOFF_DATE } = require('../constants');
const { ALL_CITIES } = require('../warehouseMapping');

const router = express.Router();

// Продажа мимо магазина Kaspi (счёт на удалённую оплату) есть в выгрузке Kaspi Pay, но заказа по
// ней в API нет: нет ни товара, ни склада. В "Отчёт" такая сумма попадала с нулевой себестоимостью
// и остаток не менялся. Когда владелец указывает товар и город, заводим обычную запись в orders и
// order_items: дальше продажу считают те же FIFO, "Склад", "Отчёт" и Главная, без отдельных условий.
// raw_data у такого заказа пустой, поэтому синхронизация и пересчёт складов её не трогают.

const STORE_PAYMENT_TYPE = 'Магазин на Kaspi.kz';

const manualOrderId = (orderNumber) => `manual-${orderNumber}`;

async function loadPending(db = pool) {
  const result = await db.query(
    `SELECT kpt.order_number, to_char(MIN(kpt.operation_date), 'YYYY-MM-DD') AS date,
            SUM(kpt.amount) AS amount, MAX(NULLIF(kpt.product_name, '')) AS details
     FROM kaspi_pay_transactions kpt
     LEFT JOIN orders o ON o.code = kpt.order_number
     WHERE o.id IS NULL
       AND kpt.operation_type = 'Покупка'
       AND kpt.operation_date >= $1::date
       AND kpt.payment_type IS DISTINCT FROM $2
     GROUP BY kpt.order_number
     ORDER BY MIN(kpt.operation_date) DESC`,
    [STOCK_CUTOFF_DATE, STORE_PAYMENT_TYPE]
  );
  return result.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

router.get('/', async (req, res) => {
  try {
    const linked = await pool.query(
      `SELECT o.code AS order_number, to_char(o.creation_date + interval '5 hours', 'YYYY-MM-DD') AS date, o.total_price AS amount,
              o.manual_city AS warehouse, oi.product_name, oi.quantity
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.manual_sale = true
       ORDER BY o.creation_date DESC`
    );
    res.json({
      pending: await loadPending(),
      linked: linked.rows.map((row) => ({ ...row, amount: Number(row.amount) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить продажи вне магазина' });
  }
});

router.post('/', async (req, res) => {
  const orderNumber = String(req.body.order_number || '').trim();
  const productId = String(req.body.product_id || '').trim();
  const productName = String(req.body.product_name || productId).trim();
  const warehouse = String(req.body.warehouse || '').trim();
  const quantity = Number(req.body.quantity);
  if (!orderNumber || !productId) return res.status(400).json({ error: 'Выберите товар' });
  if (!ALL_CITIES.includes(warehouse)) return res.status(400).json({ error: 'Выберите склад' });
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Количество должно быть целым числом больше нуля' });
  }

  try {
    const sale = (await loadPending()).find((row) => row.order_number === orderNumber);
    if (!sale) return res.status(404).json({ error: 'Эта продажа уже привязана или её нет в отчёте Kaspi Pay' });

    const id = manualOrderId(orderNumber);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO orders (id, code, creation_date, total_price, state, status, origin_city, manual_city, was_completed, manual_sale)
         VALUES ($1, $2, $3::date - interval '5 hours', $4, 'MANUAL', 'COMPLETED', $5, $5, true, true)`,
        [id, orderNumber, sale.date, sale.amount, warehouse]
      );
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, total_price, creation_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date - interval '5 hours')`,
        [id, id, productId, productName, quantity, sale.amount, sale.date]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось привязать продажу' });
  }
});

// Снятие привязки удаляет только заведённую здесь запись, строка Kaspi Pay остаётся.
router.delete('/:orderNumber', async (req, res) => {
  try {
    const removed = await pool.query(
      'DELETE FROM orders WHERE id = $1 AND manual_sale = true',
      [manualOrderId(req.params.orderNumber)]
    );
    if (removed.rowCount === 0) return res.status(404).json({ error: 'Привязка не найдена' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось снять привязку' });
  }
});

module.exports = router;
