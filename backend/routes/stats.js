const express = require('express');
const { pool } = require('../db');
const { STOCK_CUTOFF_DATE } = require('../constants');

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

// Считает себестоимость (FIFO) отдельно для каждой пары "заказ+товар" — в отличие от
// costEngine.computeCosts (который суммирует себестоимость на весь заказ целиком), здесь
// нужна себестоимость именно конкретного товара в заказе, без всякой аллокации: FIFO и так
// точно знает, сколько стоил именно этот товар (в отличие от комиссии/доставки, которые
// Kaspi Pay выставляет на весь заказ и делить их по товарам можно только пропорционально).
// Обрабатывает ВСЮ историю (а не только запрошенный период) — иначе некорректно определится,
// какая партия к этому моменту уже была списана более ранними продажами.
async function computeCostsByOrderItem(mode) {
  const batchesResult = await pool.query(`
    SELECT product_id, warehouse, cost_price, quantity, received_date
    FROM product_batches
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
    `WITH kpt_agg AS (
       SELECT order_number, operation_type, MIN(operation_date) AS operation_date
       FROM kaspi_pay_transactions
       WHERE operation_type IN ('Покупка', 'Возврат')
       GROUP BY order_number, operation_type
     )
     SELECT oi.product_id, o.origin_city AS warehouse, oi.quantity, ka.order_number, ka.operation_type,
            o.creation_date
     FROM kpt_agg ka
     JOIN orders o ON o.code = ka.order_number
     JOIN order_items oi ON oi.order_id = o.id
     WHERE ${mode === 'selfbuy' ? 'o.origin_city = ANY($1::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($1::text[])))'}
     ORDER BY o.origin_city, o.creation_date ASC`,
    [SELF_BUY_WAREHOUSES]
  );

  // "order_number::product_id" -> себестоимость (только по операциям "Покупка" —
  // себестоимость возврата, как и везде в приложении, не вычитается из прибыли).
  const costByOrderItem = {};
  const knownOrders = new Set(); // заказы, по которым вообще есть хоть какие-то данные из Excel-отчёта

  for (const row of soldResult.rows) {
    knownOrders.add(row.order_number);
    if (row.operation_type === 'Возврат') continue;

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
    costByOrderItem[itemKey] = (costByOrderItem[itemKey] || 0) + cost;
  }

  return { costByOrderItem, knownOrders };
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Считает средний % чистой прибыли от выручки по уже известным (есть в Excel-отчёте) продажам
// за произвольное окно дат — используется как запасной вариант, когда в самом запрошенном
// периоде известных продаж нет вообще (см. computeSummaryNetProfit). kptByOrder и costData
// переиспользуются из основного расчёта — они и так покрывают всю историю, а не только период,
// так что дополнительно запрашивать их снова не нужно, только order_items за новое окно дат.
async function computeKnownProfitRatio(from, to, mode, kptByOrder, costData) {
  const itemsResult = await pool.query(
    `SELECT oi.product_id, oi.total_price, o.code AS order_number, o.id AS order_id
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
       AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
       AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
       AND ${mode === 'selfbuy' ? 'o.origin_city = ANY($3::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($3::text[])))'}`,
    [from, to, SELF_BUY_WAREHOUSES]
  );

  const orderRevenueMap = new Map();
  for (const it of itemsResult.rows) {
    orderRevenueMap.set(it.order_id, (orderRevenueMap.get(it.order_id) || 0) + Number(it.total_price));
  }

  let knownNetProfit = 0;
  let knownNetRevenue = 0;

  for (const it of itemsResult.rows) {
    const kptRows = kptByOrder.get(it.order_number);
    const hasPurchase = kptRows && kptRows.some((r) => r.operation_type === 'Покупка');
    if (!hasPurchase) continue;

    const orderRevenue = orderRevenueMap.get(it.order_id) || 0;
    const share = orderRevenue > 0 ? Number(it.total_price) / orderRevenue : 0;

    let purchases = 0;
    let returns = 0;
    let commission = 0;
    let delivery = 0;
    for (const row of kptRows) {
      const allocatedAmount = Number(row.amount) * share;
      commission += -Number(row.commission_total) * share;
      delivery += -Number(row.delivery_cost) * share;
      if (row.operation_type === 'Возврат') {
        returns += -allocatedAmount;
      } else {
        purchases += allocatedAmount;
      }
    }

    const netRevenueItem = purchases - returns;
    const cost = costData.costByOrderItem[`${it.order_number}::${it.product_id}`] || 0;
    const taxes = netRevenueItem > 0 ? netRevenueItem * TAX_RATE : 0;
    knownNetProfit += netRevenueItem - cost - commission - delivery - taxes;
    knownNetRevenue += netRevenueItem;
  }

  return knownNetRevenue > 0 ? knownNetProfit / knownNetRevenue : null;
}

// Сумма расходов на маркетинг (реклама + бонусы от продавца + бонусы за отзыв) за произвольный
// диапазон дат — просто SUM того, что реально загружено, без каких-либо прогнозов на
// недостающие дни (в отличие от оценки чистой прибыли по свежим заказам ниже).
async function fetchMarketingTotalForRange(from, to) {
  const [adsResult, bonusResult, reviewResult] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(cost), 0) AS total FROM ad_expenses WHERE expense_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(bonus_amount), 0) AS total FROM bonus_expenses WHERE expense_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COALESCE(SUM(bonus_amount), 0) AS total FROM review_bonus_expenses WHERE expense_date BETWEEN $1 AND $2`, [from, to]),
  ]);
  return Number(adsResult.rows[0].total) + Number(bonusResult.rows[0].total) + Number(reviewResult.rows[0].total);
}

