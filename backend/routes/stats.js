const express = require('express');
const { pool } = require('../db');
const { STOCK_CUTOFF_DATE } = require('../constants');

const router = express.Router();

const { MAIN_CITIES, SELF_BUY_CITIES } = require('../warehouseMapping');

// Города для запрошенного режима. Раньше "основной магазин" здесь означал "всё, что НЕ самовыкупы"
// (включая заказы с неизвестной точкой продаж), а в "Отчёте" — явный список Алматы и Астаны.
// Из-за этой разницы один и тот же заказ мог попасть на Главную, но пропасть из Отчёта.
// Теперь оба экрана спрашивают один и тот же список у справочника складов.
// Заказ с неизвестной точкой не относится ни к одному режиму — он не потеряется молча,
// его считает отдельный счётчик в /api/orders.
function citiesFor(mode) {
  return mode === 'selfbuy' ? SELF_BUY_CITIES : MAIN_CITIES;
}

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// Очень лёгкая проверка для открытой Главной. Браузер вызывает её часто и перезагружает
// тяжёлые графики/прибыль только когда набор заказов действительно изменился.
router.get('/revision', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) AS orders_count,
             COUNT(*) FILTER (
               WHERE status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
             ) AS active_orders_count,
             COALESCE(SUM(total_price) FILTER (
               WHERE status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
             ), 0) AS active_revenue,
             MAX(creation_date) AS latest_creation,
             (
               SELECT COUNT(*) FROM order_items oi
               WHERE oi.creation_date >= now() - interval '2 days'
             ) AS items_count
      FROM orders
      WHERE creation_date >= now() - interval '2 days'
    `);
    const row = result.rows[0];
    res.json({
      orders_count: Number(row.orders_count),
      active_orders_count: Number(row.active_orders_count),
      active_revenue: Number(row.active_revenue),
      items_count: Number(row.items_count),
      latest_creation: row.latest_creation || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось проверить обновление заказов' });
  }
});

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
         AND origin_city = ANY($3::text[])
       GROUP BY day
       ORDER BY day`,
      [from, to, citiesFor(mode)]
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
      // orders_count — число ЗАКАЗОВ с этим товаром, а не штук: карточка "Количество заказов"
      // на Главной считает именно заказы, и разбивка под ней обязана мерить то же самое.
      // COUNT(DISTINCT o.id), потому что в одном заказе может быть несколько позиций.
      `SELECT
         oi.product_id,
         oi.product_name,
         SUM(oi.quantity) AS total_quantity,
         SUM(oi.total_price) AS total_revenue,
         COUNT(DISTINCT o.id) AS orders_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
         AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
         AND o.origin_city = ANY($3::text[])
       GROUP BY oi.product_id, oi.product_name
       ORDER BY total_revenue DESC`,
      [from, to, citiesFor(mode)]
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список товаров' });
  }
});

// Ставка налога — как в помесячном отчёте (Отчёт → Основной отчёт), 3% с чистой выручки.
const TAX_RATE = 0.03;

