const express = require('express');
const axios = require('axios');
const { pool } = require('../db');
const { aggregateKaspiPayMonthly, fetchOtherExpensesByMonth, fetchMarketingByMonth, fetchPackagingExpensesByMonth, getProductBreakdownForMonth, MAIN_CITIES, SELF_BUY_CITIES } = require('./reports');
const { computeWarehouseStock, DISPLAY_WAREHOUSES } = require('./warehouse');

const router = express.Router();

const TAX_RATE = 0.03;
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// Список месяцев 'YYYY-MM', покрывающих диапазон from..to (по границам месяца, включительно).
function monthsBetween(fromMonth, toMonth) {
  const months = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [toY, toM] = toMonth.split('-').map(Number);
  while (y < toY || (y === toY && m <= toM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
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
  const [monthsMainCities, otherExpensesByMonth, marketingByMonth, packagingByMonth] = await Promise.all([
    aggregateKaspiPayMonthly(MAIN_CITIES),
    fetchOtherExpensesByMonth(),
    fetchMarketingByMonth(),
    fetchPackagingExpensesByMonth(),
  ]);

  const rows = monthsMainCities.slice(0, 6).map((row) => {
    const otherExpenses = otherExpensesByMonth[row.month] || 0;
    const marketing = marketingByMonth[row.month] || 0;
    const packaging = packagingByMonth[row.month] || 0;
    const netProfit = row.net_profit - otherExpenses - marketing - packaging;
    // ROI = чистая прибыль / (себестоимость + маркетинг + упаковка + прочие расходы) — та же
    // формула, что и на странице "Отчёт" (комиссия/доставка/налоги в знаменатель не входят).
    const totalExpenses = row.cost_of_goods + marketing + packaging + otherExpenses;
    const margin = row.net_revenue !== 0 ? (netProfit / row.net_revenue) * 100 : null;
    const roi = totalExpenses !== 0 ? (netProfit / totalExpenses) * 100 : null;
    return { ...row, marketing, packaging, other_expenses: otherExpenses, net_profit: netProfit, margin, roi };
  });

  if (rows.length === 0) return 'Нет данных помесячного отчёта (не загружен Excel-отчёт Kaspi Pay).';

  return rows
    .map((r) => (
      `${r.month}: выручка ${fmt(r.net_revenue)}, себестоимость ${fmt(r.cost_of_goods)}, возвраты ${fmt(r.returns)}, ` +
      `комиссия ${fmt(r.commission)}, доставка ${fmt(r.delivery)}, налоги ${fmt(r.taxes)}, маркетинг ${fmt(r.marketing)}, ` +
      `упаковка ${fmt(r.packaging)}, прочие расходы ${fmt(r.other_expenses)}, чистая прибыль ${fmt(r.net_profit)}, ` +
      `маржа ${pct(r.margin)}, ROI ${pct(r.roi)}`
    ))
    .join('\n');
}

// Маржа по товарам — переиспользует ту же самую точную помесячную разбивку, что и таблица
// на странице "Отчёт" (клик по строке месяца): себестоимость по FIFO, плюс комиссия, доставка,
// налог и маркетинг, распределённые на товар. Период AI Финансиста может быть произвольным (не
// обязательно целым месяцем), поэтому считаем по каждому затронутому календарному месяцу
// (getProductBreakdownForMonth) и складываем по товару — margin/ROI пересчитываются из суммарных
// цифр, а не усредняются по месяцам.
async function getProductMarginsText(from, to) {
  const months = monthsBetween(from.slice(0, 7), to.slice(0, 7));
  const breakdownsByMonth = await Promise.all(months.map((month) => getProductBreakdownForMonth(month, MAIN_CITIES)));

  const totals = new Map(); // product_id -> накопитель
  for (const rows of breakdownsByMonth) {
    for (const r of rows) {
      if (!totals.has(r.product_id)) {
        totals.set(r.product_id, {
          product_name: r.product_name,
          revenue: 0,
          returns: 0,
          net_profit: 0,
        });
      }
      const acc = totals.get(r.product_id);
      acc.revenue += Number(r.revenue);
      acc.returns += Number(r.returns);
      acc.net_profit += Number(r.net_profit);
    }
  }

  if (totals.size === 0) return 'Нет продаж за выбранный период.';

  // Количество проданного — той же логикой фильтрации (главные города, без самовыкупов),
  // что и остальные цифры в этом разделе; чисто информационная деталь для AI, на маржу не влияет.
  const qtyResult = await pool.query(
    `SELECT oi.product_id, SUM(oi.quantity) AS qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.creation_date >= $1::timestamp - interval '5 hours'
       AND oi.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
       AND o.status = ANY($3::text[])
       AND o.origin_city = ANY($4::text[])
     GROUP BY oi.product_id`,
    [from, to, VALID_STATUSES, MAIN_CITIES]
  );
  const qtyByProduct = new Map(qtyResult.rows.map((r) => [r.product_id, Number(r.qty)]));

  const rows = Array.from(totals.entries())
    .map(([productId, acc]) => {
      const netRevenue = acc.revenue - acc.returns;
      const margin = netRevenue !== 0 ? (acc.net_profit / netRevenue) * 100 : null;
      return { ...acc, qty: qtyByProduct.get(productId) || 0, margin };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 40);

  return rows
    .map((r) => (
      `${r.product_name}: продано ${r.qty} шт, выручка ${fmt(r.revenue)}, чистая прибыль ${fmt(r.net_profit)}, ` +
      `маржа (с учётом себестоимости FIFO, комиссии, доставки, налога и маркетинга — как в «Отчёте») ${pct(r.margin)}`
    ))
    .join('\n');
}

// Остатки на складе — что зависло без движения (много товара, ноль/мало продаж) и где уже
// продано больше, чем известно поставок (не отражена реальная себестоимость).
// Переиспользуем computeWarehouseStock из warehouse.js — тот же расчёт, что и на странице
// "Склад" (FIFO по факту продаж). Раньше здесь ошибочно читалась product_batches.remaining_quantity
// напрямую из базы — эта колонка не уменьшается при продажах и по факту показывает "Поставлено",
// а не реальный остаток.
async function getWarehouseRisksText() {
  const products = await computeWarehouseStock();
  const rows = products
    .filter((p) => DISPLAY_WAREHOUSES.includes(p.warehouse) && p.remaining > 0)
    .sort((a, b) => b.remaining_value - a.remaining_value)
    .slice(0, 15);

  if (rows.length === 0) return 'Нет данных по остаткам.';
  return rows
    .map((p) => `${p.product_name} (${p.warehouse}): остаток ${p.remaining} шт, "заморожено" в остатке ~${fmt(p.remaining_value)}`)
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

=== ПРОДАЖИ ПО ТОВАРАМ ЗА ПЕРИОД ${from} — ${to} (выручка, кол-во, чистая прибыль, маржа с учётом всех расходов) ===
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

    // Сохраняем сразу же, чтобы отчёт не потерялся при уходе со страницы и не пришлось
    // генерировать заново (и тратить токены API) — на странице есть история отчётов.
    const saved = await pool.query(
      `INSERT INTO analyst_reports (period_from, period_to, report_text) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [from, to, reportText]
    );

    res.json({ report: reportText, id: saved.rows[0].id, created_at: saved.rows[0].created_at });
  } catch (err) {
    console.error('Ошибка AI-финансиста:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Не удалось получить отчёт от AI. Проверьте ANTHROPIC_API_KEY и баланс на счету Anthropic.' });
  }
});

// Список сохранённых отчётов (без текста — он может быть длинным, текст подгружается отдельно
// только когда открывают конкретный отчёт).
router.get('/reports', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, period_from, period_to, created_at FROM analyst_reports ORDER BY created_at DESC`
    );
    res.json({ reports: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список сохранённых отчётов' });
  }
});

router.get('/reports/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, period_from, period_to, report_text, created_at FROM analyst_reports WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Отчёт не найден — возможно, уже удалён' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить отчёт' });
  }
});

router.delete('/reports/:id', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM analyst_reports WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Отчёт не найден — возможно, уже удалён' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить отчёт' });
  }
});

module.exports = router;
