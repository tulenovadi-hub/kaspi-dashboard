const express = require('express');
const axios = require('axios');
const { pool } = require('../db');
const { aggregateKaspiPayMonthly, fetchOtherExpensesByMonth, fetchMarketingByMonth, fetchFFServicesByMonth, MAIN_CITIES, SELF_BUY_CITIES } = require('./reports');

const router = express.Router();

const TAX_RATE = 0.03;
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Math.round(Number(n)).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₸';
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${Number(n).toFixed(1)}%`;
}

// Последние несколько месяцев "Основного отчёта" (Алматы+Астана) — то же самое, что показано
// в таблице на странице "Отчёт", просто переиспользуем готовую функцию оттуда.
async function getMonthlyReportText() {
  const [monthsMainCities, otherExpensesByMonth, marketingByMonth, ffServicesByMonth] = await Promise.all([
    aggregateKaspiPayMonthly(MAIN_CITIES),
    fetchOtherExpensesByMonth(),
    fetchMarketingByMonth(),
    fetchFFServicesByMonth(),
  ]);

  const rows = monthsMainCities.slice(0, 6).map((row) => {
    const otherExpenses = otherExpensesByMonth[row.month] || 0;
    const marketing = marketingByMonth[row.month] || 0;
    const ffServices = ffServicesByMonth[row.month] || 0;
    const netProfit = row.net_profit - otherExpenses - marketing - ffServices;
    // ROI = чистая прибыль / (себестоимость + маркетинг + услуги ФФ + прочие расходы) — та же
    // формула, что и на странице "Отчёт" (комиссия/доставка/налоги в знаменатель не входят).
    const totalExpenses = row.cost_of_goods + marketing + ffServices + otherExpenses;
    const margin = row.net_revenue !== 0 ? (netProfit / row.net_revenue) * 100 : null;
    const roi = totalExpenses !== 0 ? (netProfit / totalExpenses) * 100 : null;
    return { ...row, marketing, ff_services: ffServices, other_expenses: otherExpenses, net_profit: netProfit, margin, roi };
  });

  if (rows.length === 0) return 'Нет данных помесячного отчёта (не загружен Excel-отчёт Kaspi Pay).';

  return rows
    .map((r) => (
      `${r.month}: выручка ${fmt(r.net_revenue)}, себестоимость ${fmt(r.cost_of_goods)}, возвраты ${fmt(r.returns)}, ` +
      `комиссия ${fmt(r.commission)}, доставка ${fmt(r.delivery)}, налоги ${fmt(r.taxes)}, маркетинг ${fmt(r.marketing)}, ` +
      `услуги ФФ ${fmt(r.ff_services)}, прочие расходы ${fmt(r.other_expenses)}, чистая прибыль ${fmt(r.net_profit)}, ` +
      `маржа ${pct(r.margin)}, ROI ${pct(r.roi)}`
    ))
    .join('\n');
}

// Выручка и количество проданного по каждому товару за период + грубая оценка себестоимости
// (по цене последней поставки — этого достаточно для того, чтобы ИИ увидел общую картину
// по марже без необходимости гонять точный FIFO-расчёт по каждому товару).
async function getProductMarginsText(from, to) {
  const itemsResult = await pool.query(
    `SELECT oi.product_id, oi.product_name, SUM(oi.quantity) AS qty, SUM(oi.total_price) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
       AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
       AND o.status = ANY($3::text[])
       AND (o.origin_city IS NULL OR NOT (o.origin_city = ANY($4::text[])))
     GROUP BY oi.product_id, oi.product_name
     ORDER BY revenue DESC
     LIMIT 40`,
    [from, to, VALID_STATUSES, SELF_BUY_CITIES]
  );

  if (itemsResult.rows.length === 0) return 'Нет продаж за выбранный период.';

  const productIds = itemsResult.rows.map((r) => r.product_id);
  const batchesResult = await pool.query(
    `SELECT DISTINCT ON (product_id) product_id, cost_price
     FROM product_batches
     WHERE product_id = ANY($1::text[])
     ORDER BY product_id, received_date DESC, id DESC`,
    [productIds]
  );
  const latestCostByProduct = new Map(batchesResult.rows.map((r) => [r.product_id, Number(r.cost_price)]));

  return itemsResult.rows
    .map((r) => {
      const revenue = Number(r.revenue);
      const qty = Number(r.qty);
      const cost = latestCostByProduct.get(r.product_id);
      const marginPct = cost !== undefined && revenue > 0 ? ((revenue - qty * cost) / revenue) * 100 : null;
      return `${r.product_name}: продано ${qty} шт, выручка ${fmt(revenue)}, ориентировочная маржа (по цене последней закупки, без учёта комиссии/доставки/налога/возвратов) ${pct(marginPct)}`;
    })
    .join('\n');
}

// Остатки на складе — что зависло без движения (много товара, ноль/мало продаж) и где uже
// продано больше, чем известно поставок (не отражена реальная себестоимость).
async function getWarehouseRisksText() {
  const result = await pool.query(
    `SELECT product_id, product_name, warehouse, SUM(quantity) AS supplied, SUM(remaining_quantity) AS remaining,
            MAX(cost_price) AS cost_price
     FROM product_batches
     GROUP BY product_id, product_name, warehouse
     HAVING SUM(remaining_quantity) > 0
     ORDER BY SUM(remaining_quantity) * MAX(cost_price) DESC
     LIMIT 15`
  );
  if (result.rows.length === 0) return 'Нет данных по остаткам.';
  return result.rows
    .map((r) => `${r.product_name} (${r.warehouse}): остаток ${r.remaining} шт, "заморожено" в остатке ~${fmt(r.remaining * r.cost_price)}`)
    .join('\n');
}

// Расходы на рекламу и продажи "по рекламе" по кампаниям за период — из ad_expenses
// (заливается вручную через Tampermonkey-скрипт со страницы Kaspi Pay).
async function getMarketingText(from, to) {
  const result = await pool.query(
    `SELECT campaign_name, SUM(cost) AS cost, SUM(gmv) AS gmv, SUM(transactions) AS transactions
     FROM ad_expenses
     WHERE expense_date BETWEEN $1 AND $2
     GROUP BY campaign_name
     ORDER BY cost DESC
     LIMIT 25`,
    [from, to]
  );
  if (result.rows.length === 0) return 'Данные по рекламе не загружены за этот период.';
  return result.rows
    .map((r) => {
      const cost = Number(r.cost);
      const gmv = Number(r.gmv);
      const drr = gmv > 0 ? (cost / gmv) * 100 : null;
      return `${r.campaign_name}: расход ${fmt(cost)}, продажи по рекламе ${fmt(gmv)}, заказов ${r.transactions}, ДРР ${pct(drr)}`;
    })
    .join('\n');
}

// "Прочие затраты" из гугл-таблицы расходов, детализация по конкретным строкам за период
// (не только сумма по категории, но и на что конкретно потрачено).
async function getExpensesText(from, to) {
  const result = await pool.query(
    `SELECT name, category, SUM(amount) AS total
     FROM expenses
     WHERE expense_date BETWEEN $1 AND $2
     GROUP BY name, category
     ORDER BY total DESC
     LIMIT 25`,
    [from, to]
  );
  if (result.rows.length === 0) return 'Нет данных о расходах за этот период.';
  return result.rows.map((r) => `${r.name || '(без названия)'} [${r.category || '—'}]: ${fmt(r.total)}`).join('\n');
}

router.get('/report', async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'На сервере не настроен ANTHROPIC_API_KEY — без него AI-финансист работать не может.' });
  }

  try {
    const [monthlyReport, productMargins, warehouseRisks, marketing, expenses] = await Promise.all([
      getMonthlyReportText(),
      getProductMarginsText(from, to),
      getWarehouseRisksText(),
      getMarketingText(from, to),
      getExpensesText(from, to),
    ]);

    const prompt = `Ты — опытный финансовый директор (CFO), которого наняли проконсультировать владельца небольшого