// Считает себестоимость (FIFO) отдельно для каждой пары "заказ+товар" — в отличие от
// costEngine.computeCosts (который суммирует себестоимость на весь заказ целиком), здесь
// нужна себестоимость именно конкретного товара в заказе, без всякой аллокации: FIFO и так
// точно знает, сколько стоил именно этот товар (в отличие от комиссии/доставки, которые
// Kaspi Pay выставляет на весь заказ и делить их по товарам можно только пропорционально).
// Обрабатывает ВСЮ историю (а не только запрошенный период) — иначе некорректно определится,
// какая партия к этому моменту уже была списана более ранними продажами.
async function computeCostsByOrderItem(mode) {
  // Только прибывшие партии — тот же фильтр, что в costEngine.computeCosts и computeWarehouseStock.
  // Партия "в пути" физически не на складе, списывать с неё себестоимость нельзя.
  const batchesResult = await pool.query(`
    SELECT product_id, warehouse, cost_price, quantity, received_date
    FROM product_batches
    WHERE status = 'received'
    ORDER BY product_id, warehouse, received_date, id
  `);
  const batchesByKey = new Map();
  const firstBatchPriceByKey = new Map(); // цена самой первой поставки — для заказов до даты отсечки
  for (const b of batchesResult.rows) {
    const key = `${b.product_id}::${b.warehouse}`;
    if (!batchesByKey.has(key)) batchesByKey.set(key, []);
    batchesByKey.get(key).push({ cost_price: Number(b.cost_price), remaining: Number(b.quantity) });
    if (!firstBatchPriceByKey.has(key)) firstBatchPriceByKey.set(key, Number(b.cost_price));
  }

  const soldResult = await pool.query(
    `WITH relevant_orders AS (
       -- Сохраняем прежнюю FIFO-историю по всем покупкам Kaspi Pay, включая заказы,
       -- которые позднее стали возвратами. Плюс добавляем свежие активные заказы, которых
       -- ещё нет в Excel: их себестоимость уже известна и не должна прогнозироваться маржой.
       SELECT o.id, o.code AS order_number, o.origin_city AS warehouse, o.creation_date,
              CASE WHEN EXISTS (
                SELECT 1 FROM kaspi_pay_transactions kpt
                WHERE kpt.order_number = o.code AND kpt.operation_type = 'Покупка'
              ) THEN true ELSE false END AS has_purchase
       FROM orders o
       WHERE o.origin_city = ANY($1::text[])
         AND (
           o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
           OR EXISTS (
             SELECT 1 FROM kaspi_pay_transactions kpt
             WHERE kpt.order_number = o.code AND kpt.operation_type = 'Покупка'
           )
         )
     )
     SELECT oi.product_id, ro.warehouse, oi.quantity, ro.order_number, ro.has_purchase,
            ro.creation_date
     FROM relevant_orders ro
     JOIN order_items oi ON oi.order_id = ro.id
     ORDER BY ro.warehouse, ro.creation_date ASC`,
    [citiesFor(mode)]
  );

  // "order_number::product_id" -> себестоимость (только по операциям "Покупка" —
  // себестоимость возврата, как и везде в приложении, не вычитается из прибыли).
  const costByOrderItem = {};
  const knownOrders = new Set(); // заказы, по которым есть покупка в Excel-отчёте

  for (const row of soldResult.rows) {
    if (row.has_purchase) knownOrders.add(row.order_number);

    const key = `${row.product_id}::${row.warehouse}`;
    const itemKey = `${row.order_number}::${row.product_id}`;

    // Заказ старше даты отсечки остатков — не списываем партии на "Поставках" (это снимок
    // остатков на дату отсечки), а оцениваем по цене самой первой поставки этого товара.
    if (new Date(row.creation_date) < new Date(STOCK_CUTOFF_DATE)) {
      const price = firstBatchPriceByKey.get(key);
      if (price === undefined) continue;
      costByOrderItem[itemKey] = (costByOrderItem[itemKey] || 0) + Number(row.quantity) * price;
      continue;
    }

    const batches = batchesByKey.get(key);
    if (!batches) continue; // партий для этого склада нет — себестоимость неизвестна, пропускаем

    let qty = Number(row.quantity);
    let cost = 0;
    for (const batch of batches) {
      if (qty <= 0) break;
      if (batch.remaining <= 0) continue;
      const consume = Math.min(batch.remaining, qty);
      batch.remaining -= consume;
      qty -= consume;
      cost += consume * batch.cost_price;
    }
    // Продано больше, чем приехало — оцениваем по цене последней прибывшей партии
    // (см. подробный комментарий в costEngine.computeCosts).
    if (qty > 0) cost += qty * batches[batches.length - 1].cost_price;
    costByOrderItem[itemKey] = (costByOrderItem[itemKey] || 0) + cost;
  }

  return { costByOrderItem, knownOrders };
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseOptionalMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function forecastUnknownItemProfit({
  revenue, cost, commissionRate, apiDeliveryCost, orderShare, deliveryPerUnit, quantity,
}) {
  const exactDelivery = parseOptionalMoney(apiDeliveryCost);
  const commission = revenue * commissionRate;
  const delivery = exactDelivery === null
    ? deliveryPerUnit * Math.max(1, Number(quantity) || 1)
    : exactDelivery * orderShare;
  const taxes = revenue > 0 ? revenue * TAX_RATE : 0;
  return {
    profit: revenue - cost - commission - delivery - taxes,
    commission,
    delivery,
    usedApiDelivery: exactDelivery !== null,
  };
}

function returnProfitImpact({ amount, commissionTotal, deliveryCost }) {
  const profitDelta = amount + commissionTotal + deliveryCost + (-amount * TAX_RATE);
  return Math.max(0, -profitDelta);
}

// Устойчивый прогноз расходов свежего заказа. Не прогнозируем всю прибыль одной средней
// маржой: себестоимость, налог и доставка уже известны. Из истории нужны только комиссия
// Kaspi и редкий запасной вариант для доставки, если API заказа не прислал точную сумму.
// Медиана защищает от единичных аномальных строк, а маленькая выборка товара плавно
// подтягивается к среднему магазина, вместо скачка после каждой новой операции.
async function computeHistoricalExpenseModel(from, to, mode, kptByOrder, costData) {
  const itemsResult = await pool.query(
    `SELECT oi.product_id, oi.quantity, oi.total_price, o.code AS order_number, o.id AS order_id
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
       AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
       AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
       AND o.origin_city = ANY($3::text[])`,
    [from, to, citiesFor(mode)]
  );

  const orderRevenueMap = new Map();
  for (const it of itemsResult.rows) {
    orderRevenueMap.set(it.order_id, (orderRevenueMap.get(it.order_id) || 0) + Number(it.total_price));
  }

  const commissionSamples = [];
  const deliverySamples = [];
  const costRateSamples = [];
  const byProduct = new Map();

  for (const it of itemsResult.rows) {
    const kptRows = kptByOrder.get(it.order_number);
    const purchases = (kptRows || []).filter((r) => r.operation_type === 'Покупка');
    if (purchases.length === 0) continue;

    const orderRevenue = orderRevenueMap.get(it.order_id) || 0;
    const share = orderRevenue > 0 ? Number(it.total_price) / orderRevenue : 0;
    let purchaseAmount = 0;
    let commission = 0;
    let delivery = 0;
    for (const row of purchases) {
      const allocatedAmount = Number(row.amount) * share;
      commission += -Number(row.commission_total) * share;
      delivery += -Number(row.delivery_cost) * share;
      purchaseAmount += allocatedAmount;
    }
    if (purchaseAmount <= 0) continue;

    const commissionRate = clamp(commission / purchaseAmount, 0, 0.5);
    const quantity = Math.max(1, Number(it.quantity) || 1);
    const deliveryPerUnit = clamp(delivery / quantity, 0, 10000);
    const costKey = `${it.order_number}::${it.product_id}`;
    const hasKnownCost = Object.prototype.hasOwnProperty.call(costData.costByOrderItem, costKey);
    const costRate = hasKnownCost
      ? clamp(Number(costData.costByOrderItem[costKey]) / purchaseAmount, 0, 0.95)
      : null;
    commissionSamples.push(commissionRate);
    deliverySamples.push(deliveryPerUnit);
    if (costRate !== null) costRateSamples.push(costRate);

    const stat = byProduct.get(it.product_id) || { commission: [], delivery: [], costRate: [] };
    stat.commission.push(commissionRate);
    stat.delivery.push(deliveryPerUnit);
    if (costRate !== null) stat.costRate.push(costRate);
    byProduct.set(it.product_id, stat);
  }

  const overallCommissionRate = median(commissionSamples) || 0;
  const overallCommissionLow = percentile(commissionSamples, 0.1) ?? overallCommissionRate;
  const overallCommissionHigh = percentile(commissionSamples, 0.9) ?? overallCommissionRate;
  const overallDeliveryPerUnit = median(deliverySamples) || 0;
  const overallCostRate = median(costRateSamples) || 0;
  const byProductModel = new Map();
  for (const [productId, stat] of byProduct) {
    const sampleSize = stat.commission.length;
    // До 12 наблюдений собственную медиану считаем ещё шумной и смешиваем с магазином.
    const ownWeight = Math.min(1, sampleSize / 12);
    const ownCommission = median(stat.commission);
    const ownCommissionLow = percentile(stat.commission, 0.1);
    const ownCommissionHigh = percentile(stat.commission, 0.9);
    const ownDelivery = median(stat.delivery);
    const ownCostRate = median(stat.costRate);
    byProductModel.set(productId, {
      commissionRate:
        (ownCommission === null ? overallCommissionRate : ownCommission * ownWeight + overallCommissionRate * (1 - ownWeight)),
      commissionLow:
        (ownCommissionLow === null ? overallCommissionLow : ownCommissionLow * ownWeight + overallCommissionLow * (1 - ownWeight)),
      commissionHigh:
        (ownCommissionHigh === null ? overallCommissionHigh : ownCommissionHigh * ownWeight + overallCommissionHigh * (1 - ownWeight)),
      deliveryPerUnit:
        (ownDelivery === null ? overallDeliveryPerUnit : ownDelivery * ownWeight + overallDeliveryPerUnit * (1 - ownWeight)),
      costRate:
        (ownCostRate === null ? overallCostRate : ownCostRate * ownWeight + overallCostRate * (1 - ownWeight)),
      sampleSize,
    });
  }

  return {
    overallCommissionRate,
    overallCommissionLow,
    overallCommissionHigh,
    overallDeliveryPerUnit,
    overallCostRate,
    byProduct: byProductModel,
  };
}

// Оценка будущих возвратов по "созревшим" заказам: берём продажи 45–180 дней назад, чтобы у
// покупателя уже было время оформить возврат. Считается не просто сумма возврата, а его чистое
// влияние на прибыль с учётом возврата комиссии/доставки и уменьшения налога. Товарная ставка
// сглаживается к общей по магазину, поэтому один возврат не делает редкий SKU убыточным навсегда.
async function computeReturnReserveModel(mode, kptByOrder) {
  const today = todayAlmaty();
  const historyFrom = addDays(today, -180);
  const historyTo = addDays(today, -45);
  const itemsResult = await pool.query(
    `SELECT oi.product_id, oi.total_price, o.code AS order_number, o.id AS order_id
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
       AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
       AND o.origin_city = ANY($3::text[])`,
    [historyFrom, historyTo, citiesFor(mode)]
  );

  const orderRevenue = new Map();
  for (const it of itemsResult.rows) {
    orderRevenue.set(it.order_id, (orderRevenue.get(it.order_id) || 0) + Number(it.total_price));
  }

  let overallRevenue = 0;
  let overallLoss = 0;
  const byProduct = new Map();
  for (const it of itemsResult.rows) {
    const rows = kptByOrder.get(it.order_number) || [];
    const purchases = rows.filter((r) => r.operation_type === 'Покупка');
    if (purchases.length === 0) continue;
    const total = orderRevenue.get(it.order_id) || 0;
    const share = total > 0 ? Number(it.total_price) / total : 0;
    const purchaseRevenue = purchases.reduce((sum, row) => sum + Number(row.amount) * share, 0);
    if (purchaseRevenue <= 0) continue;

    let returnImpact = 0;
    for (const row of rows) {
      if (row.operation_type !== 'Возврат') continue;
      const amount = Number(row.amount) * share; // отрицательная сумма возврата
      returnImpact += returnProfitImpact({
        amount,
        commissionTotal: Number(row.commission_total) * share,
        deliveryCost: Number(row.delivery_cost) * share,
      });
    }

    overallRevenue += purchaseRevenue;
    overallLoss += returnImpact;
    const stat = byProduct.get(it.product_id) || { revenue: 0, loss: 0, orders: new Set() };
    stat.revenue += purchaseRevenue;
    stat.loss += returnImpact;
    stat.orders.add(it.order_number);
    byProduct.set(it.product_id, stat);
  }

  const overallRate = overallRevenue > 0 ? clamp(overallLoss / overallRevenue, 0, 0.25) : 0;
  const rateByProduct = new Map();
  for (const [productId, stat] of byProduct) {
    const ownRate = stat.revenue > 0 ? clamp(stat.loss / stat.revenue, 0, 0.25) : overallRate;
    const ownWeight = Math.min(1, stat.orders.size / 30);
    rateByProduct.set(productId, ownRate * ownWeight + overallRate * (1 - ownWeight));
  }
  return { overallRate, rateByProduct, historyFrom, historyTo };
}

// Фактический маркетинг по дням и историческая доля каждого из трёх источников в выручке.
// Источники считаются отдельно: реклама может быть загружена по вчера, а бонусы — только по
// позавчера. После последней фактической даты каждого источника недостающий расход оценивается
// как его доля в выручке за последние 60 дней с данными × выручка нового дня.
//
// Важная деталь: нулевые строки тоже сохраняются Tampermonkey-скриптом, поэтому MAX(expense_date)
// означает именно конец выгруженного периода, а не последний день, когда реально были траты.
async function fetchMarketingData(from, to) {
  const [actualResult, historyResult] = await Promise.all([
    pool.query(
      `SELECT source, to_char(expense_date, 'YYYY-MM-DD') AS day, SUM(total) AS total
       FROM (
         SELECT 'ads' AS source, expense_date, cost AS total FROM ad_expenses
         UNION ALL
         SELECT 'bonuses' AS source, expense_date, bonus_amount AS total FROM bonus_expenses
         UNION ALL
         SELECT 'reviews' AS source, expense_date, bonus_amount AS total FROM review_bonus_expenses
       ) marketing
       WHERE expense_date BETWEEN $1 AND $2
       GROUP BY source, expense_date
       ORDER BY expense_date`,
      [from, to]
    ),
    pool.query(
      `WITH source_daily AS (
         SELECT 'ads' AS source, expense_date::date AS day, SUM(cost) AS total
         FROM ad_expenses GROUP BY expense_date
         UNION ALL
         SELECT 'bonuses' AS source, expense_date::date AS day, SUM(bonus_amount) AS total
         FROM bonus_expenses GROUP BY expense_date
         UNION ALL
         SELECT 'reviews' AS source, expense_date::date AS day, SUM(bonus_amount) AS total
         FROM review_bonus_expenses GROUP BY expense_date
       ), with_latest AS (
         SELECT source, day, total, MAX(day) OVER (PARTITION BY source) AS latest_day
         FROM source_daily
       ), source_history AS (
         SELECT source, latest_day,
                MIN(day) FILTER (WHERE day >= latest_day - 59) AS history_start,
                COALESCE(SUM(total) FILTER (WHERE day >= latest_day - 59), 0) AS historical_cost
         FROM with_latest
         GROUP BY source, latest_day
       )
       SELECT h.source, to_char(h.latest_day, 'YYYY-MM-DD') AS latest_day,
              h.historical_cost,
              COALESCE((
                SELECT SUM(o.total_price)
                FROM orders o
                WHERE (o.creation_date + interval '5 hours')::date
                        BETWEEN h.history_start AND h.latest_day
                  AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
                  AND o.origin_city = ANY($1::text[])
              ), 0) AS historical_revenue
       FROM source_history h`,
      [MAIN_CITIES]
    ),
  ]);

  const byDay = new Map();
  for (const r of actualResult.rows) {
    const day = String(r.day).slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + Number(r.total));
  }

  const sources = historyResult.rows.map((r) => {
    const revenue = Number(r.historical_revenue);
    return {
      source: r.source,
      latestDay: String(r.latest_day).slice(0, 10),
      ratio: revenue > 0 ? Number(r.historical_cost) / revenue : null,
    };
  });

  return { byDay, sources };
}

