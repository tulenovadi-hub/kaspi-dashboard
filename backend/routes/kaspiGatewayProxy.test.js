const test = require('node:test');
const assert = require('node:assert/strict');
const { hashGatewayToken } = require('../kaspiGateway');

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    set(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; },
  };
}

test('proxy forwards read requests and physically blocks writes for a read-only token', async (t) => {
  const dbPath = require.resolve('../db');
  const clientPath = require.resolve('../kaspiClient');
  const routePath = require.resolve('./kaspiGatewayProxy');
  const secret = 'kgw_live_test_secret';
  const queries = [];
  const upstreamCalls = [];

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      pool: {
        query: async (sql, params) => {
          queries.push({ sql, params });
          if (sql.includes('FROM kaspi_gateway_tokens')) {
            assert.equal(params[0], hashGatewayToken(secret));
            return {
              rowCount: 1,
              rows: [{
                id: 7,
                name: 'Тест',
                access_level: 'read',
                enabled: true,
                expires_at: null,
                rate_limit_per_minute: 60,
                allowed_ips: [],
              }],
            };
          }
          if (sql.includes('UPDATE kaspi_gateway_tokens')) return { rowCount: 1, rows: [{ id: 7 }] };
          if (sql.includes('INSERT INTO kaspi_gateway_logs')) return { rowCount: 1, rows: [] };
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    },
  };
  require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
      proxyKaspiRequest: async (...args) => {
        upstreamCalls.push(args);
        return {
          status: 200,
          headers: { 'content-type': 'application/vnd.api+json' },
          data: Buffer.from('{"data":[{"id":"1"}]}'),
        };
      },
    },
  };
  delete require.cache[routePath];
  const router = require('./kaspiGatewayProxy');
  t.after(() => {
    delete require.cache[routePath];
    delete require.cache[clientPath];
    delete require.cache[dbPath];
  });
  const handler = router.stack.find((layer) => layer.route && layer.route.path === '/v2/*').route.stack[0].handle;

  const readResponse = fakeResponse();
  await handler({
    method: 'GET',
    originalUrl: '/kaspi-proxy/v2/orders?page[number]=0',
    ip: '203.0.113.10',
    body: undefined,
    header: (name) => (name.toLowerCase() === 'x-auth-token' ? secret : undefined),
  }, readResponse);
  assert.equal(readResponse.statusCode, 200);
  assert.equal(readResponse.headers['content-type'], 'application/vnd.api+json');
  assert.deepEqual(JSON.parse(readResponse.payload.toString('utf8')), { data: [{ id: '1' }] });
  assert.deepEqual(upstreamCalls[0], ['GET', '/orders?page[number]=0', undefined]);

  const writeResponse = fakeResponse();
  await handler({
    method: 'POST',
    originalUrl: '/kaspi-proxy/v2/orders',
    ip: '203.0.113.10',
    body: { data: { type: 'orders' } },
    header: (name) => (name.toLowerCase() === 'x-auth-token' ? secret : undefined),
  }, writeResponse);
  assert.equal(writeResponse.statusCode, 403);
  assert.match(writeResponse.payload.error, /только чтение/i);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO kaspi_gateway_logs')).length, 2);
});
