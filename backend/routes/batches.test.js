const test = require('node:test');
const assert = require('node:assert/strict');

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function postHandlerWithPool(pool) {
  const dbPath = require.resolve('../db');
  const routePath = require.resolve('./batches');
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool },
  };
  delete require.cache[routePath];
  const router = require('./batches');
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/' && entry.route.methods.post);
  return layer.route.stack[0].handle;
}

test('one supply is atomically split between warehouses with proportional totals', async () => {
  const statements = [];
  const inserts = [];
  const client = {
    async query(sql, params) {
      statements.push(sql);
      if (!sql.includes('INSERT INTO product_batches')) return { rows: [] };
      inserts.push(params);
      return {
        rows: [{
          id: inserts.length,
          warehouse: params[6],
          quantity: params[7],
          cost_price: params[2],
          purchase_amount_foreign: params[11],
          logistics_amount_foreign: params[14],
          extra_expenses: JSON.parse(params[16]),
        }],
      };
    },
    release() {},
  };
  const handler = postHandlerWithPool({ connect: async () => client });
  const res = responseRecorder();

  await handler({ body: {
    product_id: 'sku-1',
    product_name: 'Тестовый товар',
    purchase_price: 300,
    logistics_cost: 30,
    purchase_currency: 'USD',
    purchase_amount_foreign: 90,
    purchase_rate: 450,
    logistics_currency: 'USD',
    logistics_amount_foreign: 45,
    logistics_rate: 450,
    extra_expenses: [{ name: 'Сертификат', amount: 900, currency: 'KZT', rate: 1 }],
    allocations: [
      { warehouse: 'Алматы', quantity: 6 },
      { warehouse: 'Астана', quantity: 3 },
    ],
    received_date: '2026-10-01',
    status: 'in_transit',
  } }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0][2], 430);
  assert.deepEqual(inserts.map((params) => [params[6], params[7]]), [['Алматы', 6], ['Астана', 3]]);
  assert.deepEqual(inserts.map((params) => params[11]), [60, 30]);
  assert.deepEqual(inserts.map((params) => params[14]), [30, 15]);
  assert.deepEqual(inserts.map((params) => JSON.parse(params[16])[0].amount), [600, 300]);
  assert.equal(res.payload.batches.length, 2);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
});

test('duplicate warehouse allocation is rejected before opening a transaction', async () => {
  let connected = false;
  const handler = postHandlerWithPool({
    async connect() {
      connected = true;
      throw new Error('must not connect');
    },
  });
  const res = responseRecorder();

  await handler({ body: {
    product_id: 'sku-1',
    product_name: 'Тестовый товар',
    purchase_price: 100,
    allocations: [
      { warehouse: 'Алматы', quantity: 2 },
      { warehouse: 'Алматы', quantity: 3 },
    ],
    received_date: '2026-10-01',
  } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /дважды/);
  assert.equal(connected, false);
});

