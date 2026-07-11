const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { pool } = require('../db');
const { computeCosts } = require('../costEngine');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Колонки, из которых складывается общая сумма комиссий за операцию.
// Все эти значения в исходном файле уже со знаком минус (расход) —
// для возвратов Kaspi проставляет плюс, поэтому просто суммируем как есть.
const COMMISSION_COLUMNS = [
  'Комиссия за операции (т)',
  'Комиссия за операции по карте (т)',
  'Комиссия Kaspi Pay (т)',
];

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(num) ? num : 0;
}

// Даты в файле Kaspi — строка "02.07.2026" либо, реже, Excel serial date number
function parseKaspiDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (!date) return null;
    return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  }
  const match = String(value).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

// Ищем строку заголовков — это первая строка, где в первой ячейке стоит "#"
function findHeaderRowIndex(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i] && String(rows[i][0]).trim() === '#') return i;
  }
  return -1;
}

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не загружен' });
  }

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: 'Не удалось прочитать файл — убедитесь, что это .xlsx выгруженный из Kaspi Pay' });
  }

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) {
    return res.status(400).json({ error: 'Не найдена строка заголовков — это точно отчёт по операциям Kaspi Pay?' });
  }

  const headers = rows[headerRowIndex].map((h) => String(h).trim());
  const colIndex = (name) => headers.indexOf(name);

  const idx = {
    orderNumber: colIndex('Номер заказа (ID/RRN)'),
    date: colIndex('Дата операции'),
    time: colIndex('Время'),
    type: colIndex('Тип операции'),
    product: colIndex('Детали покупки'),
    amount: colIndex('Сумма операции (т)'),
    delivery: colIndex('Стоимость услуги за Kaspi Доставку'),
  };

  if (idx.orderNumber === -1 || idx.date === -1 || idx.amount === -1) {
    return res.status(400).json({ error: 'В файле не хватает ожидаемых колонок — формат отчёта не распознан' });
  }

  const commissionIdx = COMMISSION_COLUMNS.map(colIndex).filter((i) => i !== -1);

  const records = [];
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const orderNumber = String(row[idx.orderNumber] || '').trim();
    const date = parseKaspiDate(row[idx.date]);
    if (!orderNumber || !date) continue;

    const time = idx.time !== -1 ? String(row[idx.time] || '') : '';
    const type = idx.type !== -1 ? String(row[idx.type] || '') : '';
    const amount = parseNumber(row[idx.amount]);
    const commissionTotal = commissionIdx.reduce((sum, ci) => sum + parseNumber(row[ci]), 0);

    // У одного заказа может быть несколько операций (например, покупка и её возврат
    // делят один и тот же "Номер заказа") — поэтому ключ строим составной, а не просто по номеру заказа.
    const rowKey = `${orderNumber}_${date}_${time}_${type}_${amount}`;

    records.push({
      rowKey,
      orderNumber,
      date,
      type,
      product: idx.product !== -1 ? String(row[idx.product] || '') : '',
      amount,
      commissionTotal,
      deliveryCost: idx.delivery !== -1 ? parseNumber(row[idx.delivery]) : 0,
    });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: 'В файле не найдено ни одной строки с данными' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      await client.query(
        `INSERT INTO kaspi_pay_transactions (row_key, order_number, operation_date, operation_type, product_name, amount, commission_total, delivery_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (row_key) DO UPDATE SET
           operation_date = EXCLUDED.operation_date,
           operation_type = EXCLUDED.operation_type,
           product_name = EXCLUDED.product_name,
           amount = EXCLUDED.amount,
           commission_total = EXCLUDED.commission_total,
           delivery_cost = EXCLUDED.delivery_cost,
           uploaded_at = now()`,
        [r.rowKey, r.orderNumber, r.date, r.type, r.product, r.amount, r.commissionTotal, r.deliveryCost]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Не удалось сохранить данные в базу' });
  } finally {
    client.release();
  }

  res.json({ ok: true, processed: records.length });
});

const TAX_RATE = 0.03; // 3% с оборота (упрощённый режим ИП)

const MAIN_CITIES = ['Алматы', 'Астана'];
const SELF_BUY_CITIES = ['Талдыкорган', 'Юбилейное'];

