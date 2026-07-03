const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { pool } = require('../db');

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

// Заказы, которые реально считаются продажей (совпадает с логикой в warehouse.js/stats.js)
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];
// Партии на "Поставках" вводятся как остаток на 1 июня — себестоимость считаем только
// для продаж с этой даты, чтобы не задваивать со старыми продажами (та же логика, что на "Складе").
const STOCK_CUTOFF_DATE = '2026-06-01';

const MAIN_CITIES = ['Алматы', 'Астана'];
const SELF_BUY_CITIES = ['Талдыкорган', 'Юбилейное'];

// Считает себестоимость проданных товаров по методу FIFO (та же логика, что на "Складе"),
// но результат группирует по месяцу продажи, а не по остаткам. warehouses — необязательный
// список городов для фильтрации (если не передан — считает по всем городам сразу).
async function computeMonthlyCogs(warehouses) {
  const batchesResult = await pool.query(`
    SELECT product_id, warehouse, cost_price, quantity, received_date
    FROM product_batches
    ORDER BY product_id, warehouse, received_date, id
  `);

  // Себестоимость считаем только за те дни, за которые реально есть выручка в загруженном
  // Excel-отчёте Kaspi Pay — иначе синхронизация заказов (которая идёт постоянно, в отличие
  // от Excel-файла) "убегает" вперёд и себестоимость считается за дни без соответствующей выручки.
  const maxDateResult = await pool.query(`SELECT MAX(operation_date) AS max_date FROM kaspi_pay_transactions`);
  const maxDate = maxDateResult.rows[0].max_date;

  const soldResult = await pool.query(
    `SELECT oi.product_id, o.origin_city AS warehouse, oi.quantity,
            to_char(oi.creation_date + interval '5 hours', 'YYYY-MM') AS month
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status = ANY($1::text[])
       AND o.origin_city IS NOT NULL
       AND o.creation_date >= $2::date
       AND o.creation_date < $3::date + interval '1 day'
       ${warehouses ? 'AND o.origin_city = ANY($4::text[])' : ''}
     ORDER BY oi.product_id, o.origin_city, oi.creation_date ASC`,
    warehouses ? [VALID_STATUSES, STOCK_CUTOFF_DATE, maxDate, warehouses] : [VALID_STATUSES, STOCK_CUTOFF_DATE, maxDate]
  );

  const batchesByKey = new Map();
  for (const b of batchesResult.rows) {
    const key = `${b.product_id}::${b.warehouse}`;
    if (!batchesByKey.has(key)) batchesByKey.set(key, []);
    batchesByKey.get(key).push({ cost_price: Number(b.cost_price), remaining: Number(b.quantity) });
  }

  const cogsByMonth = {};

  for (const row of soldResult.rows) {
    const key = `${row.product_id}::${row.warehouse}`;
    const batches = batchesByKey.get(key);
    if (!batches) continue; // нет партий для этого товара/склада — себестоимость неизвестна, пропускаем

    let qtyToConsume = Number(row.quantity);

    for (const batch of batches) {
      if (qtyToConsume <= 0) break;
      if (batch.remaining <= 0) continue;
      const consume = Math.min(batch.remaining, qtyToConsume);
      batch.remaining -= consume;
      qtyToConsume -= consume;
      cogsByMonth[row.month] = (cogsByMonth[row.month] || 0) + consume * batch.cost_price;
    }
    // если qtyToConsume всё ещё > 0 — партий не хватило (oversold), эта часть остаётся без себестоимости
  }

  return cogsByMonth;
}

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

  const cogsByMonth = await computeMonthlyCogs(warehouses);

  return result.rows.map((row) => {
    const revenue = Number(row.purchases_amount); // выручка от продаж (без возвратов)
    const costOfGoods = cogsByMonth[row.month] || 0; // себестоимость проданных товаров (FIFO)
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

router.get('/monthly', async (req, res) => {
  try {
    const [months, monthsMainCities, monthsSelfBuyCities] = await Promise.all([
      aggregateKaspiPayMonthly(),
      aggregateKaspiPayMonthly(MAIN_CITIES),
      aggregateKaspiPayMonthly(SELF_BUY_CITIES),
    ]);

    res.json({ months, monthsMainCities, monthsSelfBuyCities });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить отчёт' });
  }
});

module.exports = router;
