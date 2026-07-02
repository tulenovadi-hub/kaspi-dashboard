const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Заказы, которые реально считаются продажей (совпадает с логикой в stats.js)
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];
const COMPLETED_STATUSES = ['COMPLETED'];
const IN_PROGRESS_STATUSES = ['ACCEPTED_BY_MERCHANT', 'APPROVED_BY_BANK'];

// Заказы до этой даты не учитываем на Складе — остатки на 1 июня вводятся вручную через
// партии на странице "Поставки", поэтому продажи до этой даты не должны их списывать ещё раз.
const STOCK_CUTOFF_DATE = '2026-06-01';

// Считает остатки по методу FIFO отдельно для каждого склада (города):
// партии одного города списываются только продажами, отгруженными с этого же города
// (Kaspi возвращает город отгрузки в attributes.originAddress.city.name — сохраняем
// его в orders.origin_city при синхронизации).
router.get('/', async (req, res) => {
  try {
    const batchesResult = await pool.query(`
      SELECT id, product_id, product_name, cost_price, warehouse, quantity, received_date
      FROM product_batches
      ORDER BY product_id, warehouse, received_date, id
    `);

    // Заказы без origin_city — это самовывоз напрямую у продавца (DELIVERY_PICKUP, не через Kaspi
    // Delivery), Kaspi не присылает по ним точку отгрузки. Владелец подтвердил, что это склад
    // "Юбилейное", который на сайте учитывать не нужно, поэтому такие заказы просто исключаем.
    const soldResult = await pool.query(
      `SELECT oi.product_id, MAX(oi.product_name) AS product_name, o.origin_city AS warehouse,
              SUM(CASE WHEN o.status = ANY($2::text[]) THEN oi.quantity ELSE 0 END) AS completed_qty,
              SUM(CASE WHEN o.status = ANY($3::text[]) THEN oi.quantity ELSE 0 END) AS in_progress_qty
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = ANY($1::text[])
         AND o.origin_city IS NOT NULL
         AND o.creation_date >= $4::date
       GROUP BY oi.product_id, o.origin_city`,
      [VALID_STATUSES, COMPLETED_STATUSES, IN_PROGRESS_STATUSES, STOCK_CUTOFF_DATE]
    );
    const soldMap = new Map(
      soldResult.rows.map((r) => [
        `${r.product_id}::${r.warehouse}`,
        { completed: Number(r.completed_qty), inProgress: Number(r.in_progress_qty) },
      ])
    );
    const soldProductNames = new Map(soldResult.rows.map((r) => [r.product_id, r.product_name]));

    // Группируем партии по паре (товар, склад) — у каждого склада своя FIFO-очередь
    const byKey = new Map();
    for (const b of batchesResult.rows) {
      const key = `${b.product_id}::${b.warehouse}`;
      if (!byKey.has(key)) {
        byKey.set(key, { product_id: b.product_id, product_name: b.product_name, warehouse: b.warehouse, batches: [] });
      }
      byKey.get(key).batches.push({
        id: b.id,
        received_date: b.received_date,
        cost_price: Number(b.cost_price),
        quantity: Number(b.quantity),
        remaining: Number(b.quantity),
      });
    }

    const products = [];
    for (const [key, info] of byKey) {
      const sold = soldMap.get(key) || { completed: 0, inProgress: 0 };
      // Списываем со склада и завершённые, и ещё обрабатываемые заказы — товар физически уже уехал
      // в обоих случаях, просто в разных колонках показываем для наглядности.
      let toConsume = sold.completed + sold.inProgress;
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
        product_id: info.product_id,
        product_name: info.product_name,
        warehouse: info.warehouse,
        total_supplied: totalSupplied,
        total_sold: sold.completed,
        in_progress: sold.inProgress,
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

    // Продажи с городом, для которого вообще нет ни одной партии — это тоже важно показать,
    // иначе продажи "потеряются" молча. Добавляем их отдельными строками с нулевым остатком.
    for (const [key, sold] of soldMap) {
      const [productId, warehouse] = key.split('::');
      const alreadyListed = products.some((p) => p.product_id === productId && p.warehouse === warehouse);
      if (!alreadyListed) {
        products.push({
          product_id: productId,
          product_name: soldProductNames.get(productId) || productId,
          warehouse,
          total_supplied: 0,
          total_sold: sold.completed,
          in_progress: sold.inProgress,
          remaining: 0,
          remaining_value: 0,
          current_cost_price: null,
          oversold_qty: sold.completed + sold.inProgress,
          batches: [],
        });
      }
    }

    products.sort((a, b) => a.product_name.localeCompare(b.product_name, 'ru') || a.warehouse.localeCompare(b.warehouse, 'ru'));

    res.json({ products, cutoff_date: STOCK_CUTOFF_DATE });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось рассчитать остатки склада' });
  }
});

module.exports = router;
