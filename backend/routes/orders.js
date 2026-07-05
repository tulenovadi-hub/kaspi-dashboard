const express = require('express');
const { pool } = require('../db');
const { computeCosts } = require('../costEngine');

const router = express.Router();

// Важно: у одного заказа может быть НЕСКОЛЬКО строк в Excel-отчёте Kaspi Pay (например,
// если в заказе несколько разных товаров — каждая позиция может идти отдельной строкой
// со своей долей суммы/комиссии/доставки). Поэтому сначала агрегируем kaspi_pay_transactions
// и order_items КАЖДОЕ ОТДЕЛЬНО по order_number/order_id (через CTE), и только потом соединяем
// готовые агрегаты — если сначала сделать один большой JOIN и потом group by, строки
// перемножатся и всё задвоится (именно так и было раньше).
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
          MIN(operation_date) AS operation_date,
          SUM(amount) AS amount,
          SUM(commission_total) AS commission_total,
          SUM(delivery_cost) AS delivery_cost,
          BOOL_OR(operation_type = 'Возврат') AS has_return
        FROM kaspi_pay_transactions
        GROUP BY order_number
      )
      SELECT
        o.code AS order_number,
        o.origin_city AS warehouse,
        o.status AS order_status,
        ka.operation_date,
        ka.amount,
        ka.commission_total,
        ka.delivery_cost,
        ka.has_return,
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
      const cost = costData.byOrderNumber[row.order_number] || 0;
      const netAmount = amount - cost - commission - delivery;
      const margin = amount !== 0 ? (netAmount / amount) * 100 : null;

      return {
        order_number: row.order_number,
        date: row.operation_date,
        warehouse: row.warehouse,
        status: row.order_status,
        operation_type: row.has_return ? 'Возврат' : 'Покупка',
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
