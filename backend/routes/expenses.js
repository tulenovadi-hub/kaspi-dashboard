const express = require('express');
const axios = require('axios');
const XLSX = require('xlsx');
const { pool } = require('../db');

const router = express.Router();

// Лист "Бизнес" в гугл-таблице владельца (общая книга личных/семейных финансов, куда бизнес-расходы
// пишет мобильное приложение — отсюда колонки "Время", "Кто", "ID"). Доступ открыт по ссылке
// ("Все у кого есть ссылка → Читатель"), поэтому читаем через публичный CSV-экспорт Google Sheets,
// без ключей и сервисных аккаунтов.
// До 2026-08-27 источником был отдельный лист "Расход" в книге 1vFY-Oyp...685IDEk (gid 2038389366) —
// вся его история перенесена сюда, старая книга оставлена только как эталон для сверки.
const SPREADSHEET_ID = '1QZvZ8yS3os8rHyYWwmbe-WOS-fnpBoYj_Uj3ToiYPYY';
const SHEET_GID = '306790768';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

// Даты в листе — текст. Приложение пишет их как ДД.ММ.ГГГГ, в перенесённой истории из старого
// листа "Расход" тот же формат, но встречается и ДД/ММ/ГГГГ — принимаем оба, плюс ISO на случай,
// если Google Таблицы сами превратят ячейку в настоящую дату.
function parseSheetDate(value) {
  if (!value) return null;
  const raw = String(value).trim();

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, year, month, day] = iso;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const dmy = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!dmy) return null;
  const [, day, month, year] = dmy;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// "Отчёт" завязан на ТОЧНЫЕ названия категорий: "Прочие затраты" вычитаются из чистой прибыли,
// "Упаковка" идёт в отчёте отдельной колонкой, а "Товар" и "Вывод" из расходов исключаются
// (товар уже учтён через себестоимость по партиям FIFO, вывод — дивиденды собственника, а не
// расход бизнеса). В приложении, которое пишет в лист, названия категорий свои, поэтому
// приводим их к каноническим здесь, в одном месте. Сравнение без учёта регистра.
const CATEGORY_ALIASES = {
  'прочие затраты': 'Прочие затраты',
  'прочее': 'Прочие затраты',
  'прочие': 'Прочие затраты',
  'операционные расходы': 'Прочие затраты',
  'товар': 'Товар',
  'товары': 'Товар',
  'закуп товара': 'Товар',
  'закупка товара': 'Товар',
  'вывод': 'Вывод',
  'выводы': 'Вывод',
  'дивиденды': 'Вывод',
  'упаковка': 'Упаковка',
  'фулфилмент': 'Упаковка',
  // Логистика — это карго из Китая. Раньше категория называлась "Доставка", но в "Отчёте" уже
  // есть своя колонка "Доставка" — стоимость доставки заказов Kaspi покупателю. Две совершенно
  // разные вещи под одним словом путали, поэтому 2026-08-28 категорию переименовали.
  // Старое название оставлено ключом: если где-то в таблице осталась "Доставка", она всё равно
  // подтянется в "Логистику", и колонка на странице не разъедется надвое.
  'логистика': 'Логистика',
  'доставка': 'Логистика',
  'карго': 'Логистика',
};
const KNOWN_CATEGORIES = new Set(Object.values(CATEGORY_ALIASES));

// Незнакомую категорию НЕ выбрасываем и ни к чему не приравниваем — сохраняем как есть, чтобы
// запись было видно на странице "Расходы", и отдельно возвращаем список таких категорий в ответе
// синхронизации. Молча приписать её к "Прочим затратам" опаснее: так в расходы может попасть
// закупка товара и отчёт задвоит себестоимость.
function normalizeCategory(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return CATEGORY_ALIASES[raw.toLowerCase()] || raw;
}

// Сравниваем строку листа с тем, что уже лежит в базе. NUMERIC приходит из Postgres строкой
// ("10000" или "10000.00"), поэтому сумму сравниваем числом, а не текстом; дату база отдаёт
// уже в виде 'YYYY-MM-DD' (см. to_char в запросе), пустые текстовые поля — как '' или NULL.
function sameRecord(dbRow, record) {
  return (dbRow.date || null) === (record.date || null)
    && (dbRow.name || '') === record.name
    && (dbRow.category || '') === record.category
    && (dbRow.source || '') === record.source
    && Number(dbRow.amount) === Number(record.amount)
    && (dbRow.comment || '') === record.comment;
}

