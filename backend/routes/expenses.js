const express = require('express');
const axios = require('axios');
const XLSX = require('xlsx');
const { pool } = require('../db');

const router = express.Router();

// Лист "Расход" в гугл-таблице владельца. Доступ открыт по ссылке ("Все у кого есть ссылка → Читатель"),
// поэтому можно читать через публичный CSV-экспорт Google Sheets, без ключей и сервисных аккаунтов.
const SPREADSHEET_ID = '1vFY-Oyp426_aPn41fEhLa9YqHchlqeQ8jMhs685IDEk';
const SHEET_GID = '2038389366';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

// В таблице даты в формате ДД/ММ/ГГГГ
function parseSheetDate(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function findCol(headers, ...candidates) {
  for (const candidate of candidates) {
    const idx = headers.findIndex((h) => h.trim().toLowerCase() === candidate.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

router.post('/sync', async (req, res) => {
  let csvText;
  try {
    const response = await axios.get(CSV_URL, { timeout: 15000 });
    csvText = response.data;
  } catch (err) {
    console.error('Не удалось скачать гугл-таблицу:', err.message);
    return res.status(502).json({
      error: 'Не удалось скачать данные из Google Таблицы. Проверьте, что доступ по ссылке открыт ("Все у кого есть ссылка → Читатель").',
    });
  }

  let rows;
  try {
    const workbook = XLSX.read(csvText, { type: 'string', raw: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Не удалось разобрать данные из таблицы' });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Таблица пустая' });
  }

  const headers = rows[0].map((h) => String(h || ''));
  const idx = {
    date: findCol(headers, 'Дата'),
    name: findCol(headers, 'Наименования', 'Наименование'),
    category: findCol(headers, 'Категория'),
    source: findCol(headers, 'From', 'Откуда'),
    amount: findCol(headers, 'Сумма'),
    comment: findCol(headers, 'Коментарий', 'Комментарий'),
  };

  if (idx.date === -1 || idx.amount === -1) {
    return res.status(400).json({ error: 'Не найдены ожидаемые колонки (Дата, Сумма) — проверьте структуру листа "Расход"' });
  }

  const records = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((cell) => cell === '' || cell === null || cell === undefined)) continue;

    const date = parseSheetDate(row[idx.date]);
    const amount = parseNumber(row[idx.amount]);
    if (!date && !amount) continue; // пустая/технический мусор строка

    records.push({
      date,
      name: idx.name !== -1 ? String(row[idx.name] || '') : '',
      category: idx.category !== -1 ? String(row[idx.category] || '') : '',
      source: idx.source !== -1 ? String(row[idx.source] || '') : '',
      amount,
      comment: idx.comment !== -1 ? String(row[idx.comment] || '') : '',
      rowIndex: i + 1, // +1 т.к. считаем от 1 и первая строка — заголовок
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE expenses');
    for (const r of records) {
      await client.query(
        `INSERT INTO expenses (expense_date, name, category, source, amount, comment, row_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.date, r.name, r.category, r.source, r.amount, r.comment, r.rowIndex]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Не удалось сохранить расходы в базу' });
  } finally {
    client.release();
  }

  res.json({ ok: true, processed: records.length });
});

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, expense_date, name, category, source, amount, comment, synced_at
       FROM expenses
       ORDER BY expense_date DESC NULLS LAST, row_index DESC`
    );
    res.json({ expenses: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список расходов' });
  }
});

router.get('/monthly', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT to_char(expense_date, 'YYYY-MM') AS month, category, SUM(amount) AS total, COUNT(*) AS records_count
      FROM expenses
      WHERE expense_date IS NOT NULL
      GROUP BY month, category
      ORDER BY month DESC
    `);

    const monthsMap = new Map();
    const categoriesSet = new Set();

    for (const row of result.rows) {
      const category = row.category || 'Без категории';
      categoriesSet.add(category);

      if (!monthsMap.has(row.month)) {
        monthsMap.set(row.month, { month: row.month, total: 0, records_count: 0, byCategory: {} });
      }
      const monthEntry = monthsMap.get(row.month);
      const amount = Number(row.total);
      monthEntry.byCategory[category] = (monthEntry.byCategory[category] || 0) + amount;
      monthEntry.total += amount;
      monthEntry.records_count += Number(row.records_count);
    }

    const months = Array.from(monthsMap.values()).sort((a, b) => (a.month < b.month ? 1 : -1));
    const categories = Array.from(categoriesSet).sort();

    res.json({ months, categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить расходы по месяцам' });
  }
});

module.exports = router;