// warehouses — необязательный список городов. Номер заказа в Excel-отчёте Kaspi Pay совпадает
// с orders.code, поэтому можно связать операции с городом отгрузки через эту связку.
async function aggregateKaspiPayMonthly(warehouses) {
  const joinAndFilter = warehouses
    ? `LEFT JOIN orders o ON o.code = kpt.order_number WHERE o.origin_city = ANY($1::text[])`
    : '';

  const result = await pool.query(
    `SELECT
       to_char(kpt.operation_date, 'YYYY-MM') AS month,
       SUM(CASE WHEN kpt.operation_type = 'Возврат' THEN kpt.amount ELSE 0 END) AS returns_amount,
       SUM(CASE WHEN kpt.operation_type != 'Возврат' THEN kpt.amount ELSE 0 END) AS purchases_amount,
       SUM(kpt.commission_total) AS commission_total,
       SUM(kpt.delivery_cost) AS delivery_total,
       COUNT(*) AS operations_count
     FROM kaspi_pay_transactions kpt
     ${joinAndFilter}
     GROUP BY month
     ORDER BY month DESC`,
    warehouses ? [warehouses] : []
  );

  const { cogsByMonth, returnsCostByMonth } = await computeCosts(warehouses);

  return result.rows.map((row) => {
    const revenue = Number(row.purchases_amount); // выручка от продаж (без возвратов)
    const costOfGoods = cogsByMonth[row.month] || 0; // себестоимость проданных товаров (FIFO)
    const costOfReturns = returnsCostByMonth[row.month] || 0; // информационно, не влияет на прибыль
    const returns = -Number(row.returns_amount); // сумма возвратов как положительное число
    const netRevenue = revenue - returns; // чистый оборот после возвратов — база для налога и маржи

    const commission = -Number(row.commission_total); // положительное число — расход
    const delivery = -Number(row.delivery_total); // положительное число — расход
    const taxes = netRevenue > 0 ? netRevenue * TAX_RATE : 0;

    const netProfit = netRevenue - costOfGoods - commission - delivery - taxes;
    const totalExpenses = costOfGoods + commission + delivery + taxes;

    const margin = netRevenue !== 0 ? (netProfit / netRevenue) * 100 : null;
    const roi = totalExpenses !== 0 ? (netProfit / totalExpenses) * 100 : null;

    return {
      month: row.month,
      revenue,
      cost_of_goods: costOfGoods,
      cost_of_returns: costOfReturns,
      returns,
      net_revenue: netRevenue,
      commission,
      delivery,
      taxes,
      net_profit: netProfit,
      margin,
      roi,
      operations_count: Number(row.operations_count),
    };
  });
}

// Категория "Прочие затраты" из гугл-таблицы расходов — операционные расходы (реклама, зарплата,
// доставка и т.д.). "Товар" сюда не включаем — это уже учтено через себестоимость (FIFO по партиям).
// "Вывод" тоже не включаем — это выводы/дивиденды собственника, а не расход бизнеса.
const OTHER_EXPENSES_CATEGORY = 'Прочие затраты';

async function fetchOtherExpensesByMonth() {
  const result = await pool.query(
    `SELECT to_char(expense_date, 'YYYY-MM') AS month, SUM(amount) AS total
     FROM expenses
     WHERE category = $1 AND expense_date IS NOT NULL
     GROUP BY month`,
    [OTHER_EXPENSES_CATEGORY]
  );
  const map = {};
  for (const row of result.rows) {
    map[row.month] = Number(row.total);
  }
  return map;
}

// Категория "Упаковка" из той же гугл-таблицы расходов — расходы на фулфилмент (упаковка,
// обработка заказов, хранение и т.д.), вносятся вручную. Не привязана к городу отгрузки,
// поэтому считается по всему магазину целиком и подмешивается только в "Основной отчёт" —
// та же логика, что и у OTHER_EXPENSES_CATEGORY выше.
const PACKAGING_EXPENSES_CATEGORY = 'Упаковка';

