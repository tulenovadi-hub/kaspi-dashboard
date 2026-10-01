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

function routeHandlerWithPool(pool, method = 'post', path = '/') {
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
  const layer = router.stack.find((entry) => entry.route && entry.route.path === path && entry.route.methods[method]);
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
  const handler = routeHandlerWithPool({ connect: async () => client });
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
  const handler = routeHandlerWithPool({
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

test('an existing supply can be split between warehouses atomically', async () => {
  const statements = [];
  let updateParams;
  let insertParams;
  const client = {
    async query(sql, params) {
      statements.push(sql);
      if (sql.includes('SELECT product_id')) {
        return {
          rowCount: 1,
          rows: [{ product_id: 'sku-1', product_name: 'Тестовый товар', quantity: 10, remaining_quantity: 8 }],
        };
      }
      if (sql.includes('UPDATE product_batches')) {
        updateParams = params;
        return { rows: [{ id: 77, warehouse: params[4], quantity: params[5], remaining_quantity: params[6] }] };
      }
      if (sql.includes('INSERT INTO product_batches')) {
        insertParams = params;
        return { rows: [{ id: 78, warehouse: params[6], quantity: params[7], remaining_quantity: params[8] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const handler = routeHandlerWithPool({ connect: async () => client }, 'put', '/:id');
  const res = responseRecorder();

  await handler({ params: { id: '77' }, body: {
    purchase_price: 200,
    logistics_cost: 20,
    purchase_currency: 'KZT',
    purchase_amount_foreign: 100,
    purchase_rate: 1,
    logistics_currency: 'KZT',
    logistics_amount_foreign: 50,
    logistics_rate: 1,
    extra_expenses: [{ name: 'Сертификат', amount: 1000, currency: 'KZT', rate: 1 }],
    allocations: [
      { warehouse: 'Алматы', quantity: 1 },
      { warehouse: 'Астана', quantity: 9 },
    ],
    received_date: '2026-10-01',
    status: 'in_transit',
  } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateParams[0], 320);
  assert.deepEqual(updateParams.slice(4, 7), ['Алматы', 1, 0]);
  assert.equal(updateParams[10], 10);
  assert.equal(updateParams[13], 5);
  assert.equal(JSON.parse(updateParams[15])[0].amount, 100);
  assert.deepEqual(insertParams.slice(6, 9), ['Астана', 9, 8]);
  assert.equal(insertParams[12], 90);
  assert.equal(insertParams[15], 45);
  assert.equal(JSON.parse(insertParams[17])[0].amount, 900);
  assert.equal(res.payload.batches.length, 2);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
});
