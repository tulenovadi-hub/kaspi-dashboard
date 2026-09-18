const test = require('node:test');
const assert = require('node:assert/strict');

test('returned-order sync scans from the stock cutoff and stores RETURNED status', async () => {
  const dbPath = require.resolve('./db');
  const kaspiPath = require.resolve('./kaspiClient');
  const syncPath = require.resolve('./syncJob');

  const searches = [];
  let savedStatus = null;
  let insertedWasCompleted = null;
  let upsertSql = null;
  let inferredWasCompleted = false;
  const returnedOrder = {
    id: 'order-1',
    attributes: {
      code: '123456789',
      creationDate: Date.UTC(2026, 5, 15),
      totalPrice: 29900,
      state: 'ARCHIVE',
      status: 'RETURNED',
      pickupPointId: '18619047_PP2',
    },
  };

  const query = async (sql, params) => {
    if (sql.includes('SELECT id FROM orders')) return { rows: [{ id: 'order-1' }] };
    if (sql.includes('SELECT DISTINCT order_id')) return { rows: [{ order_id: 'order-1' }] };
    if (sql.includes('INSERT INTO orders')) {
      upsertSql = sql;
      savedStatus = params[5];
      insertedWasCompleted = params[9];
      return { rows: [] };
    }
    if (sql.includes('UPDATE orders o') && sql.includes('delivery_cancellations')) {
      inferredWasCompleted = true;
      assert.deepEqual(params[0], ['123456789']);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool: { query }, initDb: async () => {} },
  };
  require.cache[kaspiPath] = {
    id: kaspiPath,
    filename: kaspiPath,
    loaded: true,
    exports: {
      fetchOrders: async () => [],
      fetchOrderEntries: async () => { throw new Error('entries should not be reloaded'); },
      fetchOrdersByStatus: async (...args) => {
        searches.push(args);
        return args[1] === 'RETURNED' ? [returnedOrder] : [];
      },
    },
  };
  delete require.cache[syncPath];
  const { syncReturnedOrders, hasCompletedEvidence } = require('./syncJob');

  assert.equal(hasCompletedEvidence({ status: 'COMPLETED' }), true);
  assert.equal(hasCompletedEvidence({ status: 'CANCELLED', completionDate: 123 }), false);
  assert.equal(hasCompletedEvidence({ status: 'RETURNED' }), false);

  const result = await syncReturnedOrders();

  assert.deepEqual(searches.map((args) => args[1]), ['KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED']);
  assert.ok(searches.every((args) => args[0] === null));
  assert.ok(searches.every((args) => args[2] === Date.UTC(2026, 5, 1)));
  assert.ok(searches.every((args) => args[3] >= args[2]));
  assert.equal(savedStatus, 'RETURNED');
  assert.equal(insertedWasCompleted, false);
  assert.match(upsertSql, /orders\.was_completed OR EXCLUDED\.was_completed/);
  assert.equal(inferredWasCompleted, true);
  assert.equal(result.orders, 1);
});
