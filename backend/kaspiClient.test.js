const test = require('node:test');
const assert = require('node:assert/strict');

test('order lookup uses the official code filter, retries transient errors and globally limits concurrency', async () => {
  const axiosPath = require.resolve('axios');
  const clientPath = require.resolve('./kaspiClient');
  const originalAxios = require.cache[axiosPath];

  const calls = [];
  const attempts = new Map();
  let active = 0;
  let maxActive = 0;
  const get = async (path, config) => {
    const code = config.params['filter[orders][code]'];
    calls.push({ path, params: config.params });
    attempts.set(code, (attempts.get(code) || 0) + 1);

    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;

    if (code === 'retry-me' && attempts.get(code) === 1) {
      const err = new Error('temporary Kaspi failure');
      err.response = { status: 503, headers: { 'retry-after': '0' } };
      throw err;
    }

    return {
      data: {
        data: [{ id: `id-${code}`, attributes: { code } }],
      },
    };
  };

  require.cache[axiosPath] = {
    id: axiosPath,
    filename: axiosPath,
    loaded: true,
    exports: { create: () => ({ get }) },
  };
  delete require.cache[clientPath];

  try {
    const { fetchOrderByCode } = require('./kaspiClient');
    const retried = await fetchOrderByCode('retry-me');
    assert.equal(retried.attributes.code, 'retry-me');
    assert.equal(attempts.get('retry-me'), 2);

    const codes = ['1001', '1002', '1003', '1004', '1005', '1006'];
    const orders = await Promise.all(codes.map((code) => fetchOrderByCode(code)));
    assert.deepEqual(orders.map((order) => order.attributes.code), codes);
    assert.ok(calls.every((call) => call.path === '/orders'));
    assert.ok(calls.every((call) => call.params['page[number]'] === 0));
    assert.ok(calls.every((call) => call.params['page[size]'] === 1));
    assert.ok(maxActive <= 4, `expected at most 4 concurrent requests, got ${maxActive}`);
  } finally {
    delete require.cache[clientPath];
    if (originalAxios) require.cache[axiosPath] = originalAxios;
    else delete require.cache[axiosPath];
  }
});
