const express = require('express');
const axios = require('axios');
const { pool } = require('../db');

const router = express.Router();

// Расходы и внеплановые доходы приходят из приложения Traty, бюджет "Бизнес". Ключ только читает
// и только этот бюджет, лежит в настройках сервера. Каждый раз приходит весь период: правки и
// удаления видны только сравнением с базой.
// До 2026-10-31 источником был лист "Бизнес" гугл-таблицы, он больше не обновляется.
const TRATY_URL = 'https://api.traty.kz/api/export/entries';

// Всё, что раньше этого дня (январь–июль 2026, 277 строк, в том числе строки с нулевой суммой),
// осталось в базе из гугл-таблицы и в Traty не переносилось: синхронизация эти строки не трогает.
const TRATY_FROM = '2026-08-01';

// "Отчёт" завязан на ТОЧНЫЕ названия категорий: "Прочие затраты" вычитаются из чистой прибыли,
// "Упаковка" идёт в отчёте отдельной колонкой, а "Товар", "Вывод" и "Маркетинг" из расходов
// исключаются (товар уже учтён через себестоимость по партиям FIFO, вывод — дивиденды
// собственника, а не расход бизнеса, реклама уже посчитана в разделе "Маркетинг"; нулевых сумм
// в Traty не бывает, поэтому она записывается настоящей суммой в свою категорию). Приводим
// названия к каноническим здесь, в одном месте. Сравнение без учёта регистра.
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
  'маркетинг': 'Маркетинг',
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

// Сравниваем запись Traty с тем, что уже лежит в базе. NUMERIC приходит из Postgres строкой
// ("10000" или "10000.00"), поэтому сумму сравниваем числом, а не текстом; дату база отдаёт
// уже в виде 'YYYY-MM-DD' (см. to_char в запросе), пустые текстовые поля — как '' или NULL.
function sameRecord(dbRow, record) {
  return (dbRow.date || null) === (record.date || null)
    && (dbRow.name || '') === record.name
    && (dbRow.category || '') === record.category
    && (dbRow.source || '') === record.source
    && dbRow.entry_type === record.type
    && Number(dbRow.amount) === Number(record.amount)
    && (dbRow.comment || '') === record.comment;
}

function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Ответ Traty проверяем целиком ДО записи: синхронизация удаляет всё, чего нет в выгрузке, поэтому
// кривая или неполная выгрузка не должна дойти до базы.
function isValidEntry(entry) {
  return Number.isInteger(entry?.id)
    && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
    && Number.isFinite(entry.amount)
    && (entry.type === 'expense' || entry.type === 'income');
}

function tratyErrorMessage(status) {
  if (status === 401) return 'Traty не принял ключ — проверьте TRATY_EXPORT_KEY в настройках сервера';
  if (status === 404) return 'В Traty не найден бюджет «Бизнес»';
  if (status === 429) return 'Слишком много обновлений подряд — Traty просит подождать несколько минут';
  return 'Не удалось получить данные из Traty';
}

