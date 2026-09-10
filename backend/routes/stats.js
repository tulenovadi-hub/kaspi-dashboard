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
     WHERE o.origin_city = ANY($1::text[])
     ORDER BY o.origin_city, o.creation_date ASC`,
    [citiesFor(mode)]
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

// Считает % чистой прибыли от выручки по уже известным (есть в Excel-отчёте) продажам за
// произвольное окно дат: и общий по магазину, и ОТДЕЛЬНО ПО КАЖДОМУ ТОВАРУ. Используется как
// запасной вариант, когда в самом запрошенном периоде известных продаж по товару нет
// (см. computeSummaryNetProfit). kptByOrder и costData переиспользуются из основного расчёта —
// они и так покрывают всю историю, а не только период, так что дополнительно запрашивать их
// снова не нужно, только order_items за новое окно дат.
async function computeKnownProfitRatio(from, to, mode, kptByOrder, costData) {
  const itemsResult = await pool.query(
    `SELECT oi.product_id, oi.total_price, o.code AS order_number, o.id AS order_id
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

  let knownNetProfit = 0;
  let knownNetRevenue = 0;
  const byProduct = new Map(); // product_id -> { revenue, profit }

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
    const profitItem = netRevenueItem - cost - commission - delivery - taxes;
    knownNetProfit += profitItem;
    knownNetRevenue += netRevenueItem;

    const stat = byProduct.get(it.product_id) || { revenue: 0, profit: 0 };
    stat.revenue += netRevenueItem;
    stat.profit += profitItem;
    byProduct.set(it.product_id, stat);
  }

  const ratioByProduct = new Map();
  for (const [productId, stat] of byProduct) {
    if (stat.revenue > 0) ratioByProduct.set(productId, stat.profit / stat.revenue);
  }

  return {
    ratio: knownNetRevenue > 0 ? knownNetProfit / knownNetRevenue : null,
    ratioByProduct,
  };
}

// Сумма расходов на маркетинг (реклама + бонусы от продавца + бонусы за отзыв) за произвольный
// диапазон дат — просто SUM того, что реально загружено, без каких-либо прогнозов на
// недостающие дни (в отличие от оценки чистой прибыли по свежим заказам ниже).
// Маркетинг по дням — нужен дневному графику чистой прибыли на телефоне. Все три источника
// хранят дату расхода, поэтому разложить по дням можно честно, а не размазывать итог поровну.
async function fetchMarketingByDay(from, to) {
  const [adsResult, bonusResult, reviewResult] = await Promise.all([
    pool.query(`SELECT expense_date::text AS day, COALESCE(SUM(cost), 0) AS total FROM ad_expenses WHERE expense_date BETWEEN $1 AND $2 GROUP BY expense_date`, [from, to]),
    pool.query(`SELECT expense_date::text AS day, COALESCE(SUM(bonus_amount), 0) AS total FROM bonus_expenses WHERE expense_date BETWEEN $1 AND $2 GROUP BY expense_date`, [from, to]),
    pool.query(`SELECT expense_date::text AS day, COALESCE(SUM(bonus_amount), 0) AS total FROM review_bonus_expenses WHERE expense_date BETWEEN $1 AND $2 GROUP BY expense_date`, [from, to]),
  ]);
  const byDay = new Map();
  for (const rows of [adsResult.rows, bonusResult.rows, reviewResult.rows]) {
    for (const r of rows) {
      const day = String(r.day).slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + Number(r.total));
    }
  }
  return byDay;
}