async function fetchPackagingExpensesByMonth() {
  const result = await pool.query(
    `SELECT to_char(expense_date, 'YYYY-MM') AS month, SUM(amount) AS total
     FROM expenses
     WHERE category = $1 AND expense_date IS NOT NULL
     GROUP BY month`,
    [PACKAGING_EXPENSES_CATEGORY]
  );
  const map = {};
  for (const row of result.rows) {
    map[row.month] = Number(row.total);
  }
  return map;
}

// Разбивка "Основного отчёта" по товарам за конкретный месяц — то же самое, что строка месяца
// в MAIN_COLUMNS, только на уровне каждого товара. Себестоимость (и её версия для возвратов)
// берётся из computeCosts напрямую по товару — она точная (FIFO). А вот комиссия, доставка и сумма
// возвратов в Excel-отчёте Kaspi Pay привязаны только к заказу целиком, а не к конкретному товару
// внутри него — поэтому эти три величины распределяются между товарами заказа пропорционально их
// доле в выручке заказа (сумме order_items.total_price). Для заказов с одним товаром это точно,
// для заказов с несколькими товарами — обоснованная оценка. Реклама и оба вида бонусов
// разносятся по товарам через привязку кампания→товар — точнее, чем проценты выше, но тоже
// поровну между товарами одной кампании, если их несколько. "Прочие расходы" на уровне товара
// не считаем вообще (см. фронтенд) — это расход бизнеса в целом, а не конкретного товара.
async function getProductBreakdownForMonth(month, warehouses) {
  const { cogsByProductMonth, returnsCostByProductMonth } = await computeCosts(warehouses);
  const productCogs = cogsByProductMonth[month] || {};
  const productReturnsCost = returnsCostByProductMonth[month] || {};
  const [productAdMarketing, productBonusMarketing, productReviewMarketing] = await Promise.all([
    getAdMarketingByProductForMonth(month),
    getBonusMarketingByProductForMonth(month),
    getReviewMarketingByProductForMonth(month),
  ]);

  const ordersResult = await pool.query(
    `SELECT kpt.order_number,
       SUM(CASE WHEN kpt.operation_type = 'Возврат' THEN kpt.amount ELSE 0 END) AS returns_amount,
       SUM(kpt.commission_total) AS commission_total,
       SUM(kpt.delivery_cost) AS delivery_total
     FROM kaspi_pay_transactions kpt
     JOIN orders o ON o.code = kpt.order_number
     WHERE to_char(kpt.operation_date, 'YYYY-MM') = $1
       AND o.origin_city = ANY($2::text[])
     GROUP BY kpt.order_number`,
    [month, warehouses]
  );

  if (ordersResult.rows.length === 0) return [];

  const orderNumbers = ordersResult.rows.map((r) => r.order_number);
  const itemsResult = await pool.query(
    `SELECT o.code AS order_number, oi.product_id, oi.product_name, oi.total_price
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.code = ANY($1::text[])`,
    [orderNumbers]
  );

  const itemsByOrder = new Map();
  for (const item of itemsResult.rows) {
    if (!itemsByOrder.has(item.order_number)) itemsByOrder.set(item.order_number, []);
    itemsByOrder.get(item.order_number).push(item);
  }

  const products = new Map(); // key -> накопитель

  function getProduct(key, name) {
    if (!products.has(key)) {
      products.set(key, { product_id: key, product_name: name, revenue: 0, returnsRaw: 0, commissionRaw: 0, deliveryRaw: 0 });
    }
    return products.get(key);
  }

  for (const order of ordersResult.rows) {
    const items = itemsByOrder.get(order.order_number) || [];
    if (items.length === 0) continue;
    const itemsTotal = items.reduce((sum, it) => sum + Number(it.total_price), 0);

    for (const item of items) {
      const key = item.product_id || `name:${item.product_name}`;
      const share = itemsTotal > 0 ? Number(item.total_price) / itemsTotal : 1 / items.length;
      const p = getProduct(key, item.product_name);
      p.revenue += Number(item.total_price);
      p.returnsRaw += Number(order.returns_amount) * share;
      p.commissionRaw += Number(order.commission_total) * share;
      p.deliveryRaw += Number(order.delivery_total) * share;
    }
  }

  const rows = Array.from(products.values()).map((p) => {
    const costOfGoods = productCogs[p.product_id] || 0;
    const costOfReturns = productReturnsCost[p.product_id] || 0;
    const marketingAds = productAdMarketing[p.product_id] || 0;
    const marketingBonuses = productBonusMarketing[p.product_id] || 0;
    const marketingReviews = productReviewMarketing[p.product_id] || 0;
    const returns = -p.returnsRaw;
    const commission = -p.commissionRaw;
    const delivery = -p.deliveryRaw;
    const netRevenue = p.revenue - returns;
    const taxes = netRevenue > 0 ? netRevenue * TAX_RATE : 0;
    const netProfit = netRevenue - costOfGoods - commission - delivery - taxes - marketingAds - marketingBonuses - marketingReviews;
    // ROI считается только от "вложений" в товар (себестоимость + реклама + оба вида бонусов) —
    // комиссия, доставка и налоги в знаменатель не входят, это не инвестиция, а транзакционные
    // издержки Kaspi.
    const totalExpenses = costOfGoods + marketingAds + marketingBonuses + marketingReviews;
    const margin = netRevenue !== 0 ? (netProfit / netRevenue) * 100 : null;
    const roi = totalExpenses !== 0 ? (netProfit / totalExpenses) * 100 : null;

    return {
      product_id: p.product_id,
      product_name: p.product_name || '(без названия)',
      revenue: p.revenue,
      cost_of_goods: costOfGoods,
      returns,
      cost_of_returns: costOfReturns,
      commission,
      delivery,
      taxes,
      marketing_ads: marketingAds,
      marketing_bonuses: marketingBonuses,
      marketing_reviews: marketingReviews,
      net_profit: netProfit,
      margin,
      roi,
    };
  });

  rows.sort((a, b) => b.revenue - a.revenue);
  return rows;
}

