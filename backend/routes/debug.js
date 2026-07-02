const express = require('express');
const axios = require('axios');

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

module.exports = router;
