const express = require('express');
const { pool } = require('../db');
const { computeWarehouseStock } = require('./warehouse');

const router = express.Router();

// Заказы, которые считаются продажей для скорости продаж — совпадает с warehouse.js/stats.js
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

const SALES_WINDOW_DAYS = 30; // за сколько последних дней усредняем "Прод./день"

const { CITY_ORDER } = require('../warehouseMapping');

// Модель (s, S) — классическая формула планирования закупа:
//   s (точка заказа)   = Прод./день × дни поставки × (1 + % запаса)   — порог, ниже которого критично
//   S (уровень пополнения) = s + Прод./день × дни поставки            — сколько держать в резерве "на цикл вперёд"
//   К закупу = max(0, S − (Остаток + В пути)), округляем вверх
//   Лишний остаток = max(0, (Остаток + В пути) − s), округляем вниз
// Статус: критично — дней остатка меньше срока поставки; скоро — меньше срока поставки × 1.5; иначе в норме.
// Если продаж не было вообще (Прод./день = 0) — считаем, что закуп не нужен, статус "в норме".
async function computePurchasing() {
  const settingsResult = await pool.query(
    `SELECT lead_time_days, buffer_pct FROM purchasing_settings WHERE id = 1`
  );
  const settingsRow = settingsResult.rows[0] || { lead_time_days: 14, buffer_pct: 30 };
  const leadTimeDays = Number(settingsRow.lead_time_days);
  const bufferPct = Number(settingsRow.buffer_pct);
  const bufferMult = 1 + bufferPct / 100;

  const warehouseRows = await computeWarehouseStock(); // per (товар, склад), только received-партии

  const inTransitResult = await pool.query(
    `SELECT product_id, MAX(product_name) AS product_name, SUM(quantity) AS qty
     FROM product_batches
     WHERE status = 'in_transit'
     GROUP BY product_id`
  );
  const inTransitMap = new Map(inTransitResult.rows.map((r) => [r.product_id, Number(r.qty)]));
  const inTransitNames = new Map(inTransitResult.rows.map((r) => [r.product_id, r.product_name]));

  // SALES_WINDOW_DAYS — внутренняя константа (не пользовательский ввод), поэтому безопасно
  // подставлять её прямо в текст запроса; параметризовать число дней внутри interval через $N
  // в node-pg неудобно (нет прямого приведения integer -> interval).
  const salesResult = await pool.query(
    `SELECT oi.product_id, SUM(oi.quantity) AS qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status = ANY($1::text[])
       AND o.creation_date >= now() - INTERVAL '${SALES_WINDOW_DAYS} days'
     GROUP BY oi.product_id`,
    [VALID_STATUSES]
  );
  const salesMap = new Map(salesResult.rows.map((r) => [r.product_id, Number(r.qty)]));

  // Группируем строки computeWarehouseStock по товару (Закуп считает по товару в целом,
  // не по каждому складу отдельно — "Доступно" ниже просто показывает разбивку по городам)
  const byProduct = new Map();
  for (const row of warehouseRows) {
    if (!byProduct.has(row.product_id)) {
      byProduct.set(row.product_id, {
        product_id: row.product_id,
        product_name: row.product_name,
        cities: [],
        remaining: 0,
        cost_price: null,
      });
    }
    const entry = byProduct.get(row.product_id);
    if (row.remaining > 0) {
      entry.cities.push({ city: row.warehouse, qty: row.remaining });
    }
    entry.remaining += row.remaining;
    if (entry.cost_price === null && row.current_cost_price !== null) {
      entry.cost_price = row.current_cost_price;
    }
  }

  // Товары, у которых есть только партия "в пути" (ни одной received-партии, ни продаж) —
  // иначе их количество "в пути" нигде бы не отобразилось.
  for (const [productId, qty] of inTransitMap) {
    if (!byProduct.has(productId)) {
      byProduct.set(productId, {
        product_id: productId,
        product_name: inTransitNames.get(productId) || productId,
        cities: [],
        remaining: 0,
        cost_price: null,
      });
    }
  }

  const products = [];
  for (const [productId, entry] of byProduct) {
    entry.cities.sort((a, b) => (CITY_ORDER[a.city] ?? 9) - (CITY_ORDER[b.city] ?? 9));

    const soldQty = salesMap.get(productId) || 0;
    const dailySales = soldQty / SALES_WINDOW_DAYS;
    const inTransit = inTransitMap.get(productId) || 0;
    const stockPlusTransit = entry.remaining + inTransit;

    const rawReorderPoint = dailySales * leadTimeDays * bufferMult; // s
    const rawOrderUpTo = rawReorderPoint + dailySales * leadTimeDays; // S = s + спрос за один цикл поставки

    const daysLeft = dailySales > 0 ? stockPlusTransit / dailySales : null;

    let status;
    if (dailySales === 0) {
      status = 'normal';
    } else if (daysLeft < leadTimeDays) {
      status = 'critical';
    } else if (daysLeft < leadTimeDays * 1.5) {
      status = 'soon';
    } else {
      status = 'normal';
    }

    const excessQty = Math.max(0, Math.floor(stockPlusTransit - rawReorderPoint));
    const toPurchase = dailySales > 0 ? Math.max(0, Math.ceil(rawOrderUpTo - stockPlusTransit)) : 0;
    const costPrice = entry.cost_price || 0;

    products.push({
      product_id: productId,
      product_name: entry.product_name,
      available_by_city: entry.cities,
      remaining: entry.remaining,
      daily_sales: Math.round(dailySales * 100) / 100,
      reorder_point: Math.round(rawReorderPoint),
      in_transit: inTransit,
      stock_plus_transit: stockPlusTransit,
      days_left: daysLeft === null ? null : Math.round(daysLeft * 100) / 100,
      excess_qty: excessQty,
      excess_value: excessQty * costPrice,
      to_purchase: toPurchase,
      to_purchase_value: toPurchase * costPrice,
      cost_price: costPrice,
      status,
    });
  }

  const statusOrder = { critical: 0, soon: 1, normal: 2 };
  products.sort((a, b) => {
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    const aDays = a.days_left === null ? Infinity : a.days_left;
    const bDays = b.days_left === null ? Infinity : b.days_left;
    if (aDays !== bDays) return aDays - bDays;
    return a.product_name.localeCompare(b.product_name, 'ru');
  });

  const totals = products.reduce(
    (acc, p) => {
      acc.to_purchase_qty += p.to_purchase;
      acc.to_purchase_value += p.to_purchase_value;
      acc.excess_qty += p.excess_qty;
      acc.excess_value += p.excess_value;
      acc[p.status] += 1;
      return acc;
    },
    { to_purchase_qty: 0, to_purchase_value: 0, excess_qty: 0, excess_value: 0, critical: 0, soon: 0, normal: 0 }
  );

  return {
    settings: { lead_time_days: leadTimeDays, buffer_pct: bufferPct },
    sales_window_days: SALES_WINDOW_DAYS,
    products,
    totals,
  };
}

router.get('/', async (req, res) => {
  try {
    const data = await computePurchasing();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось рассчитать план закупа' });
  }
});

router.put('/settings', async (req, res) => {
  const leadTimeDays = Number(req.body.lead_time_days);
  const bufferPct = Number(req.body.buffer_pct);
  if (!Number.isFinite(leadTimeDays) || leadTimeDays <= 0) {
    return res.status(400).json({ error: 'Дни поставки должны быть положительным числом' });
  }
  if (!Number.isFinite(bufferPct) || bufferPct < 0) {
    return res.status(400).json({ error: 'Процент запаса указан некорректно' });
  }
  try {
    await pool.query(
      `UPDATE purchasing_settings SET lead_time_days = $1, buffer_pct = $2, updated_at = now() WHERE id = 1`,
      [leadTimeDays, bufferPct]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить настройки' });
  }
});

module.exports = router;