// Общий шаблон для "разнести расход по кампаниям на конкретный товар через таблицу привязки" —
// используется и для рекламы (ad_expenses/ad_campaign_products), и для бонусов от продавца
// (bonus_expenses/bonus_campaign_products). Кампания без сохранённой привязки к товару в
// разбивку по товарам не попадает (её расход остаётся только в сумме по месяцу).
async function getCampaignCostByProductForMonth(month, costTable, costColumn, linkTable) {
  const costResult = await pool.query(
    `SELECT campaign_id, SUM(${costColumn}) AS total_cost
     FROM ${costTable}
     WHERE to_char(expense_date, 'YYYY-MM') = $1
     GROUP BY campaign_id`,
    [month]
  );
  if (costResult.rows.length === 0) return {};

  const campaignIds = costResult.rows.map((r) => r.campaign_id);
  const productsResult = await pool.query(
    `SELECT campaign_id, product_id FROM ${linkTable} WHERE campaign_id = ANY($1::text[])`,
    [campaignIds]
  );
  const productsByCampaign = new Map();
  for (const row of productsResult.rows) {
    if (!productsByCampaign.has(row.campaign_id)) productsByCampaign.set(row.campaign_id, []);
    productsByCampaign.get(row.campaign_id).push(row.product_id);
  }

  const costByProduct = {};
  for (const row of costResult.rows) {
    const productIds = productsByCampaign.get(row.campaign_id) || [];
    if (productIds.length === 0) continue;
    const share = Number(row.total_cost) / productIds.length;
    for (const productId of productIds) {
      costByProduct[productId] = (costByProduct[productId] || 0) + share;
    }
  }
  return costByProduct;
}

function getAdMarketingByProductForMonth(month) {
  return getCampaignCostByProductForMonth(month, 'ad_expenses', 'cost', 'ad_campaign_products');
}

function getBonusMarketingByProductForMonth(month) {
  return getCampaignCostByProductForMonth(month, 'bonus_expenses', 'bonus_amount', 'bonus_campaign_products');
}

function getReviewMarketingByProductForMonth(month) {
  return getCampaignCostByProductForMonth(month, 'review_bonus_expenses', 'bonus_amount', 'review_bonus_campaign_products');
}

// Общий шаблон "сумма расхода по месяцам" — используется для рекламы, бонусов от продавца и
// бонусов за отзыв: у всех трёх одна и та же форма (expense_date + сумма), просто разные таблицы/колонки.
async function fetchExpenseByMonth(table, column) {
  const result = await pool.query(
    `SELECT to_char(expense_date, 'YYYY-MM') AS month, SUM(${column}) AS total
     FROM ${table}
     GROUP BY month`
  );
  const map = {};
  for (const row of result.rows) {
    map[row.month] = Number(row.total);
  }
  return map;
}