// Добавляет к факту прогноз только в хвосте ПОСЛЕ последней выгруженной даты каждого источника.
// Пропуски внутри уже выгруженного диапазона не заполняем: это могут быть настоящие нулевые дни.
// Будущие дни тоже не прогнозируем, даже если пользователь выбрал период до конца месяца.
function addMarketingForecast(marketingData, revenueByDay, from, to) {
  const byDay = new Map(marketingData.byDay);
  const estimatedDays = new Set();
  const today = todayAlmaty();
  const lastDay = to < today ? to : today;
  let estimatedTotal = 0;

  for (const source of marketingData.sources) {
    if (!source.latestDay || source.ratio === null || source.latestDay >= lastDay) continue;
    const firstMissingDay = addDays(source.latestDay, 1);
    const startDay = firstMissingDay > from ? firstMissingDay : from;

    for (let d = startDay; d <= lastDay; d = addDays(d, 1)) {
      const revenue = revenueByDay.get(d) || 0;
      if (revenue <= 0) continue;
      const estimate = revenue * source.ratio;
      byDay.set(d, (byDay.get(d) || 0) + estimate);
      estimatedTotal += estimate;
      estimatedDays.add(d);
    }
  }

  return { byDay, estimatedDays, estimatedTotal };
}

// Операционные расходы из гугл-таблицы (страница "Расходы"): ровно те же две категории, что
// вычитаются из чистой прибыли в "Отчёте" (routes/reports.js) — иначе цифра на Главной и цифра
// в отчёте за тот же месяц разъехались бы. "Товар" сюда не входит (уже учтён себестоимостью по
// партиям FIFO), "Вывод" тоже (дивиденды собственника, а не расход бизнеса), "Логистика" — это
// карго из Китая, она входит в себестоимость партии, а не в отдельный расход.
const PROFIT_EXPENSE_CATEGORIES = ['Прочие затраты', 'Упаковка'];

