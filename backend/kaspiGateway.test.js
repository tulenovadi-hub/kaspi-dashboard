const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOKEN_PREFIX,
  generateGatewayToken,
  hashGatewayToken,
  normalizeAllowedIps,
  normalizeClientIp,
  canUseMethod,
  extractKaspiPath,
} = require('./kaspiGateway');

test('gateway tokens are random, prefixed and stored as hashes', () => {
  const first = generateGatewayToken();
  const second = generateGatewayToken();
  assert.ok(first.token.startsWith(TOKEN_PREFIX));
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashGatewayToken(first.token));
  assert.equal(first.tokenHash.length, 64);
  assert.ok(!first.tokenHint.includes(first.token.slice(17, -4)));
});

test('read access blocks every method that can modify Kaspi', () => {
  assert.equal(canUseMethod('read', 'GET'), true);
  assert.equal(canUseMethod('read', 'HEAD'), true);
  ['POST', 'PUT', 'PATCH', 'DELETE'].forEach((method) => {
    assert.equal(canUseMethod('read', method), false);
    assert.equal(canUseMethod('full', method), true);
  });
  assert.equal(canUseMethod('full', 'CONNECT'), false);
});

test('proxy path keeps Kaspi query but rejects host and traversal escapes', () => {
  assert.equal(
    extractKaspiPath('/kaspi-proxy/v2/orders?page[number]=0&filter[orders][state]=NEW'),
    '/orders?page[number]=0&filter[orders][state]=NEW'
  );
  assert.throws(() => extractKaspiPath('/kaspi-proxy/v2//evil.example/orders'));
  assert.throws(() => extractKaspiPath('/kaspi-proxy/v2/../admin'));
  assert.throws(() => extractKaspiPath('/kaspi-proxy/v2/%2e%2e/admin'));
  assert.throws(() => extractKaspiPath('/wrong/orders'));
});

test('IP allowlist accepts only real unique addresses', () => {
  assert.deepEqual(normalizeAllowedIps('203.0.113.10, 2001:db8::1; 203.0.113.10'), [
    '203.0.113.10',
    '2001:db8::1',
  ]);
  assert.equal(normalizeClientIp('::ffff:203.0.113.10'), '203.0.113.10');
  assert.throws(() => normalizeAllowedIps(['203.0.113.999']));
});