// "Маркетинг" в Основном отчёте — сумма всех трёх источников продвижения товара: реклама
// (ad_expenses), бонусы от продавца (bonus_expenses) и бонусы за отзыв (review_bonus_expenses).
// Ни один из них не привязан к городу отгрузки, поэтому считаются по всему магазину целиком.
async function fetchMarketingByMonth() {
  const [ads, bonuses, reviews] = await Promise.all([
    fetchExpenseByMonth('ad_expenses', 'cost'),
    fetchExpenseByMonth('bonus_expenses', 'bonus_amount'),
    fetchExpenseByMonth('review_bonus_expenses', 'bonus_amount'),
  ]);
  const months = new Set([...Object.keys(ads), ...Object.keys(bonuses), ...Object.keys(reviews)]);
  const map = {};
  for (const month of months) {
    map[month] = (ads[month] || 0) + (bonuses[month] || 0) + (reviews[month] || 0);
  }
  return map;
}

router.get('/monthly/:month/products', async (req, res) => {
  const { month } = req.params;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Параметр month обязателен, формат: YYYY-MM' });
  }
  try {
    const products = await getProductBreakdownForMonth(month, MAIN_CITIES);
    res.json({ products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить разбивку по товарам' });
  }
});

router.get('/monthly', async (req, res) => {
  try {
    const [months, monthsMainCities, monthsSelfBuyCities, otherExpensesByMonth, marketingByMonth, packagingByMonth] = await Promise.all([
      aggregateKaspiPayMonthly(),
      aggregateKaspiPayMonthly(MAIN_CITIES),
      aggregateKaspiPayMonthly(SELF_BUY_CITIES),
      fetchOtherExpensesByMonth(),
      fetchMarketingByMonth(),
      fetchPackagingExpensesByMonth(),
    ]);

    // В "Основной отчёт" (Алматы+Астана) подмешиваем прочие расходы из "Расходов", расходы на
    // рекламу из "Маркетинга" и расходы на упаковку (категория "Упаковка" в "Расходах"),
    // пересчитываем чистую прибыль/маржу/ROI с их учётом — в остальных двух таблицах этих
    // колонок не нужно.
    const monthsMainCitiesWithExpenses = monthsMainCities.map((row) => {
      const otherExpenses = otherExpensesByMonth[row.month] || 0;
      const marketing = marketingByMonth[row.month] || 0;
      const packaging = packagingByMonth[row.month] || 0;
      const netProfit = row.net_profit - otherExpenses - marketing - packaging;
      // ROI = чистая прибыль / (себестоимость + маркетинг + упаковка + прочие расходы) —
      // комиссия, доставка и налоги в знаменатель не входят, это не инвестиция, а транзакционные
      // издержки Kaspi.
      const totalExpenses = row.cost_of_goods + marketing + packaging + otherExpenses;
      const margin = row.net_revenue !== 0 ? (netProfit / row.net_revenue) * 100 : null;
      const roi = totalExpenses !== 0 ? (netProfit / totalExpenses) * 100 : null;

      return {
        ...row,
        marketing,
        packaging,
        other_expenses: otherExpenses,
        net_profit: netProfit,
        margin,
        roi,
      };
    });

    res.json({ months, monthsMainCities: monthsMainCitiesWithExpenses, monthsSelfBuyCities });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить отчёт' });
  }
});

module.exports = router;
module.exports.aggregateKaspiPayMonthly = aggregateKaspiPayMonthly;
module.exports.fetchOtherExpensesByMonth = fetchOtherExpensesByMonth;
module.exports.fetchMarketingByMonth = fetchMarketingByMonth;
module.exports.fetchPackagingExpensesByMonth = fetchPackagingExpensesByMonth;
module.exports.getProductBreakdownForMonth = getProductBreakdownForMonth;
module.exports.MAIN_CITIES = MAIN_CITIES;
module.exports.SELF_BUY_CITIES = SELF_BUY_CITIES;
