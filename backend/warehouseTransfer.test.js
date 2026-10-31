const assert = require('node:assert/strict');
const test = require('node:test');
const { planTransfer } = require('./warehouseTransfer');

const product = (...remaining) => ({ batches: remaining.map((value, i) => ({ id: i + 1, remaining: value })) });

test('transfer takes what is left in batches, oldest first', () => {
  assert.deepEqual(planTransfer(product(0, 4, 10), 6), {
    layers: [{ batchId: 2, quantity: 4 }, { batchId: 3, quantity: 2 }],
    fromAdjustment: 0,
  });
});

test('units added by a reconciliation beyond the batches are planned separately', () => {
  assert.deepEqual(planTransfer(product(0, 3), 5), { layers: [{ batchId: 2, quantity: 3 }], fromAdjustment: 2 });
  assert.deepEqual(planTransfer(product(), 2), { layers: [], fromAdjustment: 2 });
});