интернет-магазина электроники (бренд TOMMILI: проекторы, роботы-стеклоочистители, увлажнители и т.д.),
торгующего через маркетплейс Kaspi.kz в Казахстане.

Ниже — данные из его дашборда. Изучи их и дай короткий, конкретный отчёт на русском языке для человека
без финансового образования — просто, по делу, без канцелярита. Структура отчёта:

1. **Общая картина** — 2-3 предложения о состоянии бизнеса за последние месяцы (тренд прибыли, маржи).
2. **Самые слабые товары** — какие товары наименее маржинальны или продаются в минус с учётом рекламы,
   и что с ними делать (снизить цену закупки, поднять цену продажи, убрать из рекламы, вывести из ассортимента).
3. **Где усилиться** — какие товары наиболее прибыльны и стоит вложиться в них сильнее (больше закупить,
   больше рекламы).
4. **Реклама** — какие кампании неэффективны (высокий ДРР при низкой марже товара) и какие стоит масштабировать.
5. **Склад** — есть ли зависшие остатки (деньги "заморожены" в товаре, который не продаётся).
6. **Прочие расходы** — есть ли что-то подозрительное или то, что стоит оптимизировать.
7. **Топ-3 конкретных действия** на ближайший месяц — самое важное, с чего начать.

Пиши кратко (это должно уместиться на один экран телефона на каждый пункт), используй заголовки списком,
конкретные цифры из данных ниже, без общих фраз вроде "рекомендуется следить за показателями".

=== ПОМЕСЯЧНЫЙ ОТЧЁТ (Алматы+Астана, последние месяцы) ===
${monthlyReport}

=== ПРОДАЖИ ПО ТОВАРАМ ЗА ПЕРИОД ${from} — ${to} (выручка, кол-во, ориентировочная маржа) ===
${productMargins}

=== ОСТАТКИ НА СКЛАДЕ (самые крупные по стоимости остатка) ===
${warehouseRisks}

=== РЕКЛАМА ЗА ПЕРИОД ${from} — ${to} (по кампаниям) ===
${marketing}

=== ПРОЧИЕ РАСХОДЫ ЗА ПЕРИОД ${from} — ${to} (топ по сумме) ===
${expenses}`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );

    const reportText = (response.data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    res.json({ report: reportText });
  } catch (err) {
    console.error('Ошибка AI-финансиста:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Не удалось получить отчёт от AI. Проверьте ANTHROPIC_API_KEY и баланс на счету Anthropic.' });
  }
});

module.exports = router;
