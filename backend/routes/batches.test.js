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
  assert.equal(res.payload.rows.length, 2);
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

test('declared total must exactly match the warehouse allocation', async () => {
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
    declared_quantity: 500,
    allocations: [
      { warehouse: 'Алматы', quantity: 295 },
      { warehouse: 'Астана', quantity: 195 },
    ],
    received_date: '2026-10-01',
  } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /распределено 490.*заявлено всего 500/);
  assert.equal(connected, false);
});

test('warehouse rows are returned as one logical supply with restored totals', async () => {
  const rows = [
    { id: 35, supply_group_id: 'batch-35', product_id: 'hs', product_name: 'HS-918', warehouse: 'Алматы', quantity: 295, remaining_quantity: 295, cost_price: 9840, purchase_price: 9000, logistics_cost: 840, purchase_amount_foreign: 2950, logistics_amount_foreign: 295, extra_expenses: [] },
    { id: 40, supply_group_id: 'batch-35', product_id: 'hs', product_name: 'HS-918', warehouse: 'Астана', quantity: 195, remaining_quantity: 195, cost_price: 9840, purchase_price: 9000, logistics_cost: 840, purchase_amount_foreign: 1950, logistics_amount_foreign: 195, extra_expenses: [] },
    { id: 41, supply_group_id: 'batch-35', product_id: 'hs', product_name: 'HS-918', warehouse: 'Атырау', quantity: 10, remaining_quantity: 10, cost_price: 9840, purchase_price: 9000, logistics_cost: 840, purchase_amount_foreign: 100, logistics_amount_foreign: 10, extra_expenses: [] },
  ];
  const handler = routeHandlerWithPool({ query: async () => ({ rows }) }, 'get');
  const res = responseRecorder();

  await handler({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.batches.length, 1);
  assert.equal(res.payload.batches[0].id, 35);
  assert.equal(res.payload.batches[0].quantity, 500);
  assert.equal(res.payload.batches[0].cost_price, 9840);
  assert.equal(res.payload.batches[0].purchase_amount_foreign, 5000);
  assert.deepEqual(res.payload.batches[0].warehouses, ['Алматы', 'Астана', 'Атырау']);
  assert.deepEqual(res.payload.batches[0].allocations.map((row) => row.quantity), [295, 195, 10]);
});

test('an existing supply can be split between warehouses atomically', async () => {
  const statements = [];
  let updateParams;
  let insertParams;
  let savedRows = [];
  const client = {
    async query(sql, params) {
      statements.push(sql);
      if (sql.includes('FROM product_batches pb')) {
        return {
          rowCount: 1,
          rows: [{ id: 77, supply_group_id: 'batch-77', product_id: 'sku-1', product_name: 'Тестовый товар', quantity: 10, remaining_quantity: 8 }],
        };
      }
      if (sql.includes('UPDATE product_batches')) {
        updateParams = params;
        savedRows[0] = {
          id: 77, supply_group_id: params[16], product_id: 'sku-1', product_name: 'Тестовый товар',
          warehouse: params[4], quantity: params[5], remaining_quantity: params[6], cost_price: params[0],
          purchase_price: params[1], logistics_cost: params[2], purchase_amount_foreign: params[10],
          logistics_amount_foreign: params[13], extra_expenses: JSON.parse(params[15]),
        };
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO product_batches')) {
        insertParams = params;
        savedRows[1] = {
          id: 78, supply_group_id: params[18], product_id: 'sku-1', product_name: 'Тестовый товар',
          warehouse: params[6], quantity: params[7], remaining_quantity: params[8], cost_price: params[2],
          purchase_price: params[3], logistics_cost: params[4], purchase_amount_foreign: params[12],
          logistics_amount_foreign: params[15], extra_expenses: JSON.parse(params[17]),
        };
        return { rows: [{ id: 78 }] };
      }
      if (sql.includes('WHERE supply_group_id = $1')) return { rows: savedRows };
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
    declared_quantity: 10,
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
  // 200 ₸ закупка + 20 ₸ логистика + 1000 / 10 ₸ прочие расходы.
  // Разделение 1 + 9 по городам не должно менять себестоимость за штуку.
  assert.equal(insertParams[2], 320);
  assert.equal(res.payload.rows.length, 2);
  assert.equal(res.payload.batch.quantity, 10);
  assert.equal(res.payload.batch.cost_price, 320);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
});