function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
    // "Описание" — как колонка называется в новом листе, остальные варианты остались от старого
    name: findCol(headers, 'Описание', 'Наименования', 'Наименование'),
    category: findCol(headers, 'Категория'),
    source: findCol(headers, 'Источник', 'From', 'Откуда'),
    amount: findCol(headers, 'Сумма'),
    // В старом листе в "Коментарий" писали, кто сделал расход — в новом для этого есть "Кто"
    comment: findCol(headers, 'Кто', 'Коментарий', 'Комментарий'),
  };

  if (idx.date === -1 || idx.amount === -1) {
    return res.status(400).json({ error: 'Не найдены ожидаемые колонки (Дата, Сумма) — проверьте структуру листа "Бизнес"' });
  }

  const records = [];
  const unknownCategories = new Map(); // категория -> сколько строк
  let withoutDate = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((cell) => cell === '' || cell === null || cell === undefined)) continue;

    const date = parseSheetDate(row[idx.date]);
    const amount = parseNumber(row[idx.amount]);
    if (!date && !amount) continue; // пустая/технический мусор строка

    // Запись без распознанной даты в базу попадёт, но выпадет и из сводки по месяцам, и из
    // "Отчёта" — раньше это происходило молча, теперь считаем такие строки и показываем на странице.
    if (!date) withoutDate += 1;

    const category = idx.category !== -1 ? normalizeCategory(row[idx.category]) : '';
    if (category && !KNOWN_CATEGORIES.has(category)) {
      unknownCategories.set(category, (unknownCategories.get(category) || 0) + 1);
    }

    records.push({
      date,
      name: idx.name !== -1 ? String(row[idx.name] || '') : '',
      category,
      source: idx.source !== -1 ? String(row[idx.source] || '') : '',
      amount,
      comment: idx.comment !== -1 ? String(row[idx.comment] || '') : '',
      rowIndex: i + 1, // +1 т.к. считаем от 1 и первая строка — заголовок
    });
  }

  // Раньше синхронизация делала TRUNCATE и вставляла ВСЕ строки листа заново по одной
  // (330 записей = 330 запросов к базе, несколько секунд на каждое обновление, и id всех
  // расходов менялись при каждом синке). Теперь сравниваем лист с тем, что уже лежит в базе,
  // и трогаем только различия: обычно между двумя открытиями страницы добавилась одна-две
  // строки, значит и записи будет одна-две. Ключ сопоставления — номер строки в листе
  // (`row_index`): колонка "ID" есть только у записей, которые пишет мобильное приложение
  // (53 из 330), у перенесённой истории её нет, поэтому как общий ключ она не годится.
  // Если строку из середины листа удалят, номера ниже сдвинутся и обновится весь хвост —
  // это правильно и по-прежнему одним запросом.
  let inserted = 0;
  let updated = 0;
  let removed = 0;
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT id, row_index, to_char(expense_date, 'YYYY-MM-DD') AS date,
              name, category, source, amount, comment
       FROM expenses`
    );

    const byRow = new Map();
    const staleIds = []; // строки без row_index и дубли — наследие старых синхронизаций
    for (const row of existing.rows) {
      if (row.row_index === null || byRow.has(row.row_index)) {
        staleIds.push(row.id);
        continue;
      }
      byRow.set(row.row_index, row);
    }

    const toInsert = [];
    const toUpdate = [];
    const seen = new Set();
    for (const r of records) {
      seen.add(r.rowIndex);
      const current = byRow.get(r.rowIndex);
      if (!current) {
        toInsert.push(r);
      } else if (!sameRecord(current, r)) {
        toUpdate.push({ ...r, id: current.id });
      }
    }
    const toDelete = staleIds.concat(
      Array.from(byRow.entries())
        .filter(([rowIndex]) => !seen.has(rowIndex))
        .map(([, row]) => row.id)
    );

    await client.query('BEGIN');

    if (toDelete.length > 0) {
      await client.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [toDelete]);
      removed = toDelete.length;
    }

    // Вставка и обновление — пачками по 200 строк одним запросом, а не строка за строкой.
    for (const chunk of chunked(toInsert, 200)) {
      const params = [];
      const values = chunk.map((r, i) => {
        params.push(r.date, r.name, r.category, r.source, r.amount, r.comment, r.rowIndex);
        const n = i * 7;
        return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7})`;
      });
      await client.query(
        `INSERT INTO expenses (expense_date, name, category, source, amount, comment, row_index)
         VALUES ${values.join(', ')}`,
        params
      );
      inserted += chunk.length;
    }

    for (const chunk of chunked(toUpdate, 200)) {
      const params = [];
      const values = chunk.map((r, i) => {
        params.push(r.id, r.date, r.name, r.category, r.source, r.amount, r.comment);
        const n = i * 7;
        // Типы явно указываем только у первой строки VALUES — Postgres выведет остальные по ней.
        return i === 0
          ? `($${n + 1}::int, $${n + 2}::date, $${n + 3}::text, $${n + 4}::text, $${n + 5}::text, $${n + 6}::numeric, $${n + 7}::text)`
          : `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7})`;
      });
      await client.query(
        `UPDATE expenses e
         SET expense_date = v.expense_date, name = v.name, category = v.category,
             source = v.source, amount = v.amount, comment = v.comment, synced_at = now()
         FROM (VALUES ${values.join(', ')}) AS v(id, expense_date, name, category, source, amount, comment)
         WHERE e.id = v.id`,
        params
      );
      updated += chunk.length;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    return res.status(500).json({ error: 'Не удалось сохранить расходы в базу' });
  } finally {
    client.release();
  }

  res.json({
    ok: true,
    processed: records.length,
    inserted,
    updated,
    removed,
    changed: inserted + updated + removed,
    withoutDate,
    unknownCategories: Array.from(unknownCategories, ([name, count]) => ({ name, count })),
  });
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
