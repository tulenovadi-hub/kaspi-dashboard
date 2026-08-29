const express = require('express');
const { pool } = require('../db');
const { MAIN_CITIES, SELF_BUY_CITIES } = require('../warehouseMapping');
const { computeCostsByOrderItem, TAX_RATE } = require('./stats');

const router = express.Router();

const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

// Границы ABC по накопленной доле: A — первые 80% вклада, B — следующие 15%, C — хвост.
const ABC_A = 80;
const ABC_B = 95;

// Границы XYZ по коэффициенту вариации недельных продаж. Значения классические (10% и 25%).
const XYZ_X = 0.1;
const XYZ_Y = 0.25;

// Сколько нужно данных, чтобы вообще судить о стабильности спроса. Меньше — честнее написать
// "мало данных", чем назвать товар нестабильным на основании двух продаж.
const MIN_WEEKS = 6;
const MIN_UNITS = 6;

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function citiesFor(mode) {
  return mode === 'selfbuy' ? SELF_BUY_CITIES : MAIN_CITIES;
}

// Расходы на кампанию, разложенные по её товарам, за произвольный диапазон дат. Это та же
// логика, что в "Отчёте" (getCampaignCostByProductForMonth), но по датам, а не по месяцу:
// стоимость кампании делится поровну между товарами, которые в неё входят.
async function campaignCostByProduct(from, to, costTable, costColumn, linkTable) {
  const costResult = await pool.query(
    `SELECT campaign_id, SUM(${costColumn}) AS total_cost
     FROM ${costTable}
     WHERE expense_date BETWEEN $1 AND $2
     GROUP BY campaign_id`,
    [from, to]
  );
  if (costResult.rows.length === 0) return {};

  const productsResult = await pool.query(
    `SELECT campaign_id, product_id FROM ${linkTable} WHERE campaign_id = ANY($1::text[])`,
    [costResult.rows.map((r) => r.campaign_id)]
  );
  const productsByCampaign = new Map();
  for (const row of productsResult.rows) {
    if (!productsByCampaign.has(row.campaign_id)) productsByCampaign.set(row.campaign_id, []);
    productsByCampaign.get(row.campaign_id).push(row.product_id);
  }

  const byProduct = {};
  for (const row of costResult.rows) {
    const productIds = productsByCampaign.get(row.campaign_id) || [];
    if (productIds.length === 0) continue;
    const share = Number(row.total_cost) / productIds.length;
    for (const productId of productIds) {
      byProduct[productId] = (byProduct[productId] || 0) + share;
    }
  }
  return byProduct;
}

async function marketingByProduct(from, to) {
  const [ads, bonuses, reviews] = await Promise.all([
    campaignCostByProduct(from, to, 'ad_expenses', 'cost', 'ad_campaign_products'),
    campaignCostByProduct(from, to, 'bonus_expenses', 'bonus_amount', 'bonus_campaign_products'),
    campaignCostByProduct(from, to, 'review_bonus_expenses', 'bonus_amount', 'review_bonus_campaign_products'),
  ]);
  const total = {};
  for (const source of [ads, bonuses, reviews]) {
    for (const [productId, value] of Object.entries(source)) {
      total[productId] = (total[productId] || 0) + value;
    }
  }
  return total;
}

