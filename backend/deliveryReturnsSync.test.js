const test = require('node:test');
const assert = require('node:assert/strict');

test('Wonder reconciliation includes orders marked CANCELLED by Kaspi', async () => {
  const dbPath = require.resolve('./db');
  const kaspiPath = require.resolve('./kaspiClient');
  const logisticsPath = require.resolve('./kaspiLogistics');
  const wonderPath = require.resolve('./wonderClient');
  const syncPath = require.resolve('./deliveryReturnsSync');

  let updateSql = '';
  let updateParams = null;
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      pool: {
        query: async (sql, params) => {
          updateSql = sql;
          updateParams = params;
          return { rowCount: 1, rows: [] };
        },
      },
    },
  };
  require.cache[kaspiPath] = {
    id: kaspiPath,
    filename: kaspiPath,
    loaded: true,
    exports: { fetchOrdersByStatus: async () => [], fetchOrderByCode: async () => null },
  };
  require.cache[logisticsPath] = {
    id: logisticsPath,
    filename: logisticsPath,
    loaded: true,
    exports: { fetchTrackingStatus: async () => null },
  };
  require.cache[wonderPath] = {
    id: wonderPath,
    filename: wonderPath,
    loaded: true,
    exports: { fetchAllWonderOrderCodes: async () => new Set(['1077487999']) },
  };

  delete require.cache[syncPath];
  const { refreshWonderReceived } = require('./deliveryReturnsSync');
  const count = await refreshWonderReceived();

  assert.equal(count, 1);
  assert.deepEqual(updateParams, [['1077487999']]);
  assert.match(updateSql, /SET wonder_received/);
  assert.doesNotMatch(updateSql, /tracking_status/);
});

test('point lookup marks a cancelled order found in Wonder immediately', async () => {
  const dbPath = require.resolve('./db');
  const kaspiPath = require.resolve('./kaspiClient');
  const logisticsPath = require.resolve('./kaspiLogistics');
  const wonderPath = require.resolve('./wonderClient');
  const syncPath = require.resolve('./deliveryReturnsSync');

  const queries = [];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      pool: {
        query: async (sql, params) => {
          queries.push({ sql, params });
          return { rowCount: 1, rows: [] };
        },
      },
    },
  };
  require.cache[kaspiPath] = {
    id: kaspiPath,
    filename: kaspiPath,
    loaded: true,
    exports: {
      fetchOrdersByStatus: async () => [],
      fetchOrderByCode: async (code) => ({
        id: 'order-1080573013',
        attributes: {
          code,
          creationDate: Date.UTC(2026, 8, 19),
          totalPrice: 19900,
          cancellationReason: 'BUYER_CANCELLATION_HIMSELF',
          deliveryMode: 'DELIVERY_LOCAL',
          state: 'ARCHIVE',
          status: 'CANCELLED',
        },
      }),
    },
  };
  require.cache[logisticsPath] = {
    id: logisticsPath,
    filename: logisticsPath,
    loaded: true,
    exports: {
      fetchTrackingStatus: async () => ({
        orderStatus: 'CANCELLED',
        tracks: [{ code: 'CANCELLED', actualDateTime: '2026-09-19T12:00:00Z' }],
      }),
    },
  };
  require.cache[wonderPath] = {
    id: wonderPath,
    filename: wonderPath,
    loaded: true,
    exports: { fetchAllWonderOrderCodes: async () => new Set(['1080573013']) },
  };

  delete require.cache[syncPath];
  const { syncOrderByNumber } = require('./deliveryReturnsSync');
  const result = await syncOrderByNumber('1080573013');

  assert.equal(result.found, true);
  assert.equal(result.added, true);
  assert.equal(result.wonder_received, true);
  assert.match(result.message, /найден в Wonder/);
  const wonderUpdate = queries.find(({ sql }) => sql.includes('SET wonder_received = $2'));
  assert.ok(wonderUpdate, 'Wonder result must be stored during point lookup');
  assert.deepEqual(wonderUpdate.params, ['1080573013', true]);
});