// Подтверждённые возвраты берём ровно из загруженного Excel Kaspi Pay и относим к дате
// операции из отчёта. Будущие возвраты не прогнозируем. Сумма продаж на Главной при этом
// не меняется: возврат влияет только на чистую прибыль, как отдельно попросила владелец.
async function fetchConfirmedReturnsByDay(from, to, mode) {
  const result = await pool.query(
    `SELECT to_char(kpt.operation_date::date, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(-kpt.amount), 0) AS gross_amount,
            COALESCE(SUM(
              -(
                kpt.amount
                + kpt.commission_total
                + kpt.delivery_cost
                + (-kpt.amount * $4::numeric)
              )
            ), 0) AS profit_impact
     FROM kaspi_pay_transactions kpt
     JOIN orders o ON o.code = kpt.order_number
     WHERE kpt.operation_type = 'Возврат'
       AND kpt.operation_date >= $1::date
       AND kpt.operation_date < $2::date + interval '1 day'
       AND o.origin_city = ANY($3::text[])
     GROUP BY kpt.operation_date::date
     ORDER BY kpt.operation_date::date`,
    [from, to, citiesFor(mode), TAX_RATE]
  );

  return new Map(result.rows.map((row) => [row.day, {
    grossAmount: Number(row.gross_amount) || 0,
    profitImpact: Math.max(0, Number(row.profit_impact) || 0),
  }]));
}

// Сегодняшняя дата по Алматы (UTC+5) — тот же сдвиг, что у выручки в SQL выше.
// Date.now() всегда в UTC, поэтому от часового пояса сервера (Render живёт в UTC) не зависит.
function todayAlmaty() {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Делитель для месяца: сколько его дней УЖЕ прошло. У закрытого месяца это вся его длина,
// у текущего — сегодняшнее число, у будущего — ноль.
//
// Почему не всегда полная длина: в незаконченном месяце и расходы записаны только за
// прошедшие дни. Деление сентябрьских 60 000 на 30 дней 10 сентября дало бы 2 000/день,
// хотя по факту эти 60 000 потрачены за 10 дней — то есть 6 000/день. Сравнение с прошлым
// периодом при этом занижало текущий месяц просто потому, что он ещё не кончился.
function elapsedDaysInMonth(month, today) {
  const [year, monthNumber] = String(month).split('-').map(Number);
  // День 0 следующего месяца = последний день этого, то есть длина месяца (28/29/30/31).
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const currentMonth = today.slice(0, 7);
  if (month < currentMonth) return daysInMonth;
  if (month > currentMonth) return 0;
  return Number(today.slice(8, 10));
}

// Раскладываем расходы РОВНО ПОРОВНУ по прошедшим дням того месяца, к которому они относятся:
// берём сумму двух категорий за ПОЛНЫЙ месяц (даже если период задевает только его часть),
// делим на число уже прошедших дней месяца и начисляем эту долю каждому дню периода.
//
// Почему не по дате самой траты: строки в лист пишет мобильное приложение по факту платежа, и
// такие расходы стоят неровно — зарплата 10-го, упаковка одной закупкой 28-го. При сравнении
// периодов ("с начала месяца" против предыдущих 10 дней) это давало дичь: в одном окне зарплата
// уже прошла, в другом ещё нет, и −9% могли оказаться чистой случайностью календаря. Поровну по
// дням — честное сравнение любых двух окон одинаковой длины.
//
// За закрытый месяц сумма всё равно равна месячному итогу, так что цифра на Главной по-прежнему
// сходится с "Отчётом" (там эти же категории вычитаются месяцем целиком). И за текущий месяц
// с начала месяца по сегодня — тоже: доля × число прошедших дней = всё, что записано.
async function fetchOpExpensesByDay(from, to) {
  const result = await pool.query(
    `SELECT to_char(expense_date, 'YYYY-MM') AS month, COALESCE(SUM(amount), 0) AS total
     FROM expenses
     WHERE category = ANY($3::text[])
       AND expense_date >= date_trunc('month', $1::date)
       AND expense_date < date_trunc('month', $2::date) + interval '1 month'
     GROUP BY month`,
    [from, to, PROFIT_EXPENSE_CATEGORIES]
  );

  const today = todayAlmaty();

  // Доля одного дня по каждому месяцу, который задевает период.
  const perDayByMonth = new Map();
  for (const r of result.rows) {
    const elapsed = elapsedDaysInMonth(r.month, today);
    if (elapsed > 0) perDayByMonth.set(r.month, Number(r.total) / elapsed);
  }

  const byDay = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    // Будущие дни расходов не несут: доля посчитана по прошедшим дням, и начислять её вперёд
    // значило бы придумать траты, которых ещё не было (период можно задать и с запасом,
    // например "весь сентябрь" десятого сентября).
    if (d > today) break;
    const perDay = perDayByMonth.get(d.slice(0, 7));
    if (perDay) byDay.set(d, perDay);
  }
  return byDay;
}

