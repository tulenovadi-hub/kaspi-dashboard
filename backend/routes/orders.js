const express = require('express');
const { pool } = require('../db');
const { computeCosts } = require('../costEngine');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const costData = await computeCosts();

    const result = await pool.query(`
      SELECT
        o.code AS order_number,
        o.creation_date,
        o.origin_city AS warehouse,
        o.status AS order_status,
        kpt.operation_type,
        kpt.operation_date,
        kpt.amount,
        kpt.commission_total,
        kpt.delivery_cost,
        STRING_AGG(DISTINCT oi.product_name, ', ') AS product_names,
        COALESCE(SUM(oi.quantity), 0) AS quantity
      FROM kaspi_pay_transactions kpt
      JOIN orders o ON o.code = kpt.order_number
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.code, o.creation_date, o.origin_city, o.status, kpt.operation_type, kpt.operation_date, kpt.amount, kpt.commission_total, kpt.delivery_cost
      ORDER BY kpt.operation_date DESC, o.creation_date DESC
    `);

    const orders = result.rows.map((row) => {
      const amount = Number(row.amount);
      const commission = -Number(row.commission_total); // положительное число — расход
      const delivery = -Number(row.delivery_cost); // положительное число — расход
      const cost = costData.byOrderNumber[row.order_number] || 0;
      const netAmount = amount - cost - commission - delivery;
      const margin = amount !== 0 ? (netAmount / amount) * 100 : null;

      return {
        order_number: row.order_number,
        date: row.operation_date,
        warehouse: row.warehouse,
        status: row.order_status,
        operation_type: row.operation_type,
        product_name: row.product_names || '—',
        quantity: Number(row.quantity),
        cost,
        delivery,
        commission,
        amount,
        margin,
      };
    });

    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список заказов' });
  }
});

module.exports = router;
