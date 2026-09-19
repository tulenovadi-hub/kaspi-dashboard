const test = require('node:test');
const assert = require('node:assert/strict');

test('a previously completed order cannot be manually returned to available stock', async () => {
  const dbPath = require.resolve('../db');
  const syncPath = require.resolve('../deliveryReturnsSync');
  const coordinatorPath = require.resolve('../syncCoordinator');
  const routePath = require.resolve('./deliveryReturns');

  let updateAttempted = false;
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      pool: {
        query: async (sql) => {
          if (sql.includes('was_completed = true')) return { rowCount: 1, rows: [{ '?column?': 1 }] };
          if (sql.includes('UPDATE delivery_cancellations')) updateAttempted = true;
          return { rowCount: 0, rows: [] };
        },
      },
    },
  };
  require.cache[syncPath] = {
    id: syncPath,
    filename: syncPath,
    loaded: true,
    exports: {
      syncDeliveryCancellations: async () => 0,
      syncOrderByNumber: async () => ({}),
      refreshTrackedOrders: async () => 0,
      refreshTrackingStatuses: async () => 0,
      refreshWonderReceived: async () => 0,
      SEARCH_WINDOW_DAYS: 20,
      lastSearchStats: {},
    },
  };
  require.cache[coordinatorPath] = {
    id: coordinatorPath,
    filename: coordinatorPath,
    loaded: true,
    exports: { enqueueKaspiSync: (_name, task) => task() },
  };

  delete require.cache[routePath];
  const router = require('./deliveryReturns');
  const layer = router.stack.find((entry) => (
    entry.route &&
    entry.route.path === '/:orderNumber/return-to-stock' &&
    entry.route.methods.post
  ));
  const handler = layer.route.stack[0].handle;

  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  await handler({ params: { orderNumber: '123456789' } }, res);

  assert.equal(statusCode, 409);
  assert.match(payload.error, /уже был выдан/);
  assert.equal(updateAttempted, false);
});

test('an automatically archived order can be restored to the main list', async () => {
  const dbPath = require.resolve('../db');
  const syncPath = require.resolve('../deliveryReturnsSync');
  const coordinatorPath = require.resolve('../syncCoordinator');
  const routePath = require.resolve('./deliveryReturns');

  let updateSql = '';
  let updateParams = [];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      pool: {
        query: async (sql, params) => {
          updateSql = sql;
          updateParams = params;
          return { rowCount: 1, rows: [{ order_number: params[0] }] };
        },
      },
    },
  };
  require.cache[syncPath] = {
    id: syncPath,
    filename: syncPath,
    loaded: true,
    exports: {
      syncDeliveryCancellations: async () => 0,
      syncOrderByNumber: async () => ({}),
      refreshTrackedOrders: async () => 0,
      refreshTrackingStatuses: async () => 0,
      refreshWonderReceived: async () => 0,
      SEARCH_WINDOW_DAYS: 20,
      lastSearchStats: {},
    },
  };
  require.cache[coordinatorPath] = {
    id: coordinatorPath,
    filename: coordinatorPath,
    loaded: true,
    exports: { enqueueKaspiSync: (_name, task) => task() },
  };

  delete require.cache[routePath];
  const router = require('./deliveryReturns');
  const layer = router.stack.find((entry) => (
    entry.route &&
    entry.route.path === '/:orderNumber/archive' &&
    entry.route.methods.delete
  ));
  const handler = layer.route.stack[0].handle;

  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  await handler({ params: { orderNumber: '1077487999' } }, res);

  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(updateParams, ['1077487999']);
  assert.match(updateSql, /archived_at = NULL/);
  assert.match(updateSql, /restored_from_archive = true/);
  assert.match(updateSql, /restored_from_archive = false/);
});

test('only main-list orders awaiting the stock button are marked as subtracted', async () => {
  const dbPath = require.resolve('../db');
  const syncPath = require.resolve('../deliveryReturnsSync');
  const coordinatorPath = require.resolve('../syncCoordinator');
  const routePath = require.resolve('./deliveryReturns');

  const baseRow = {
    creation_date: '2026-09-01T00:00:00Z',
    total_price: 29900,
    quantity: 1,
    product_names: 'TOMMILI T15 PRO',
    cancellation_reason: 'BUYER_CANCELLATION_HIMSELF',
    delivery_mode: 'DELIVERY_LOCAL',
    origin_city: 'Алматы',
    state: 'ARCHIVE',
    status: 'CANCELLED',
    tracking_status: 'CANCELLED',
    tracking_active: false,
    last_track_at: null,
    wonder_received: true,
    stock_returned_at: null,
    archived_at: null,
    restored_from_archive: false,
    was_completed: false,
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      pool: {
        query: async () => ({
          rows: [
            { ...baseRow, order_number: '1000000001', archived_at: '2026-09-10T00:00:00Z' },
            { ...baseRow, order_number: '1000000002', wonder_received: false, restored_from_archive: true },
            { ...baseRow, order_number: '1000000003', tracking_status: 'RETURNED', stock_returned_at: '2026-09-11T00:00:00Z' },
          ],
        }),
      },
    },
  };
  require.cache[syncPath] = {
    id: syncPath,
    filename: syncPath,
    loaded: true,
    exports: {
      syncDeliveryCancellations: async () => 0,
      syncOrderByNumber: async () => ({}),
      refreshTrackedOrders: async () => 0,
      refreshTrackingStatuses: async () => 0,
      refreshWonderReceived: async () => 0,
      SEARCH_WINDOW_DAYS: 20,
      lastSearchStats: {},
    },
  };
  require.cache[coordinatorPath] = {
    id: coordinatorPath,
    filename: coordinatorPath,
    loaded: true,
    exports: { enqueueKaspiSync: (_name, task) => task() },
  };

  delete require.cache[routePath];
  const router = require('./deliveryReturns');
  const layer = router.stack.find((entry) => entry.route && entry.route.path === '/' && entry.route.methods.get);
  const handler = layer.route.stack[0].handle;

  let payload = null;
  const res = { status() { return this; }, json(body) { payload = body; return this; } };
  await handler({}, res);

  assert.equal(payload.orders[0].subtracted_from_stock, false, 'архив не входит в потенциальное пополнение');
  assert.equal(payload.orders[1].subtracted_from_stock, true, 'восстановленный заказ снова входит в основной список');
  assert.equal(payload.orders[2].subtracted_from_stock, false, 'уже добавленный товар больше не ожидает кнопку');
});