// Считает суммарную чистую прибыль по ВСЕМ товарам за период (для карточки на Главной).
//
// Ключевое отличие от расчёта по одному товару: если по какому-то заказу ещё не загружен
// Excel-отчёт Kaspi Pay (нет данных о комиссии/доставке), мы не пропускаем его молча, а
// ОЦЕНИВАЕМ его чистую прибыль — берём средний % чистой прибыли от выручки по уже посчитанным
// ("известным") продажам ТОГО ЖЕ товара за тот же период, и применяем этот процент к выручке
// неизвестного заказа. Если по этому товару вообще нет ни одной известной продажи в периоде —
// используем общий средний % прибыли по всем товарам за период как более грубый запасной вариант.
async function computeSummaryNetProfit(from, to, mode) {
  // Маркетинг не привязан к городу отгрузки, поэтому вычитаем его только на "Главной" (mode
  // !== 'selfbuy') — так же, как колонка "Маркетинг" в "Отчёте" есть только в "Основном отчёте"
  // (Алматы, Астана), а не в "Самовыкупах".
  const [itemsResult, kptResult, costData, marketing] = await Promise.all([
    pool.query(
      `SELECT oi.product_id, oi.quantity, oi.total_price, o.code AS order_number, o.id AS order_id
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
         AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND o.status IN ('ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK')
         AND ${mode === 'selfbuy' ? 'o.origin_city = ANY($3::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($3::text[])))'}`,
      [from, to, SELF_BUY_WAREHOUSES]
    ),
    pool.query(
      `SELECT order_number, operation_type, SUM(amount) AS amount,
              SUM(commission_total) AS commission_total, SUM(delivery_cost) AS delivery_cost
       FROM kaspi_pay_transactions
       GROUP BY order_number, operation_type`
    ),
    computeCostsByOrderItem(mode),
    mode !== 'selfbuy' ? fetchMarketingTotalForRange(from, to) : Promise.resolve(0),
  ]);

  if (itemsResult.rows.length === 0) {
    return { netProfit: -marketing, usedEstimate: false };
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

  let knownNetProfit = 0;
  let knownNetRevenue = 0;
  const perProductKnown = new Map(); // product_id -> { revenue, profit } — только по "известным" продажам
  const unknownItems = [];

  for (const it of itemsResult.rows) {
    const kptRows = kptByOrder.get(it.order_number);
    const hasPurchase = kptRows && kptRows.some((r) => r.operation_type === 'Покупка');
    if (!hasPurchase) {
      unknownItems.push(it);
      continue;
    }

    const orderRevenue = orderRevenueMap.get(it.order_id) || 0;
    const share = orderRevenue > 0 ? Number(it.total_price) / orderRevenue : 0;

    let purchases = 0;
    let returns = 0;
    let commission = 0;
    let delivery = 0;
    for (const row of kptRows) {
      const allocatedAmount = Number(row.amount) * share;
      // commission_total/delivery_cost хранятся отрицательными (расход) — переворачиваем в плюс.
      commission += -Number(row.commission_total) * share;
      delivery += -Number(row.delivery_cost) * share;
      if (row.operation_type === 'Возврат') {
        returns += -allocatedAmount; // amount у возврата тоже отрицательный — переворачиваем в плюс
      } else {
        purchases += allocatedAmount;
      }
    }

    const netRevenueItem = purchases - returns;
    const cost = costData.costByOrderItem[`${it.order_number}::${it.product_id}`] || 0;
    const taxes = netRevenueItem > 0 ? netRevenueItem * TAX_RATE : 0;
    const netProfitItem = netRevenueItem - cost - commission - delivery - taxes;

    knownNetProfit += netProfitItem;
    knownNetRevenue += netRevenueItem;

    const stat = perProductKnown.get(it.product_id) || { revenue: 0, profit: 0 };
    stat.revenue += netRevenueItem;
    stat.profit += netProfitItem;
    perProductKnown.set(it.product_id, stat);
  }

  // Общий % прибыли по всем известным продажам за период — запасной вариант для товаров,
  // у которых вообще нет ни одной известной продажи в этом периоде.
  let overallRatio = knownNetRevenue > 0 ? knownNetProfit / knownNetRevenue : null;

  // А если известных продаж нет вообще ЗА ВЕСЬ ПЕРИОД целиком (типичный случай — период
  // "Сегодня"/"Вчера": Excel-отчёт по свежим дням физически ещё не может быть загружен) —
  // посчитать overallRatio не от чего, и без этого блока вся оценка молча превратилась бы в 0,
  // хотя реальная выручка есть. Вместо этого берём более широкое окно — последние 60 дней
  // перед концом периода — и считаем средний % прибыли по нему.
  if (overallRatio === null) {
    const fallbackFrom = addDays(to, -60);
    const fallbackStats = await computeKnownProfitRatio(fallbackFrom, to, mode, kptByOrder, costData);
    overallRatio = fallbackStats; // если и там ничего не нашлось (null) — используем 0 дальше
  }
  if (overallRatio === null) overallRatio = 0;

  let estimatedNetProfit = 0;
  for (const it of unknownItems) {
    const revenue = Number(it.total_price);
    const stat = perProductKnown.get(it.product_id);
    const ratio = stat && stat.revenue > 0 ? stat.profit / stat.revenue : overallRatio;
    estimatedNetProfit += revenue * ratio;
  }

  return {
    netProfit: knownNetProfit + estimatedNetProfit - marketing,
    usedEstimate: unknownItems.length > 0,
  };
}

router.get('/summary-profit', async (req, res) => {
  const { from, to, mode } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const { netProfit, usedEstimate } = await computeSummaryNetProfit(from, to, mode);
    res.json({ net_profit: netProfit, used_estimate: usedEstimate });
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
    `SELECT warehouse, cost_price, quantity FROM product_batches WHERE product_id = $1 ORDER BY warehouse, received_date, id`,
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
     WHERE ${mode === 'selfbuy' ? 'o.origin_city = ANY($2::text[])' : '(o.origin_city IS NULL OR NOT (o.origin_city = ANY($2::text[])))'}
     ORDER BY o.origin_city, o.creation_date ASC`,
    [productId, SELF_BUY_WAREHOUSES]
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
