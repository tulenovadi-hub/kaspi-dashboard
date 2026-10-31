const assert = require('node:assert/strict');
const test = require('node:test');

const dbPath = require.resolve('../db');
const routePath = require.resolve('./warehouseSettings');
const mapping = require('../warehouseMapping');

const ROWS = [
  { pickupPointId: '18619047_PP2', city: 'Алматы', role: 'main' },
  { pickupPointId: '18619047_PP8', city: 'Атырау', role: 'selfbuy' },
  { pickupPointId: '18619047_PP9', city: 'Актобе', role: null },
];

function setup({ insertedRows = 1, updatedRows = 1 } = {}) {
  let rows = ROWS.map((row) => ({ ...row }));
  mapping.applyWarehouses(rows);
  const queries = [];
  const query = async (text, params) => {
    queries.push({ text, params });
    if (text.includes('FROM orders')) {
      return { rows: [{ pickup_point_id: '18619047_PP9', orders_count: 3 }, { pickup_point_id: '18619047_PP10', orders_count: 2 }] };
    }
    if (text.includes('INSERT INTO warehouses')) {
      if (insertedRows) rows = [...rows, { pickupPointId: params[0], city: params[1], role: null }];
      return { rowCount: insertedRows };
    }
    if (text.includes('UPDATE warehouses')) {
      rows = rows.map((row) => (row.pickupPointId === params[1] ? { ...row, role: params[0] } : row));
      return { rowCount: updatedRows };
    }
    if (text.includes('FROM warehouses')) return { rows };
    return { rows: [], rowCount: 0 };
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool: { query, connect: async () => ({ query, release() {} }) } },
  };
  delete require.cache[routePath];
  return { router: require('./warehouseSettings'), queries };
}

async function call(router, method, path, req = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  const response = { statusCode: 200 };
  const res = {
    status(code) { response.statusCode = code; return res; },
    json(body) { response.body = body; return res; },
  };
  await layer.route.stack[0].handle({ params: {}, body: {}, ...req }, res);
  return response;
}

test.afterEach(() => mapping.applyWarehouses(mapping.DEFAULT_WAREHOUSES));

test('list shows warehouses and points seen only in orders', async () => {
  const { router } = setup();
  const { body } = await call(router, 'get', '/');
  assert.deepEqual(body.warehouses[2], { code: 'PP9', city: 'Актобе', role: null, orders_count: 3 });
  assert.deepEqual(body.unknownPoints, [{ code: 'PP10', orders_count: 2 }]);
});

test('a warehouse without a type belongs to neither group, and choosing one updates the shared lists in place', async () => {
  const { router } = setup();
  const { MAIN_CITIES, SELF_BUY_CITIES, DISPLAY_CITIES, ALL_CITIES } = mapping;
  assert.deepEqual(MAIN_CITIES, ['Алматы']);
  assert.deepEqual(SELF_BUY_CITIES, ['Атырау', mapping.MARKED_SELF_BUY_CITY]);
  assert.ok(ALL_CITIES.includes('Актобе'));

  const result = await call(router, 'put', '/:code/role', { params: { code: 'PP9' }, body: { role: 'main' } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(MAIN_CITIES, ['Алматы', 'Актобе'], 'modules hold this array since require()');
  assert.deepEqual(DISPLAY_CITIES, ['Алматы', 'Актобе']);

  await call(router, 'put', '/:code/role', { params: { code: 'PP8' }, body: { role: 'main' } });
  assert.deepEqual(SELF_BUY_CITIES, [mapping.MARKED_SELF_BUY_CITY]);
});

test('role change rejects bad input and a missing warehouse', async () => {
  const { router } = setup({ updatedRows: 0 });
  const bad = await call(router, 'put', '/:code/role', { params: { code: 'PP9' }, body: { role: 'other' } });
  assert.equal(bad.statusCode, 400);
  const missing = await call(router, 'put', '/:code/role', { params: { code: 'PP77' }, body: { role: 'main' } });
  assert.equal(missing.statusCode, 404);
});

test('adding a warehouse binds orders that already arrived and keeps its type empty', async () => {
  const { router, queries } = setup();
  const result = await call(router, 'post', '/', { body: { code: 'pp10', city: ' Шымкент ' } });
  assert.equal(result.statusCode, 200);

  const bind = queries.find((q) => q.text.includes('UPDATE orders'));
  assert.deepEqual(bind.params, ['Шымкент', '18619047_PP10']);
  assert.equal(mapping.resolveWarehouse('18619047_PP10'), 'Шымкент');
  assert.ok(!mapping.MAIN_CITIES.includes('Шымкент'));
  assert.ok(!mapping.SELF_BUY_CITIES.includes('Шымкент'));
});

test('adding rejects a mistyped code, an empty city and a duplicate', async () => {
  const { router, queries } = setup({ insertedRows: 0 });
  const badCode = await call(router, 'post', '/', { body: { code: 'Шымкент', city: 'Шымкент' } });
  assert.equal(badCode.statusCode, 400);
  const noCity = await call(router, 'post', '/', { body: { code: 'PP10', city: '  ' } });
  assert.equal(noCity.statusCode, 400);
  assert.equal(queries.length, 0);

  const duplicate = await call(router, 'post', '/', { body: { code: 'PP2', city: 'Алматы' } });
  assert.equal(duplicate.statusCode, 400);
  assert.ok(!queries.some((q) => q.text.includes('UPDATE orders')));
});
