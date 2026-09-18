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
