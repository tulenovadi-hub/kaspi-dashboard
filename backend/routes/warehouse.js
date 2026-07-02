const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Заказы, которые реально считаются продажей (совпадает с логикой в stats.js)
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

// Считает остатки по методу FIFO: партии списываются в порядке поступления,
// пока не закончится количество, реально проданное по этому товару.
router.get('/', async (req, res) => {
  try {
    const batchesResult = await pool.query(`
      SELECT id, product_id, product_name, cost_price, quantity, received_date
      FROM product_batches
      ORDER BY product_id, received_date, id
    `);

    const soldResult = await pool.query(
      `SELECT oi.product_id, SUM(oi.quantity) AS total_sold
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = ANY($1::text[])
       GROUP BY oi.product_id`,
      [VALID_STATUSES]
    );
    const soldMap = new Map(soldResult.rows.map((r) => [r.product_id, Number(r.total_sold)]));

    const byProduct = new Map();
    for (const b of batchesResult.rows) {
      if (!byProduct.has(b.product_id)) {
        byProduct.set(b.product_id, { product_id: b.product_id, product_name: b.product_name, batches: [] });
      }
      byProduct.get(b.product_id).batches.push({
        id: b.id,
        received_date: b.received_date,
        cost_price: Number(b.cost_price),
        quantity: Number(b.quantity),
        remaining: Number(b.quantity),
      });
    }

    const products = [];
    for (const [productId, info] of byProduct) {
      const totalSold = soldMap.get(productId) || 0;
      let toConsume = totalSold;
      let totalSupplied = 0;
      let remainingValue = 0;

      for (const batch of info.batches) {
        totalSupplied += batch.quantity;
        const consume = Math.min(batch.remaining, toConsume);
        batch.remaining -= consume;
        toConsume -= consume;
        remainingValue += batch.remaining * batch.cost_price;
      }

      const totalRemaining = info.batches.reduce((sum, b) => sum + b.remaining, 0);
      const activeBatch = info.batches.find((b) => b.remaining > 0);

      products.push({
        product_id: productId,
        product_name: info.product_name,
        total_supplied: totalSupplied,
        total_sold: totalSold,
        remaining: totalRemaining,
        remaining_value: remainingValue,
        current_cost_price: activeBatch ? activeBatch.cost_price : null,
        oversold_qty: toConsume > 0 ? toConsume : 0,
        batches: info.batches.map((b) => ({
          id: b.id,
          received_date: b.received_date,
          cost_price: b.cost_price,
          quantity: b.quantity,
          remaining: b.remaining,
        })),
      });
    }

    products.sort((a, b) => a.product_name.localeCompare(b.product_name, 'ru'));

    res.json({ products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось рассчитать остатки склада' });
  }
});

module.exports = router;