// Операционные расходы из гугл-таблицы (страница "Расходы"): ровно те же две категории, что
// вычитаются из чистой прибыли в "Отчёте" (routes/reports.js) — иначе цифра на Главной и цифра
// в отчёте за тот же месяц разъехались бы. "Товар" сюда не входит (уже учтён себестоимостью по
// партиям FIFO), "Вывод" тоже (дивиденды собственника, а не расход бизнеса), "Логистика" — это
// карго из Китая, она входит в себестоимость партии, а не в отдельный расход.
const PROFIT_EXPENSE_CATEGORIES = ['Прочие затраты', 'Упаковка'];

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
  const [itemsResult, kptResult, costData, marketing, marketingByDay, opExpensesByDay] = await Promise.all([
    pool.query(
      // day — та же "казахстанская" дата, что и в /summary (сдвиг +5 часов), иначе выручка и
      // прибыль одного заказа попадали бы на разные дни графика.
      `SELECT oi.product_id, oi.quantity, oi.total_price, o.code AS order_number, o.id AS order_id,
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
    mode !== 'selfbuy' ? fetchMarketingTotalForRange(from, to) : Promise.resolve(0),
    mode !== 'selfbuy' ? fetchMarketingByDay(from, to) : Promise.resolve(new Map()),
    // Операционные расходы, как и маркетинг, не привязаны к городу отгрузки — поэтому только
    // на "Главной" (mode !== 'selfbuy'), ровно как колонки "Прочие затраты"/"Упаковка" в
    // "Отчёте" есть лишь в основном отчёте, а не в "Самовыкупах".
    mode !== 'selfbuy' ? fetchOpExpensesByDay(from, to) : Promise.resolve(new Map()),
  ]);

  // Итог за период — сумма тех же дневных долей, что уходят в график, а не отдельный запрос:
  // так число в карточке и сумма точек графика не могут разъехаться в принципе.
  const opExpenses = [...opExpensesByDay.values()].reduce((sum, value) => sum + value, 0);

  // Прибыль по дням — для графика на телефоне. Собирается тем же проходом, что и итог, поэтому
  // сумма дней сходится с числом в карточке: маркетинг вычитается по своим датам (они у него
  // честные, по дням), операционные расходы — равными долями месяца (см. fetchOpExpensesByDay).
  const profitByDay = new Map();
  const estimatedDays = new Set();
  const addDayProfit = (day, value) => profitByDay.set(day, (profitByDay.get(day) || 0) + value);
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
    return { netProfit: -marketing - opExpenses, usedEstimate: false, days: buildDays(), products: [] };
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
    addDayProfit(it.day, netProfitItem);

    const stat = perProductKnown.get(it.product_id) || { revenue: 0, profit: 0 };
    stat.revenue += netRevenueItem;
    stat.profit += netProfitItem;
    perProductKnown.set(it.product_id, stat);
  }

  // Общий % прибыли по всем известным продажам за период — самый грубый запасной вариант.
  let overallRatio = knownNetRevenue > 0 ? knownNetProfit / knownNetRevenue : null;

  // Окно пошире — последние 60 дней перед концом периода. Нужно в двух случаях:
  //
  // 1) Известных продаж нет вообще ЗА ВЕСЬ ПЕРИОД (типичный случай — "Сегодня"/"Вчера":
  //    Excel-отчёт по свежим дням физически ещё не мог быть загружен). Без этого вся оценка
  //    молча превратилась бы в 0, хотя реальная выручка есть.
  // 2) У КОНКРЕТНОГО товара нет известных продаж в периоде — тогда его прибыль оценивается
  //    по ЕГО ЖЕ проценту за это окно, а не по среднему по магазину. Иначе в начале месяца,
  //    когда Excel-отчёта ещё нет ни по одному заказу, все товары получали один и тот же
  //    средний процент — и в разбивке по товарам маржа у всех выходила одинаковой (владелец
  //    заметила ровно это: "подозрительно, что маржа 28% у всех"). Тот же принцип уже
  //    работает в /api/stats/product/:productId — там прогноз тоже по истории этого товара.
  const fallbackFrom = addDays(to, -60);
  const fallback = await computeKnownProfitRatio(fallbackFrom, to, mode, kptByOrder, costData);
  if (overallRatio === null) overallRatio = fallback.ratio;
  if (overallRatio === null) overallRatio = 0;

  // Цепочка запасных вариантов для одного товара: свои известные продажи в периоде →
  // свой процент за 60 дней → средний по магазину.
  function ratioForProduct(productId) {
    const known = perProductKnown.get(productId);
    if (known && known.revenue > 0) return known.profit / known.revenue;
    const historical = fallback.ratioByProduct.get(productId);
    if (historical !== undefined) return historical;
    return overallRatio;
  }

  let estimatedNetProfit = 0;
  // Прибыль по каждому товару — для разбивки под карточкой на Главной. Копит ровно те же
  // слагаемые, что и итог (включая оценку по заказам без Excel-отчёта), поэтому сумма по
  // товарам отличается от карточки строго на маркетинг и операционные расходы: они по
  // магазину целиком и на товары не раскладываются — та же договорённость, что в разбивке
  // по товарам в "Отчёте" (там в строке товара тоже нет прочих затрат и упаковки).
  // Только id и сумма: название фронт берёт из /api/stats/products — там тот же набор
  // товаров (оба считают позиции заказов за один период), так что join по id полный.
  const profitByProduct = new Map();
  for (const [productId, stat] of perProductKnown) {
    profitByProduct.set(productId, stat.profit);
  }
  for (const it of unknownItems) {
    const revenue = Number(it.total_price);
    const ratio = ratioForProduct(it.product_id);
    estimatedNetProfit += revenue * ratio;
    addDayProfit(it.day, revenue * ratio);
    estimatedDays.add(it.day); // в этом дне есть заказы без Excel-отчёта — прибыль дня оценочная
    profitByProduct.set(it.product_id, (profitByProduct.get(it.product_id) || 0) + revenue * ratio);
  }

  return {
    netProfit: knownNetProfit + estimatedNetProfit - marketing - opExpenses,
    usedEstimate: unknownItems.length > 0,
    days: buildDays(),
    products: [...profitByProduct.entries()]
      .map(([productId, profit]) => ({ product_id: productId, net_profit: profit }))
      .sort((a, b) => b.net_profit - a.net_profit),
  };
}

router.get('/summary-profit', async (req, res) => {
  const { from, to, mode } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const { netProfit, usedEstimate, days, products } = await computeSummaryNetProfit(from, to, mode);
    res.json({ net_profit: netProfit, used_estimate: usedEstimate, days, products });
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