// Считает суммарную чистую прибыль по ВСЕМ товарам за период (для карточки на Главной).
//
// Если по заказу ещё не загружен Excel Kaspi Pay, считаем его не одной средней маржой, а по
// компонентам: точные выручка, FIFO-себестоимость, налог и доставка из Kaspi API; исторически
// оценивается только комиссия (и доставка как редкий fallback). Для свежих заказов дополнительно
// удерживается резерв возвратов по созревшей истории — это сглаживает скачок после импорта Excel.
async function computeSummaryNetProfit(from, to, mode) {
  // Маркетинг не привязан к городу отгрузки, поэтому вычитаем его только на "Главной" (mode
  // !== 'selfbuy') — так же, как колонка "Маркетинг" в "Отчёте" есть только в "Основном отчёте"
  // (Алматы, Астана), а не в "Самовыкупах".
  const [itemsResult, kptResult, costData, marketingData, opExpensesByDay, confirmedReturnsByDay] = await Promise.all([
    pool.query(
      // day — та же "казахстанская" дата, что и в /summary (сдвиг +5 часов), иначе выручка и
      // прибыль одного заказа попадали бы на разные дни графика.
      `SELECT oi.product_id, oi.quantity, oi.total_price, o.code AS order_number, o.id AS order_id,
              o.raw_data->'attributes'->>'deliveryCostForSeller' AS api_delivery_cost,
              to_char((oi.creation_date + interval '5 hours')::date, 'YYYY-MM-DD') AS day
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
         AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
         AND o.origin_city = ANY($3::text[])`,
      [from, to, citiesFor(mode)]
    ),
    pool.query(
      `SELECT order_number, operation_type, SUM(amount) AS amount,
              SUM(commission_total) AS commission_total, SUM(delivery_cost) AS delivery_cost
       FROM kaspi_pay_transactions
       GROUP BY order_number, operation_type`
    ),
    computeCostsByOrderItem(mode),
    mode !== 'selfbuy' ? fetchMarketingData(from, to) : Promise.resolve({ byDay: new Map(), sources: [] }),
    // Операционные расходы, как и маркетинг, не привязаны к городу отгрузки — поэтому только
    // на "Главной" (mode !== 'selfbuy'), ровно как колонки "Прочие затраты"/"Упаковка" в
    // "Отчёте" есть лишь в основном отчёте, а не в "Самовыкупах".
    mode !== 'selfbuy' ? fetchOpExpensesByDay(from, to) : Promise.resolve(new Map()),
    fetchConfirmedReturnsByDay(from, to, mode),
  ]);

  // Выручка выбранного периода по дням нужна для прогноза маркетинга. Берём те же позиции,
  // из которых ниже считается прибыль, поэтому прогноз относится ровно к заказам на Главной.
  const revenueByDay = new Map();
  const revenueByProduct = new Map();
  for (const it of itemsResult.rows) {
    const revenue = Number(it.total_price);
    revenueByDay.set(it.day, (revenueByDay.get(it.day) || 0) + revenue);
    revenueByProduct.set(it.product_id, (revenueByProduct.get(it.product_id) || 0) + revenue);
  }
  const marketingForecast = addMarketingForecast(marketingData, revenueByDay, from, to);
  const marketingByDay = marketingForecast.byDay;
  const marketing = [...marketingByDay.values()].reduce((sum, value) => sum + value, 0);

  // Итог за период — сумма тех же дневных долей, что уходят в график, а не отдельный запрос:
  // так число в карточке и сумма точек графика не могут разъехаться в принципе.
  const opExpenses = [...opExpensesByDay.values()].reduce((sum, value) => sum + value, 0);
  const confirmedReturns = [...confirmedReturnsByDay.values()]
    .reduce((sum, value) => sum + value.grossAmount, 0);
  const confirmedReturnImpact = [...confirmedReturnsByDay.values()]
    .reduce((sum, value) => sum + value.profitImpact, 0);

  // Прибыль по дням — для графика на телефоне. Собирается тем же проходом, что и итог, поэтому
  // сумма дней сходится с числом в карточке: маркетинг вычитается по своим датам (они у него
  // честные, по дням), операционные расходы — равными долями месяца (см. fetchOpExpensesByDay).
  const profitByDay = new Map();
  const estimatedDays = new Set(marketingForecast.estimatedDays);
  const addDayProfit = (day, value) => profitByDay.set(day, (profitByDay.get(day) || 0) + value);
  for (const [day, value] of confirmedReturnsByDay) addDayProfit(day, -value.profitImpact);
  function buildDays() {
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days.push({
        day: d,
        net_profit:
          Math.round(
            ((profitByDay.get(d) || 0) - (marketingByDay.get(d) || 0) - (opExpensesByDay.get(d) || 0)) * 100
          ) / 100,
        is_estimated: estimatedDays.has(d),
      });
    }
    return days;
  }

  if (itemsResult.rows.length === 0) {
    return {
      netProfit: -marketing - opExpenses - confirmedReturnImpact,
      usedEstimate: false,
      usedMarketingEstimate: false,
      confirmedReturns,
      confirmedReturnImpact,
      forecastBreakdown: {
        totalOrders: 0,
        confirmedOrders: 0,
        estimatedOrders: 0,
        coveragePercent: 100,
        confirmedOrderProfit: 0,
        estimatedOrderProfit: 0,
        expectedReturnReserve: 0,
        forecastLow: -marketing - opExpenses - confirmedReturnImpact,
        forecastHigh: -marketing - opExpenses - confirmedReturnImpact,
        marketing,
        operatingExpenses: opExpenses,
      },
      days: buildDays(),
      products: [],
    };
  }

  // order_id -> сумма всех позиций в этом заказе (для деления комиссии/доставки по товарам)
  const orderRevenueMap = new Map();
  for (const it of itemsResult.rows) {
    orderRevenueMap.set(it.order_id, (orderRevenueMap.get(it.order_id) || 0) + Number(it.total_price));
  }

  // order_number -> [{operation_type, amount, commission_total, delivery_cost}, ...]
  const kptByOrder = new Map();
  for (const row of kptResult.rows) {
    if (!kptByOrder.has(row.order_number)) kptByOrder.set(row.order_number, []);
    kptByOrder.get(row.order_number).push(row);
  }

  const [expenseModel, returnReserveModel] = await Promise.all([
    computeHistoricalExpenseModel(addDays(to, -90), to, mode, kptByOrder, costData),
    computeReturnReserveModel(mode, kptByOrder),
  ]);

  let knownNetProfit = 0;
  let knownNetRevenue = 0;
  const perProductKnown = new Map(); // product_id -> { revenue, profit } — только по "известным" продажам
  const unknownItems = [];
  const allOrderIds = new Set();
  const confirmedOrderIds = new Set();

  for (const it of itemsResult.rows) {
    allOrderIds.add(it.order_id);
    const kptRows = kptByOrder.get(it.order_number);
    const hasPurchase = kptRows && kptRows.some((r) => r.operation_type === 'Покупка');
    if (!hasPurchase) {
      unknownItems.push(it);
      continue;
    }
    confirmedOrderIds.add(it.order_id);

    const orderRevenue = orderRevenueMap.get(it.order_id) || 0;
    const share = orderRevenue > 0 ? Number(it.total_price) / orderRevenue : 0;

    let purchases = 0;
    let commission = 0;
    let delivery = 0;
    for (const row of kptRows) {
      // Фактические возвраты вычитаются общей суммой по дате операции ниже. Здесь оставляем
      // только покупку, чтобы возврат не попал одновременно и сюда, и в отдельный вычет.
      if (row.operation_type === 'Возврат') continue;
      const allocatedAmount = Number(row.amount) * share;
      // commission_total/delivery_cost хранятся отрицательными (расход) — переворачиваем в плюс.
      commission += -Number(row.commission_total) * share;
      delivery += -Number(row.delivery_cost) * share;
      purchases += allocatedAmount;
    }

    const netRevenueItem = purchases;
    const cost = costData.costByOrderItem[`${it.order_number}::${it.product_id}`] || 0;
    const taxes = netRevenueItem > 0 ? netRevenueItem * TAX_RATE : 0;
    const netProfitItem = netRevenueItem - cost - commission - delivery - taxes;

    knownNetProfit += netProfitItem;
    knownNetRevenue += netRevenueItem;
    addDayProfit(it.day, netProfitItem);

    const stat = perProductKnown.get(it.product_id) || { revenue: 0, profit: 0 };
    stat.revenue += netRevenueItem;
    stat.profit += netProfitItem;
    perProductKnown.set(it.product_id, stat);
  }

  function forecastModelForProduct(productId) {
    return expenseModel.byProduct.get(productId) || {
      commissionRate: expenseModel.overallCommissionRate,
      commissionLow: expenseModel.overallCommissionLow,
      commissionHigh: expenseModel.overallCommissionHigh,
      deliveryPerUnit: expenseModel.overallDeliveryPerUnit,
      costRate: expenseModel.overallCostRate,
      sampleSize: 0,
    };
  }

  let estimatedNetProfit = 0;
  let commissionUpside = 0;
  let commissionDownside = 0;
  let apiDeliveryOrders = 0;
  let fallbackDeliveryOrders = 0;
  let fallbackCostItems = 0;
  // Прибыль по каждому товару до общих расходов. Ниже маркетинг, операционные расходы и
  // подтверждённые возвраты распределяются пропорционально выручке товара. Резерв будущих
  // возвратов, наоборот, считается непосредственно по ставке каждого товара.
  const profitByProduct = new Map();
  for (const [productId, stat] of perProductKnown) {
    profitByProduct.set(productId, stat.profit);
  }
  for (const it of unknownItems) {
    const revenue = Number(it.total_price);
    const orderRevenue = orderRevenueMap.get(it.order_id) || 0;
    const share = orderRevenue > 0 ? revenue / orderRevenue : 0;
    const model = forecastModelForProduct(it.product_id);
    const costKey = `${it.order_number}::${it.product_id}`;
    const hasExactCost = Object.prototype.hasOwnProperty.call(costData.costByOrderItem, costKey);
    const cost = hasExactCost ? Number(costData.costByOrderItem[costKey]) : revenue * model.costRate;
    if (!hasExactCost) fallbackCostItems += 1;
    const forecast = forecastUnknownItemProfit({
      revenue,
      cost,
      commissionRate: model.commissionRate,
      apiDeliveryCost: it.api_delivery_cost,
      orderShare: share,
      deliveryPerUnit: model.deliveryPerUnit,
      quantity: it.quantity,
    });
    commissionUpside += revenue * Math.max(0, model.commissionRate - model.commissionLow);
    commissionDownside += revenue * Math.max(0, model.commissionHigh - model.commissionRate);
    if (forecast.usedApiDelivery) apiDeliveryOrders += 1;
    else fallbackDeliveryOrders += 1;

    estimatedNetProfit += forecast.profit;
    addDayProfit(it.day, forecast.profit);
    estimatedDays.add(it.day); // в этом дне есть заказы без Excel-отчёта — прибыль дня оценочная
    profitByProduct.set(it.product_id, (profitByProduct.get(it.product_id) || 0) + forecast.profit);
  }

  // Резерв держим у свежих (до 45 дней) заказов до появления фактического возврата. Благодаря
  // этому загрузка очередного Excel не обрушает прибыль внезапно: ожидаемая доля возвратов уже
  // была вычтена, а подтверждённый возврат лишь заменяет оценку конкретного заказа фактом.
  const reserveByProduct = new Map();
  let expectedReturnReserve = 0;
  const reserveFrom = addDays(todayAlmaty(), -44);
  for (const it of itemsResult.rows) {
    if (it.day < reserveFrom || it.day > todayAlmaty()) continue;
    const rows = kptByOrder.get(it.order_number) || [];
    if (rows.some((row) => row.operation_type === 'Возврат')) continue;
    const reserveRate = returnReserveModel.rateByProduct.get(it.product_id)
      ?? returnReserveModel.overallRate;
    const reserve = Number(it.total_price) * reserveRate;
    if (reserve <= 0) continue;
    expectedReturnReserve += reserve;
    reserveByProduct.set(it.product_id, (reserveByProduct.get(it.product_id) || 0) + reserve);
    addDayProfit(it.day, -reserve);
    estimatedDays.add(it.day);
  }

  const totalNetProfit =
    knownNetProfit + estimatedNetProfit - marketing - opExpenses - confirmedReturnImpact - expectedReturnReserve;
  // Диапазон — честное отображение оставшейся неопределённости, а не декоративные ±10%:
  // границы комиссии берутся из 10/90 процентилей реальных ставок, резерв возвратов может
  // реализоваться от нуля до удвоенного ожидания, прогноз маркетинга — ±25%.
  const marketingUncertainty = marketingForecast.estimatedTotal * 0.25;
  const forecastLow = totalNetProfit - commissionDownside - expectedReturnReserve - marketingUncertainty;
  const forecastHigh = totalNetProfit + commissionUpside + expectedReturnReserve + marketingUncertainty;
  const totalProductRevenue = [...revenueByProduct.values()].reduce((sum, value) => sum + value, 0);
  const productEntries = [...profitByProduct.entries()];
  let allocatedMarketing = 0;
  let allocatedOpExpenses = 0;
  let allocatedReturns = 0;
  let roundedProfitAssigned = 0;

  const products = productEntries.map(([productId, contributionProfit], index) => {
    const revenue = revenueByProduct.get(productId) || 0;
    const share = totalProductRevenue > 0 ? revenue / totalProductRevenue : 0;
    const isLast = index === productEntries.length - 1;

    // Последний товар получает остаток от дробных копеек, поэтому распределённые суммы
    // сходятся с общими точно, а не только приблизительно.
    const productMarketing = isLast ? marketing - allocatedMarketing : marketing * share;
    const productOpExpenses = isLast ? opExpenses - allocatedOpExpenses : opExpenses * share;
    const productReturns = isLast
      ? confirmedReturnImpact - allocatedReturns
      : confirmedReturnImpact * share;
    allocatedMarketing += productMarketing;
    allocatedOpExpenses += productOpExpenses;
    allocatedReturns += productReturns;

    const productReserve = reserveByProduct.get(productId) || 0;
    const exactProfit = contributionProfit - productMarketing - productOpExpenses - productReturns - productReserve;
    // В интерфейсе деньги показываются целыми тенге. Последней строке отдаём остаток округления,
    // чтобы пользователь мог сложить видимые числа и получить ровно видимый общий итог.
    const netProfit = isLast ? Math.round(totalNetProfit) - roundedProfitAssigned : Math.round(exactProfit);
    roundedProfitAssigned += netProfit;

    return {
      product_id: productId,
      net_profit: netProfit,
      margin: revenue > 0 ? (netProfit / revenue) * 100 : null,
      allocated_marketing: productMarketing,
      allocated_operating_expenses: productOpExpenses,
      allocated_returns: productReturns,
      expected_return_reserve: productReserve,
    };
  }).sort((a, b) => b.net_profit - a.net_profit);

  return {
    netProfit: totalNetProfit,
    usedEstimate: unknownItems.length > 0 || expectedReturnReserve > 0,
    usedMarketingEstimate: marketingForecast.estimatedTotal > 0,
    confirmedReturns,
    confirmedReturnImpact,
    forecastBreakdown: {
      totalOrders: allOrderIds.size,
      confirmedOrders: confirmedOrderIds.size,
      estimatedOrders: allOrderIds.size - confirmedOrderIds.size,
      coveragePercent: allOrderIds.size > 0 ? (confirmedOrderIds.size / allOrderIds.size) * 100 : 100,
      confirmedOrderProfit: knownNetProfit,
      estimatedOrderProfit: estimatedNetProfit,
      expectedReturnReserve,
      forecastLow,
      forecastHigh,
      marketing,
      operatingExpenses: opExpenses,
      apiDeliveryItems: apiDeliveryOrders,
      fallbackDeliveryItems: fallbackDeliveryOrders,
      fallbackCostItems,
      historicalCommissionRate: expenseModel.overallCommissionRate,
      historicalReturnLossRate: returnReserveModel.overallRate,
    },
    days: buildDays(),
    products,
  };
}

