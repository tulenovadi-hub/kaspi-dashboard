const test = require('node:test');
const assert = require('node:assert/strict');

test('warehouse return leakage report groups only the stock-cutoff period', async () => {
  const dbPath = require.resolve('../db');
  const routePath = require.resolve('./debug');
  const calls = [];

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      pool: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (sql.includes('GROUP BY')) {
            return {
              rows: [{
                product_id: 'sku-1',
                product_name: 'Товар',
                warehouse: 'Алматы',
                orders_count: 3,
                units_count: 4,
                awaiting_count: 1,
                returned_count: 2,
                first_order_date: '2026-06-10',
                last_order_date: '2026-09-10',
              }],
            };
          }
          return { rows: [{ orders_count: 3, units_count: 4, first_order_date: '2026-06-10', last_order_date: '2026-09-10' }] };
        },
      },
    },
  };

  delete require.cache[routePath];
  const router = require('./debug');
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/warehouse-return-leakage');
  const handler = layer.route.stack[0].handle;

  let payload = null;
  const res = {
    status() { return this; },
    json(body) { payload = body; return this; },
  };
  await handler({}, res);

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.params[0] === '2026-06-01'));
  assert.ok(calls.every((call) => call.sql.includes('dc.order_number IS NULL')));
  assert.ok(calls.every((call) => call.sql.includes('o.was_completed = true')));
  assert.equal(payload.totals.orders_count, 3);
  assert.equal(payload.products[0].units_count, 4);
});

