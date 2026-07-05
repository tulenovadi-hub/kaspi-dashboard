const express = require('express');
const { pool } = require('../db');
const { computeCosts } = require('../costEngine');

const router = express.Router();

// Важно: у одного заказа может быть НЕСКОЛЬКО строк в Excel-отчёте Kaspi Pay — например,
// если в заказе несколько товаров (несколько строк "Покупка"), либо если товар купили и потом
// вернули (строка "Покупка" и строка "Возврат" с тем же номером заказа). Группируем по
// (номер заказа, тип операции): несколько строк одного типа схлопываются в одну (чтобы не
// перемножались при join с order_items), а покупка и возврат остаются двумя отдельными строками,
// чтобы оба события были видны, а не гасили друг друга в одну "пустую" запись.
router.get('/', async (req, res) => {
  try {
    const costData = await computeCosts();

    const result = await pool.query(`
      WITH item_agg AS (
        SELECT order_id, STRING_AGG(DISTINCT product_name, ', ') AS product_names, SUM(quantity) AS quantity
        FROM order_items
        GROUP BY order_id
      ),
      kpt_agg AS (
        SELECT
          order_number,
          operation_type,
          MIN(operation_date) AS operation_date,
          SUM(amount) AS amount,
          SUM(commission_total) AS commission_total,
          SUM(delivery_cost) AS delivery_cost
        FROM kaspi_pay_transactions
        GROUP BY order_number, operation_type
      )
      SELECT
        o.code AS order_number,
        o.origin_city AS warehouse,
        o.status AS order_status,
        ka.operation_type,
        ka.operation_date,
        ka.amount,
        ka.commission_total,
        ka.delivery_cost,
        ia.product_names,
        COALESCE(ia.quantity, 0) AS quantity
      FROM kpt_agg ka
      JOIN orders o ON o.code = ka.order_number
      LEFT JOIN item_agg ia ON ia.order_id = o.id
      ORDER BY ka.operation_date DESC
    `);

    const orders = result.rows.map((row) => {
      const amount = Number(row.amount);
      const commission = -Number(row.commission_total); // положительное число — расход
      const delivery = -Number(row.delivery_cost); // положительное число — расход
      const cost = costData.byOrderKey[`${row.order_number}::${row.operation_type}`] || 0;
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