router.get('/summary-profit', async (req, res) => {
  const { from, to, mode } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const {
      netProfit, usedEstimate, usedMarketingEstimate, confirmedReturns, confirmedReturnImpact,
      forecastBreakdown, days, products,
    } = await computeSummaryNetProfit(from, to, mode);
    res.json({
      net_profit: netProfit,
      used_estimate: usedEstimate,
      used_marketing_estimate: usedMarketingEstimate,
      confirmed_returns: confirmedReturns,
      confirmed_return_impact: confirmedReturnImpact,
      forecast_breakdown: forecastBreakdown,
      days,
      products,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить чистую прибыль' });
  }
});

// Возвращает {день -> себестоимость проданного (FIFO)} для конкретного товара. Логика та же,
// что в costEngine.computeCosts, но: а) только для одного товара, б) с группировкой по дню
// (а не по месяцу) — причём по дате ЗАКАЗА (как и выручка), а не по дате операции в Excel-отчёте
// Kaspi Pay (эти две даты не всегда совпадают день в день — иначе выручка и прибыль одного и того
// же заказа "разъезжались" бы по разным дням на графике), в) фильтр по городам — как в остальных
// ручках этого файла (mode selfbuy/main), а не через список конкретных городов.
async function computeProductDailyCost(productId, mode) {
  const batchesResult = await pool.query(
    // status = 'received' — см. комментарий в computeCostsByOrderItem выше
    `SELECT warehouse, cost_price, quantity FROM product_batches
     WHERE product_id = $1 AND status = 'received' ORDER BY warehouse, received_date, id`,
    [productId]
  );
  const batchesByWarehouse = new Map();
  const firstBatchPriceByWarehouse = new Map(); // цена самой первой поставки — для заказов до даты отсечки
  for (const b of batchesResult.rows) {
    if (!batchesByWarehouse.has(b.warehouse)) batchesByWarehouse.set(b.warehouse, []);
    batchesByWarehouse.get(b.warehouse).push({ cost_price: Number(b.cost_price), remaining: Number(b.quantity) });
    if (!firstBatchPriceByWarehouse.has(b.warehouse)) firstBatchPriceByWarehouse.set(b.warehouse, Number(b.cost_price));
  }

  const soldResult = await pool.query(
    `WITH kpt_agg AS (
       SELECT order_number, MIN(operation_date) AS operation_date
       FROM kaspi_pay_transactions
       WHERE operation_type = 'Покупка'
       GROUP BY order_number
     )
     SELECT oi.quantity, o.origin_city AS warehouse, o.creation_date,
            to_char((o.creation_date + interval '5 hours')::date, 'YYYY-MM-DD') AS day
     FROM kpt_agg ka
     JOIN orders o ON o.code = ka.order_number
     JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = $1
     WHERE o.origin_city = ANY($2::text[])
     ORDER BY o.origin_city, o.creation_date ASC`,
    [productId, citiesFor(mode)]
  );

  const costByDay = {};
  for (const row of soldResult.rows) {
    // Заказ старше даты отсечки остатков — партии на "Поставках" введены как снимок на эту дату,
    // такие старые заказы их не списывают, а оцениваются по цене самой первой поставки.
    if (new Date(row.creation_date) < new Date(STOCK_CUTOFF_DATE)) {
      const price = firstBatchPriceByWarehouse.get(row.warehouse);
      if (price === undefined) continue;
      costByDay[row.day] = (costByDay[row.day] || 0) + Number(row.quantity) * price;
      continue;
    }

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
    // Продано больше, чем приехало — оцениваем по цене последней прибывшей партии
    // (см. подробный комментарий в costEngine.computeCosts).
    if (qty > 0) costByDay[row.day] = (costByDay[row.day] || 0) + qty * batches[batches.length - 1].cost_price;
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
     WHERE o.origin_city = ANY($2::text[])
     ORDER BY o.creation_date`,
    [productId, citiesFor(mode)]
  );

  const byDay = {};
  for (const row of result.rows) {
    const orderRevenue = Number(row.order_revenue);
    const share = orderRevenue > 0 ? Number(row.product_revenue) / orderRevenue : 0;
    const allocatedAmount = Number(row.amount) * share;
    // commission_total и delivery_cost в базе хранятся отрицательными (расход) — как и everywhere
    // в приложении (reports.js, orders.js), переворачиваем в положительное число, чтобы дальше
    // корректно ВЫЧИТАТЬ из прибыли, а не прибавлять к ней.
    const allocatedCommission = -Number(row.commission_total) * share;
    const allocatedDelivery = -Number(row.delivery_cost) * share;

    if (!byDay[row.day]) byDay[row.day] = { purchasesAmount: 0, returnsAmount: 0, commission: 0, delivery: 0 };
    if (row.operation_type === 'Возврат') {
      // В kaspi_pay_transactions сумма возврата хранится отрицательной (как и в "Сумма" на
      // странице "Заказы") — переворачиваем в положительное число, чтобы дальше корректно
      // ВЫЧИТАТЬ её из выручки (netRevenue = purchasesAmount - returnsAmount), а не прибавлять.
      byDay[row.day].returnsAmount += -allocatedAmount;
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
           AND o.origin_city = ANY($4::text[])
         GROUP BY day
         ORDER BY day`,
        [productId, from, to, citiesFor(mode)]
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

    // Исторический % чистой прибыли от выручки для ЭТОГО товара — считаем по ВСЕЙ истории
    // известных (есть Excel-отчёт) дней, а не только по выбранному периоду, чтобы прогноз был
    // основан на как можно большей выборке (та же идея, что на Главной — computeSummaryNetProfit,
    // только там % усредняется по всем товарам, а здесь достаточно истории одного товара).
    let historyKnownRevenue = 0;
    let historyKnownProfit = 0;
    for (const [day, kp] of Object.entries(kaspiPayByDay)) {
      const netRevenueDay = (kp.purchasesAmount || 0) - (kp.returnsAmount || 0);
      const costDay = costByDay[day] || 0;
      const taxesDay = netRevenueDay > 0 ? netRevenueDay * TAX_RATE : 0;
      historyKnownRevenue += netRevenueDay;
      historyKnownProfit += netRevenueDay - costDay - (kp.commission || 0) - (kp.delivery || 0) - taxesDay;
    }
    const historicalRatio = historyKnownRevenue > 0 ? historyKnownProfit / historyKnownRevenue : null;

    const days = Array.from(dayMap.values())
      .map((d) => {
        if (d.hasKaspiData) {
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
            is_estimated: false,
          };
        }

        // За этот день ещё не загружали Excel-отчёт Kaspi Pay — точную комиссию/доставку/себестоимость
        // взять неоткуда, поэтому ПРОГНОЗИРУЕМ прибыль по историческому % этого же товара (см. выше).
        // Если по товару вообще ни разу не было известных дней — прогнозировать не от чего, оставляем разрыв.
        if (historicalRatio === null) {
          return { day: d.day, total_quantity: d.total_quantity, total_revenue: d.total_revenue, net_profit: null, is_estimated: false };
        }
        return {
          day: d.day,
          total_quantity: d.total_quantity,
          total_revenue: d.total_revenue,
          net_profit: d.total_revenue * historicalRatio,
          is_estimated: true,
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
// Расчёт себестоимости по каждой паре "заказ+товар" переиспользует страница ABC/XYZ —
// дублировать FIFO по партиям нельзя, иначе прибыль на двух страницах разъедется.
module.exports.computeCostsByOrderItem = computeCostsByOrderItem;
module.exports.TAX_RATE = TAX_RATE;
module.exports.forecastUnknownItemProfit = forecastUnknownItemProfit;
module.exports.returnProfitImpact = returnProfitImpact;
