const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Склады, которые считаются "самовыкупами" — их продажи не входят в основную статистику
// на Главной, а показываются отдельно на странице "Самовыкупы".
const SELF_BUY_WAREHOUSES = ['Талдыкорган', 'Юбилейное'];

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

router.get('/summary', async (req, res) => {
  const { from, to, mode } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT
         (creation_date + interval '5 hours')::date AS day,
         COUNT(*) AS orders_count,
         SUM(total_price) AS total_revenue
       FROM orders
       WHERE creation_date >= $1::timestamp - interval '5 hours'
         AND creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
         AND ${mode === 'selfbuy' ? 'origin_city = ANY($3::text[])' : '(origin_city IS NULL OR NOT (origin_city = ANY($3::text[])))'}
       GROUP BY day
       ORDER BY day`,
      [from, to, SELF_BUY_WAREHOUSES]
    );
    res.json({ days: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить статистику' });
  }
});

router.get('/products', async (req, res) => {
  const { from, to, mode } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT
         oi.product_id,
         oi.product_name,
         SUM(oi.quantity) AS total_quantity,
         SUM(oi.total_price) AS total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
         AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
         AND ${mode === 'selfbuy' ? 'o.origin_city = ANY($3::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($3::text[])))'}
       GROUP BY oi.product_id, oi.product_name
       ORDER BY total_revenue DESC`,
      [from, to, SELF_BUY_WAREHOUSES]
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список товаров' });
  }
});

// Ставка налога — как в помесячном отчёте (Отчёт → Основной отчёт), 3% с чистой выручки.
const TAX_RATE = 0.03;

// Возвращает {день -> себестоимость проданного (FIFO)} для конкретного товара. Логика та же,
// что в costEngine.computeCosts, но: а) только для одного товара, б) с группировкой по дню
// (а не по месяцу) — причём по дате ЗАКАЗА (как и выручка), а не по дате операции в Excel-отчёте
// Kaspi Pay (эти две даты не всегда совпадают день в день — иначе выручка и прибыль одного и того
// же заказа "разъезжались" бы по разным дням на графике), в) фильтр по городам — как в остальных
// ручках этого файла (mode selfbuy/main), а не через список конкретных городов.
async function computeProductDailyCost(productId, mode) {
  const batchesResult = await pool.query(
    `SELECT warehouse, cost_price, quantity FROM product_batches WHERE product_id = $1 ORDER BY warehouse, received_date, id`,
    [productId]
  );
  const batchesByWarehouse = new Map();
  for (const b of batchesResult.rows) {
    if (!batchesByWarehouse.has(b.warehouse)) batchesByWarehouse.set(b.warehouse, []);
    batchesByWarehouse.get(b.warehouse).push({ cost_price: Number(b.cost_price), remaining: Number(b.quantity) });
  }

  const soldResult = await pool.query(
    `WITH kpt_agg AS (
       SELECT order_number, MIN(operation_date) AS operation_date
       FROM kaspi_pay_transactions
       WHERE operation_type = 'Покупка'
       GROUP BY order_number
     )
     SELECT oi.quantity, o.origin_city AS warehouse,
            to_char((o.creation_date + interval '5 hours')::date, 'YYYY-MM-DD') AS day
     FROM kpt_agg ka
     JOIN orders o ON o.code = ka.order_number
     JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = $1
     WHERE ${mode === 'selfbuy' ? 'o.origin_city = ANY($2::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($2::text[])))'}
     ORDER BY o.origin_city, o.creation_date ASC`,
    [productId, SELF_BUY_WAREHOUSES]
  );

  const costByDay = {};
  for (const row of soldResult.rows) {
    const batches = batchesByWarehouse.get(row.warehouse);
    if (!batches) continue; // партий для этого склада нет — себестоимость неизвестна, пропускаем
    let qty = Number(row.quantity);
    for (const batch of batches) {
      if (qty <= 0) break;
      if (batch.remaining <= 0) continue;
      const consume = Math.min(batch.remaining, qty);
      batch.remaining -= consume;
      qty -= consume;
      costByDay[row.day] = (costByDay[row.day] || 0) + consume * batch.cost_price;
    }
  }
  return costByDay;
}

