const test = require('node:test');
const assert = require('node:assert/strict');

test('Wonder client returns cancellations but excludes ordinary returns', async () => {
  const axiosPath = require.resolve('axios');
  const clientPath = require.resolve('./wonderClient');

  require.cache[axiosPath] = {
    id: axiosPath,
    filename: axiosPath,
    loaded: true,
    exports: {
      post: async () => ({ data: { access: 'test-token' } }),
      create: () => ({
        get: async () => ({
          data: {
            content: [
              { order_code: 1080573013, type: 'CANCELED' },
              { order_code: 981304531, type: 'REFUND' },
            ],
            last: true,
          },
        }),
      }),
    },
  };

  const previousEmail = process.env.WONDER_EMAIL;
  const previousPassword = process.env.WONDER_PASSWORD;
  process.env.WONDER_EMAIL = 'test@example.com';
  process.env.WONDER_PASSWORD = 'secret';

  delete require.cache[clientPath];
  const { fetchWonderCancellationCodes } = require('./wonderClient');
  const codes = await fetchWonderCancellationCodes();

  assert.deepEqual([...codes], ['1080573013']);

  if (previousEmail === undefined) delete process.env.WONDER_EMAIL;
  else process.env.WONDER_EMAIL = previousEmail;
  if (previousPassword === undefined) delete process.env.WONDER_PASSWORD;
  else process.env.WONDER_PASSWORD = previousPassword;

  delete require.cache[clientPath];
  delete require.cache[axiosPath];
});
