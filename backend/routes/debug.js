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

// Временный диагностический роут — смотрим raw_data заказа из НАШЕЙ базы по номеру заказа (code),
// а не по внутреннему id Kaspi (его с сайта продавца не видно). Нужен, чтобы понять, какие поля
// Kaspi присылает для заказов, отменённых при доставке ("KASPI_DELIVERY_RETURN_REQUEST" и т.п.) —
// есть ли там дата отмены/статус возврата, по которым можно отследить, что заказ не потерян.
router.get('/order-by-code/:code', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, code, state, status, raw_data FROM orders WHERE code = $1', [req.params.code]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Заказ с таким номером не найден в нашей базе' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Временный диагностический роут — проверяем, поддерживает ли Kaspi фильтр по статусу
// заказа в списке /orders (а не только по дате создания, как сейчас в kaspiClient.js).
// Если да — можно будет находить ВСЕ заказы в статусе "отменяется/возврат" напрямую у Kaspi,
// не завися от нашей локальной синхронизации (которая старые заказы больше не обновляет).
router.get('/orders-by-status', async (req, res) => {
  const daysBack = Number(req.query.daysBack) || 90;
  const now = Date.now();
  try {
    const response = await client().get('/orders', {
      params: {
        'page[number]': 0,
        'page[size]': 100,
        'filter[orders][creationDate][$ge]': now - daysBack * 24 * 60 * 60 * 1000,
        'filter[orders][creationDate][$le]': now,
        'filter[orders][state]': req.query.state || 'KASPI_DELIVERY',
        'filter[orders][status]': req.query.status || 'CANCELLING',
      },
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response ? err.response.data : null });
  }
});

module.exports = router;
