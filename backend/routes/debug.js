const express = require('express');
const axios = require('axios');
const { pool } = require('../db');

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
      `SELECT id, code, creation_date, total_price, state, status, origin_city, pickup_point_id
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

module.exports = router;