// Возвращает {день -> {purchasesAmount, returnsAmount, commission, delivery}} для товара.
// Важно: Kaspi Pay выставляет комиссию/доставку на весь ЗАКАЗ целиком, а не на конкретный товар
// в нём. Если в заказе несколько разных товаров — делим сумму операции пропорционально доле
// этого товара в общей сумме позиций заказа (по order_items.total_price). Для заказов с одним
// товаром (подавляющее большинство) доля = 100%, то есть цифры точные.
async function computeProductDailyKaspiPay(productId, mode) {
  const result = await pool.query(
    `WITH kpt_agg AS (
       SELECT order_number, operation_type, MIN(operation_date) AS operation_date,
              SUM(amount) AS amount, SUM(commission_total) AS commission_total, SUM(delivery_cost) AS delivery_cost
       FROM kaspi_pay_transactions
       GROUP BY order_number, operation_type
     ),
     order_totals AS (
       SELECT order_id, SUM(total_price) AS order_revenue
       FROM order_items
       GROUP BY order_id
     )
     SELECT
       to_char((o.creation_date + interval '5 hours')::date, 'YYYY-MM-DD') AS day,
       ka.operation_type,
       ka.amount,
       ka.commission_total,
       ka.delivery_cost,
       oi.total_price AS product_revenue,
       ot.order_revenue
     FROM kpt_agg ka
     JOIN orders o ON o.code = ka.order_number
     JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = $1
     JOIN order_totals ot ON ot.order_id = o.id
     WHERE ${mode === 'selfbuy' ? 'o.origin_city = ANY($2::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($2::text[])))'}
     ORDER BY o.creation_date`,
    [productId, SELF_BUY_WAREHOUSES]
  );

  const byDay = {};
  for (const row of result.rows) {
    const orderRevenue = Number(row.order_revenue);
    const share = orderRevenue > 0 ? Number(row.product_revenue) / orderRevenue : 0;
    const allocatedAmount = Number(row.amount) * share;
    const allocatedCommission = Number(row.commission_total) * share;
    const allocatedDelivery = Number(row.delivery_cost) * share;

    if (!byDay[row.day]) byDay[row.day] = { purchasesAmount: 0, returnsAmount: 0, commission: 0, delivery: 0 };
    if (row.operation_type === 'Возврат') {
      byDay[row.day].returnsAmount += allocatedAmount;
    } else {
      byDay[row.day].purchasesAmount += allocatedAmount;
    }
    byDay[row.day].commission += allocatedCommission;
    byDay[row.day].delivery += allocatedDelivery;
  }
  return byDay;
}

router.get('/product/:productId', async (req, res) => {
  const { productId } = req.params;
  const { from, to, mode } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const [revenueResult, kaspiPayByDay, costByDay] = await Promise.all([
      pool.query(
        `SELECT
           to_char((oi.creation_date + interval '5 hours')::date, 'YYYY-MM-DD') AS day,
           SUM(oi.quantity) AS total_quantity,
           SUM(oi.total_price) AS total_revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.product_id = $1
           AND oi.creation_date >= $2::timestamp - interval '5 hours'
           AND oi.creation_date < $3::timestamp - interval '5 hours' + interval '1 day'
           AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
           AND ${mode === 'selfbuy' ? 'o.origin_city = ANY($4::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($4::text[])))'}
         GROUP BY day
         ORDER BY day`,
        [productId, from, to, SELF_BUY_WAREHOUSES]
      ),
      computeProductDailyKaspiPay(productId, mode),
      computeProductDailyCost(productId, mode),
    ]);

    const dayMap = new Map();
    for (const r of revenueResult.rows) {
      dayMap.set(r.day, { day: r.day, total_quantity: Number(r.total_quantity), total_revenue: Number(r.total_revenue) });
    }

    const ensureDay = (day) => {
      if (!dayMap.has(day)) dayMap.set(day, { day, total_quantity: 0, total_revenue: 0 });
      return dayMap.get(day);
    };

    for (const [day, kp] of Object.entries(kaspiPayByDay)) {
      if (day < from || day > to) continue;
      const entry = ensureDay(day);
      entry.hasKaspiData = true; // отметка, что за этот день реально есть данные из Excel-отчёта
      Object.assign(entry, {
        kaspi_purchases: kp.purchasesAmount,
        kaspi_returns: kp.returnsAmount,
        commission: kp.commission,
        delivery: kp.delivery,
      });
    }

    for (const [day, cost] of Object.entries(costByDay)) {
      if (day < from || day > to) continue;
      ensureDay(day).cost = cost;
    }

    const days = Array.from(dayMap.values())
      .map((d) => {
        // Если за этот день ещё не загружали Excel-отчёт Kaspi Pay — комиссии/доставки/себестоимости
        // попросту неоткуда взять. Раньше в этом случае чистая прибыль считалась как 0, что выглядело
        // как "в этот день заработали 0 тенге" — на самом деле это означает "нет данных", а не
        // "нулевая прибыль". Отдаём net_profit: null — на графике это будет разрывом, а не ложным нулём.
        if (!d.hasKaspiData) {
          return { day: d.day, total_quantity: d.total_quantity, total_revenue: d.total_revenue, net_profit: null };
        }

        const netRevenue = (d.kaspi_purchases || 0) - (d.kaspi_returns || 0);
        const cost = d.cost || 0;
        const commission = d.commission || 0;
        const delivery = d.delivery || 0;
        const taxes = netRevenue > 0 ? netRevenue * TAX_RATE : 0;
        const netProfit = netRevenue - cost - commission - delivery - taxes;
        return {
          day: d.day,
          total_quantity: d.total_quantity,
          total_revenue: d.total_revenue,
          net_profit: netProfit,
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day));

    res.json({ days });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить статистику по товару' });
  }
});

module.exports = router;