router.post('/sync', async (req, res) => {
  if (!process.env.TRATY_EXPORT_KEY) {
    return res.status(500).json({ error: 'На сервере не настроен TRATY_EXPORT_KEY — расходы не обновляются' });
  }

  // При любой ошибке выходим раньше, чем тронем базу. Статус всегда 502, а не статус Traty:
  // 401 на нашем API означает "сессия истекла" и выбросил бы владельца из приложения.
  let entries;
  try {
    const response = await axios.get(TRATY_URL, {
      params: { from: TRATY_FROM },
      headers: { 'X-Export-Key': process.env.TRATY_EXPORT_KEY },
      timeout: 15000,
    });
    entries = response.data?.entries;
  } catch (err) {
    console.error('Не удалось скачать выгрузку Traty:', err.message);
    return res.status(502).json({ error: tratyErrorMessage(err.response?.status) });
  }

  if (!Array.isArray(entries) || !entries.every(isValidEntry)) {
    console.error('Traty вернул выгрузку неожиданного вида');
    return res.status(502).json({ error: 'Traty вернул данные в неожиданном виде — расходы не обновлены' });
  }
  // Пустой ответ при живом бюджете — это почти наверняка сбой, а не удалённые записи.
  if (entries.length === 0) {
    return res.status(502).json({ error: 'Traty вернул пустую выгрузку — расходы не обновлены' });
  }

  const unknownCategories = new Map(); // категория -> сколько записей
  const records = entries.map((entry) => {
    const category = normalizeCategory(entry.category);
    if (entry.type === 'expense' && category && !KNOWN_CATEGORIES.has(category)) {
      unknownCategories.set(category, (unknownCategories.get(category) || 0) + 1);
    }
    return {
      tratyId: entry.id,
      type: entry.type,
      date: entry.date,
      name: String(entry.description || ''),
      category,
      source: 'Traty',
      amount: entry.amount,
      comment: String(entry.author || ''),
    };
  });

  // Сравниваем выгрузку с тем, что уже лежит в базе, и трогаем только различия: обычно между
  // двумя открытиями страницы добавилась одна-две записи. Ключ сопоставления — постоянный номер
  // записи в Traty (`traty_id`). Строки с датой от TRATY_FROM без этого номера остались от
  // гугл-таблицы: первая успешная синхронизация заменяет их выгрузкой в одной транзакции.
  let inserted = 0;
  let updated = 0;
  let removed = 0;
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT id, traty_id, entry_type, to_char(expense_date, 'YYYY-MM-DD') AS date,
              name, category, source, amount, comment
       FROM expenses
       WHERE traty_id IS NOT NULL OR expense_date >= $1::date`,
      [TRATY_FROM]
    );

    const byTratyId = new Map();
    const staleIds = []; // строки гугл-таблицы за период, который теперь приходит из Traty
    for (const row of existing.rows) {
      if (row.traty_id === null) {
        staleIds.push(row.id);
        continue;
      }
      byTratyId.set(Number(row.traty_id), row);
    }

    const toInsert = [];
    const toUpdate = [];
    const seen = new Set();
    for (const r of records) {
      seen.add(r.tratyId);
      const current = byTratyId.get(r.tratyId);
      if (!current) {
        toInsert.push(r);
      } else if (!sameRecord(current, r)) {
        toUpdate.push({ ...r, id: current.id });
      }
    }
    const toDelete = staleIds.concat(
      Array.from(byTratyId.entries())
        .filter(([tratyId]) => !seen.has(tratyId))
        .map(([, row]) => row.id)
    );

    await client.query('BEGIN');

    if (toDelete.length > 0) {
      await client.query('DELETE FROM expenses WHERE id = ANY($1::int[])', [toDelete]);
      removed = toDelete.length;
    }

    // Вставка и обновление — пачками по 200 строк одним запросом, а не строка за строкой.
    // ON CONFLICT: страницу могут открыть на двух устройствах сразу, и вторая синхронизация
    // не должна падать на записях, которые первая уже вставила.
    for (const chunk of chunked(toInsert, 200)) {
      const params = [];
      const values = chunk.map((r, i) => {
        params.push(r.date, r.name, r.category, r.source, r.amount, r.comment, r.tratyId, r.type);
        const n = i * 8;
        return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8})`;
      });
      const result = await client.query(
        `INSERT INTO expenses (expense_date, name, category, source, amount, comment, traty_id, entry_type)
         VALUES ${values.join(', ')}
         ON CONFLICT (traty_id) DO NOTHING`,
        params
      );
      inserted += result.rowCount;
    }

    for (const chunk of chunked(toUpdate, 200)) {
      const params = [];
      const values = chunk.map((r, i) => {
        params.push(r.id, r.date, r.name, r.category, r.source, r.amount, r.comment, r.type);
        const n = i * 8;
        // Типы явно указываем только у первой строки VALUES — Postgres выведет остальные по ней.
        return i === 0
          ? `($${n + 1}::int, $${n + 2}::date, $${n + 3}::text, $${n + 4}::text, $${n + 5}::text, $${n + 6}::numeric, $${n + 7}::text, $${n + 8}::text)`
          : `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8})`;
      });
      await client.query(
        `UPDATE expenses e
         SET expense_date = v.expense_date, name = v.name, category = v.category,
             source = v.source, amount = v.amount, comment = v.comment,
             entry_type = v.entry_type, synced_at = now()
         FROM (VALUES ${values.join(', ')}) AS v(id, expense_date, name, category, source, amount, comment, entry_type)
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
    unknownCategories: Array.from(unknownCategories, ([name, count]) => ({ name, count })),
  });
});

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, expense_date, name, category, source, amount, comment, entry_type, synced_at
       FROM expenses
       ORDER BY expense_date DESC NULLS LAST, traty_id DESC NULLS LAST, row_index DESC`
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
      SELECT to_char(expense_date, 'YYYY-MM') AS month, category, entry_type, SUM(amount) AS total, COUNT(*) AS records_count
      FROM expenses
      WHERE expense_date IS NOT NULL
      GROUP BY month, category, entry_type
      ORDER BY month DESC
    `);

    const monthsMap = new Map();
    const categoriesSet = new Set();

    for (const row of result.rows) {
      if (!monthsMap.has(row.month)) {
        monthsMap.set(row.month, { month: row.month, total: 0, records_count: 0, income: 0, byCategory: {} });
      }
      const monthEntry = monthsMap.get(row.month);
      const amount = Number(row.total);

      // Доходы идут отдельным полем: в категории и в сумму расходов они не входят.
      if (row.entry_type === 'income') {
        monthEntry.income += amount;
        continue;
      }

      const category = row.category || 'Без категории';
      categoriesSet.add(category);
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