// Номер недели от начала периода: 0 — первые семь дней, 1 — следующие и так далее.
// Считаем именно от начала периода, а не по календарным неделям, чтобы первая и последняя
// недели не оказались обрезанными и не выглядели провалом спроса.
function weekIndex(dayIso, fromIso) {
  const day = Date.UTC(...dayIso.slice(0, 10).split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const start = Date.UTC(...fromIso.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.floor((day - start) / (7 * 24 * 60 * 60 * 1000));
}

// Коэффициент вариации: среднеквадратичное отклонение, делённое на среднее. Нули (недели без
// продаж) в расчёт входят — товар, который продаётся рывками, и должен считаться нестабильным.
function coefficientOfVariation(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function xyzClass(cv) {
  if (cv === null) return null;
  if (cv <= XYZ_X) return 'X';
  if (cv <= XYZ_Y) return 'Y';
  return 'Z';
}

router.get('/', async (req, res) => {
  const { from, to, mode, basis } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }
  // По чему строить ABC: по вкладу в прибыль (по умолчанию) или в выручку.
  const byProfit = basis !== 'revenue';

  try {
    const [itemsResult, kptResult, costData, marketing] = await Promise.all([
      pool.query(
        `SELECT oi.product_id, oi.product_name, oi.quantity, oi.total_price,
                o.code AS order_number, o.id AS order_id,
                to_char(oi.creation_date + interval '5 hours', 'YYYY-MM-DD') AS day
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
           AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
           AND o.status = ANY($3::text[])
           AND o.origin_city = ANY($4::text[])`,
        [from, to, VALID_STATUSES, citiesFor(mode)]
      ),
      pool.query(
        `SELECT order_number, operation_type, SUM(amount) AS amount,
                SUM(commission_total) AS commission_total, SUM(delivery_cost) AS delivery_cost
         FROM kaspi_pay_transactions
         GROUP BY order_number, operation_type`
      ),
      computeCostsByOrderItem(mode),
      // Маркетинг не привязан к городу отгрузки — как и на Главной, учитываем его только
      // для основного магазина, а не для самовыкупов.
      mode !== 'selfbuy' ? marketingByProduct(from, to) : Promise.resolve({}),
    ]);

    const items = itemsResult.rows;
    if (items.length === 0) {
      return res.json({
        products: [], matrix: [], totals: null, weeks: 0,
        thresholds: { abcA: ABC_A, abcB: ABC_B, xyzX: XYZ_X, xyzY: XYZ_Y, minWeeks: MIN_WEEKS, minUnits: MIN_UNITS },
      });
    }

    // Сумма всех позиций заказа — по ней комиссия и доставка делятся между товарами
    // пропорционально их доле в чеке (Kaspi выставляет их на заказ целиком).
    const orderRevenue = new Map();
    for (const it of items) {
      orderRevenue.set(it.order_id, (orderRevenue.get(it.order_id) || 0) + Number(it.total_price));
    }

    const kptByOrder = new Map();
    for (const row of kptResult.rows) {
      if (!kptByOrder.has(row.order_number)) kptByOrder.set(row.order_number, []);
      kptByOrder.get(row.order_number).push(row);
    }

    const weeksTotal = weekIndex(to, from) + 1;

    const products = new Map();
    function getProduct(it) {
      const key = it.product_id || `name:${it.product_name}`;
      if (!products.has(key)) {
        products.set(key, {
          productId: it.product_id, name: it.product_name,
          quantity: 0, revenue: 0,
          knownRevenue: 0, knownProfit: 0, // только по заказам с загруженным отчётом Kaspi Pay
          unknownRevenue: 0,
          weekQuantities: new Array(weeksTotal).fill(0),
        });
      }
      return products.get(key);
    }

    let knownProfitTotal = 0;
    let knownRevenueTotal = 0;

    for (const it of items) {
      const p = getProduct(it);
      const quantity = Number(it.quantity) || 0;
      p.quantity += quantity;
      p.revenue += Number(it.total_price) || 0;

      const week = weekIndex(it.day, from);
      if (week >= 0 && week < weeksTotal) p.weekQuantities[week] += quantity;

      const kptRows = kptByOrder.get(it.order_number);
      const hasPurchase = kptRows && kptRows.some((r) => r.operation_type === 'Покупка');
      if (!hasPurchase) {
        // Отчёт Kaspi Pay по этому заказу ещё не загружен — точную прибыль не посчитать,
        // оценим ниже по среднему проценту этого же товара.
        p.unknownRevenue += Number(it.total_price) || 0;
        continue;
      }

      const orderTotal = orderRevenue.get(it.order_id) || 0;
      const share = orderTotal > 0 ? Number(it.total_price) / orderTotal : 0;

      let purchases = 0;
      let returns = 0;
      let commission = 0;
      let delivery = 0;
      for (const row of kptRows) {
        // commission_total/delivery_cost/amount возврата хранятся отрицательными — переворачиваем.
        commission += -Number(row.commission_total) * share;
        delivery += -Number(row.delivery_cost) * share;
        if (row.operation_type === 'Возврат') returns += -Number(row.amount) * share;
        else purchases += Number(row.amount) * share;
      }

      const netRevenue = purchases - returns;
      const cost = costData.costByOrderItem[`${it.order_number}::${it.product_id}`] || 0;
      const taxes = netRevenue > 0 ? netRevenue * TAX_RATE : 0;
      const profit = netRevenue - cost - commission - delivery - taxes;

      p.knownRevenue += netRevenue;
      p.knownProfit += profit;
      knownRevenueTotal += netRevenue;
      knownProfitTotal += profit;
    }

    // Средний процент прибыли по всем известным продажам — запасной вариант для товаров,
    // у которых в периоде нет ни одной продажи с загруженным отчётом.
    const overallRatio = knownRevenueTotal > 0 ? knownProfitTotal / knownRevenueTotal : 0;

    let estimatedRevenue = 0;
    const rows = [...products.values()].map((p) => {
      const ratio = p.knownRevenue > 0 ? p.knownProfit / p.knownRevenue : overallRatio;
      const estimatedProfit = p.unknownRevenue * ratio;
      estimatedRevenue += p.unknownRevenue;

      const productMarketing = marketing[p.productId] || 0;
      const profit = p.knownProfit + estimatedProfit - productMarketing;

      const weeksWithSales = p.weekQuantities.filter((q) => q > 0).length;
      const cv = coefficientOfVariation(p.weekQuantities);
      // Классифицировать стабильность по двум-трём продажам — самообман: у такого товара
      // коэффициент вариации формально считается, но не значит ничего.
      const enoughData = weeksTotal >= MIN_WEEKS && p.quantity >= MIN_UNITS;

      return {
        productId: p.productId,
        name: p.name,
        quantity: p.quantity,
        revenue: Math.round(p.revenue),
        profit: Math.round(profit),
        marketing: Math.round(productMarketing),
        margin: p.revenue > 0 ? (profit / p.revenue) * 100 : 0,
        estimatedShare: p.revenue > 0 ? p.unknownRevenue / p.revenue : 0,
        weeksWithSales,
        weeksTotal,
        cv: enoughData ? cv : null,
        xyz: enoughData ? xyzClass(cv) : null,
      };
    });

    // --- ABC: накопленная доля вклада ---
    const valueOf = (r) => (byProfit ? r.profit : r.revenue);
    rows.sort((a, b) => valueOf(b) - valueOf(a));

    // Знаменатель — сумма только ПОЛОЖИТЕЛЬНЫХ вкладов: убыточный товар не "уменьшает"
    // вклад прибыльных, иначе при большом убытке накопленная доля улетает за 100%.
    const positiveTotal = rows.reduce((s, r) => s + Math.max(0, valueOf(r)), 0);
    let cumulative = 0;
    for (const row of rows) {
      const value = valueOf(row);
      row.share = positiveTotal > 0 ? (Math.max(0, value) / positiveTotal) * 100 : 0;
      cumulative += row.share;
      row.cumulativeShare = cumulative;
      // Товар в минусе не может быть группой A, чем бы ни была накопленная доля.
      if (value <= 0) row.abc = 'C';
      else if (cumulative <= ABC_A) row.abc = 'A';
      else if (cumulative <= ABC_B) row.abc = 'B';
      else row.abc = 'C';
      row.loss = value < 0;
    }

    // --- матрица 3x3 ---
    const matrix = [];
    for (const abc of ['A', 'B', 'C']) {
      for (const xyz of ['X', 'Y', 'Z', null]) {
        const cell = rows.filter((r) => r.abc === abc && r.xyz === xyz);
        if (cell.length === 0) continue;
        matrix.push({
          abc,
          xyz,
          products: cell.length,
          revenue: cell.reduce((s, r) => s + r.revenue, 0),
          profit: cell.reduce((s, r) => s + r.profit, 0),
        });
      }
    }

    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    const totalProfit = rows.reduce((s, r) => s + r.profit, 0);
    const aRows = rows.filter((r) => r.abc === 'A');

    res.json({
      products: rows,
      matrix,
      totals: {
        products: rows.length,
        revenue: totalRevenue,
        profit: totalProfit,
        quantity: rows.reduce((s, r) => s + r.quantity, 0),
        aProducts: aRows.length,
        aShare: positiveTotal > 0 ? aRows.reduce((s, r) => s + Math.max(0, valueOf(r)), 0) / positiveTotal * 100 : 0,
        lossProducts: rows.filter((r) => r.loss).length,
        lossAmount: Math.round(rows.filter((r) => r.loss).reduce((s, r) => s + r.profit, 0)),
        noDataProducts: rows.filter((r) => r.xyz === null).length,
      },
      weeks: weeksTotal,
      basis: byProfit ? 'profit' : 'revenue',
      // Доля выручки, по которой прибыль не посчитана точно, а оценена (нет отчёта Kaspi Pay).
      estimatedRevenueShare: totalRevenue > 0 ? estimatedRevenue / totalRevenue : 0,
      thresholds: { abcA: ABC_A, abcB: ABC_B, xyzX: XYZ_X, xyzY: XYZ_Y, minWeeks: MIN_WEEKS, minUnits: MIN_UNITS },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось построить ABC/XYZ-анализ' });
  }
});

module.exports = router;
