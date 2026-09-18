const express = require('express');
const axios = require('axios');
const { pool } = require('../db');
const { STOCK_CUTOFF_DATE } = require('../constants');

const router = express.Router();

function client() {
  return axios.create({
    baseURL: 'https://kaspi.kz/shop/api/v2',
    headers: {
      'X-Auth-Token': process.env.KASPI_API_TOKEN,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
    },
    timeout: 30000,
  });
}

// Временный диагностический роут — смотрим сырой ответ Kaspi по заказу и его позициям,
// чтобы найти, где хранится адрес/город забора для самовывоза без Kaspi Delivery.
// Не забыть удалить после того, как разберёмся со складами!
router.get('/order/:orderId', async (req, res) => {
  try {
    const response = await client().get(`/orders/${req.params.orderId}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response ? err.response.data : null });
  }
});

router.get('/order-entries/:orderId', async (req, res) => {
  try {
    const response = await client().get(`/orders/${req.params.orderId}/entries`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response ? err.response.data : null });
  }
});

router.get('/masterproduct/:productId', async (req, res) => {
  try {
    const response = await client().get(`/masterproducts/${req.params.productId}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response ? err.response.data : null });
  }
});

router.get('/merchantproduct/:productId', async (req, res) => {
  try {
    const response = await client().get(`/merchantproducts/${req.params.productId}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response ? err.response.data : null });
  }
});

// Что о заказе лежит в НАШЕЙ базе (а не в Kaspi): статус, из которого считается остаток на
// Складе, город отгрузки и позиции. Нужно, чтобы проверять расхождения вида "заказ отменён при
// доставке, а в остатке он всё ещё списан/не списан" — статус в orders обновляется только когда
// синхронизация захватывает заказ по ДАТЕ СОЗДАНИЯ, поэтому у старых заказов он может быть
// устаревшим. Только чтение.
router.get('/db-order/:code', async (req, res) => {
  try {
    const order = await pool.query(
      `SELECT id, code, creation_date, total_price, state, status, was_completed, origin_city, pickup_point_id
       FROM orders WHERE code = $1`,
      [req.params.code]
    );
    if (order.rowCount === 0) return res.json({ found: false });

    const items = await pool.query(
      `SELECT product_id, product_name, quantity, total_price FROM order_items WHERE order_id = $1`,
      [order.rows[0].id]
    );
    res.json({ found: true, order: order.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Аудит исправления от 18.09.2026: обычные покупательские возвраты, которые старая формула
// исключала из списания и тем самым ошибочно возвращала в доступный остаток. Отмены при
// доставке сюда намеренно не входят — для них действует отдельная ручная кнопка.
router.get('/warehouse-return-leakage', async (req, res) => {
  try {
    const statuses = ['KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED'];
    const details = await pool.query(
      `SELECT oi.product_id,
              MAX(oi.product_name) AS product_name,
              o.origin_city AS warehouse,
              COUNT(DISTINCT o.id)::int AS orders_count,
              SUM(oi.quantity)::int AS units_count,
              COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'KASPI_DELIVERY_RETURN_REQUESTED')::int AS awaiting_count,
              COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'RETURNED')::int AS returned_count,
              MIN(o.creation_date) AS first_order_date,
              MAX(o.creation_date) AS last_order_date
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN delivery_cancellations dc ON dc.order_number = o.code
       WHERE o.creation_date >= $1::date
         AND o.status = ANY($2::text[])
         AND o.was_completed = true
         AND o.origin_city IS NOT NULL
         AND dc.order_number IS NULL
       GROUP BY oi.product_id, o.origin_city
       ORDER BY units_count DESC, product_name`,
      [STOCK_CUTOFF_DATE, statuses]
    );

    const totals = await pool.query(
      `SELECT COUNT(DISTINCT o.id)::int AS orders_count,
              COALESCE(SUM(oi.quantity), 0)::int AS units_count,
              MIN(o.creation_date) AS first_order_date,
              MAX(o.creation_date) AS last_order_date
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN delivery_cancellations dc ON dc.order_number = o.code
       WHERE o.creation_date >= $1::date
         AND o.status = ANY($2::text[])
         AND o.was_completed = true
         AND o.origin_city IS NOT NULL
         AND dc.order_number IS NULL`,
      [STOCK_CUTOFF_DATE, statuses]
    );

    res.json({
      from: STOCK_CUTOFF_DATE,
      as_of: new Date().toISOString(),
      definition: 'Обычные покупательские возвраты, которые старая формула повторно включала в доступный остаток',
      totals: totals.rows[0],
      products: details.rows.map((row) => ({
        ...row,
        orders_count: Number(row.orders_count),
        units_count: Number(row.units_count),
        awaiting_count: Number(row.awaiting_count),
        returned_count: Number(row.returned_count),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось построить отчёт по покупательским возвратам' });
  }
});

module.exports = router;
