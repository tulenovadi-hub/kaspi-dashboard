const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');

const dbPath = require.resolve('../db');
const expensesPath = require.resolve('./expenses');

const entry = (overrides = {}) => ({
  id: 1,
  date: '2026-10-26',
  time: '21:51',
  type: 'expense',
  amount: 1000,
  category: 'Упаковка',
  description: 'Алматы',
  author: 'Автор',
  ...overrides,
});

function dbRow(id, overrides = {}) {
  return {
    id,
    traty_id: null,
    entry_type: 'expense',
    date: '2026-10-26',
    name: 'Алматы',
    category: 'Упаковка',
    source: 'Traty',
    amount: '1000',
    comment: 'Автор',
    ...overrides,
  };
}

// Запускает настоящий обработчик POST /sync против заглушек базы и Traty.
async function runSync({ existing = [], fetchEntries, key = 'test-key' }) {
  const queries = [];
  const client = {
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT id, traty_id')) return { rows: existing };
      if (text.includes('INSERT INTO expenses')) return { rowCount: params.length / 8 };
      return { rows: [] };
    },
    release() {},
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool: { connect: async () => client, query: client.query } },
  };
  delete require.cache[expensesPath];
  const router = require('./expenses');

  const previousGet = axios.get;
  const previousKey = process.env.TRATY_EXPORT_KEY;
  const requests = [];
  axios.get = async (url, options) => {
    requests.push({ url, options });
    return fetchEntries();
  };
  if (key) process.env.TRATY_EXPORT_KEY = key;
  else delete process.env.TRATY_EXPORT_KEY;

  const response = { statusCode: 200 };
  const res = {
    status(code) { response.statusCode = code; return res; },
    json(body) { response.body = body; return res; },
  };
  try {
    const layer = router.stack.find((l) => l.route?.path === '/sync');
    await layer.route.stack[0].handle({}, res);
  } finally {
    axios.get = previousGet;
    if (previousKey === undefined) delete process.env.TRATY_EXPORT_KEY;
    else process.env.TRATY_EXPORT_KEY = previousKey;
  }

  const writes = queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/.test(q.text));
  return { ...response, queries, writes, requests };
}

const respondWith = (entries) => async () => ({ data: { budget: 'Бизнес', count: entries.length, entries } });

test('first sync replaces sheet rows from August in one transaction and leaves older rows alone', async () => {
  const result = await runSync({
    existing: [dbRow(10, { date: '2026-08-05', source: 'сайт' })],
    fetchEntries: respondWith([
      entry({ id: 5 }),
      entry({ id: 6, type: 'income', category: 'Другое', amount: 25000.5 }),
    ]),
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(
    { inserted: result.body.inserted, removed: result.body.removed, changed: result.body.changed },
    { inserted: 2, removed: 1, changed: 3 }
  );
  assert.equal(result.requests[0].options.params.from, '2026-08-01');
  assert.equal(result.requests[0].options.headers['X-Export-Key'], 'test-key');

  const select = result.queries.find((q) => q.text.includes('SELECT id, traty_id'));
  assert.match(select.text, /traty_id IS NOT NULL OR expense_date >= \$1::date/);
  assert.deepEqual(select.params, ['2026-08-01']);

  const texts = result.queries.map((q) => q.text.trim().split(/\s+/)[0]);
  assert.deepEqual(texts, ['SELECT', 'BEGIN', 'DELETE', 'INSERT', 'COMMIT']);
  assert.deepEqual(result.queries.find((q) => q.text.startsWith('DELETE')).params, [[10]]);

  const insert = result.queries.find((q) => q.text.includes('INSERT INTO expenses'));
  assert.deepEqual(insert.params.slice(8), ['2026-10-26', 'Алматы', 'Другое', 'Traty', 25000.5, 'Автор', 6, 'income']);
});

test('unchanged export writes nothing, an edit updates and a deleted entry is removed', async () => {
  const unchanged = await runSync({
    existing: [dbRow(1, { traty_id: '5' })],
    fetchEntries: respondWith([entry({ id: 5 })]),
  });
  assert.equal(unchanged.body.changed, 0);
  assert.equal(unchanged.writes.length, 0);

  const edited = await runSync({
    existing: [dbRow(1, { traty_id: '5' }), dbRow(2, { traty_id: '6' })],
    fetchEntries: respondWith([entry({ id: 5, amount: 1500 })]),
  });
  assert.deepEqual(
    { updated: edited.body.updated, removed: edited.body.removed },
    { updated: 1, removed: 1 }
  );
  assert.deepEqual(edited.queries.find((q) => q.text.startsWith('DELETE')).params, [[2]]);

  const retyped = await runSync({
    existing: [dbRow(1, { traty_id: '5' })],
    fetchEntries: respondWith([entry({ id: 5, type: 'income' })]),
  });
  assert.equal(retyped.body.updated, 1, 'a changed type is an edit');
});

test('nothing in the database is touched when Traty fails or returns nothing', async () => {
  const existing = [dbRow(1, { traty_id: '5' })];
  const failed = (status) => async () => {
    throw Object.assign(new Error('failed'), { response: { status } });
  };
  const cases = [
    [respondWith([]), /пустую/],
    [async () => ({ data: {} }), /неожиданном/],
    [respondWith([entry({ amount: 'много' })]), /неожиданном/],
    [respondWith([entry({ type: 'transfer' })]), /неожиданном/],
    [failed(401), /TRATY_EXPORT_KEY/],
    [failed(404), /бюджет/],
    [failed(429), /подождать/],
    [failed(500), /Не удалось получить/],
  ];

  for (const [fetchEntries, message] of cases) {
    const result = await runSync({ existing, fetchEntries });
    assert.equal(result.statusCode, 502, 'a Traty 401 must not look like an expired session');
    assert.match(result.body.error, message);
    assert.equal(result.queries.length, 0);
  }

  const noKey = await runSync({ existing, key: null, fetchEntries: respondWith([entry()]) });
  assert.equal(noKey.statusCode, 500);
  assert.equal(noKey.requests.length, 0);
  assert.equal(noKey.queries.length, 0);
});

test('unknown categories are reported for expenses only, Маркетинг is known', async () => {
  const result = await runSync({
    fetchEntries: respondWith([
      entry({ id: 1, category: 'Странная' }),
      entry({ id: 2, category: 'маркетинг' }),
      entry({ id: 3, type: 'income', category: 'Другое' }),
    ]),
  });
  assert.deepEqual(result.body.unknownCategories, [{ name: 'Странная', count: 1 }]);
});
