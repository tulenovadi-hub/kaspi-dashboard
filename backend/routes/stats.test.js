const test = require('node:test');
const assert = require('node:assert/strict');

// routes/stats подключает pool при загрузке, но чистые функции ниже не обращаются к БД.
const { forecastUnknownItemProfit, returnProfitImpact } = require('./stats');

test('unknown-order forecast uses exact cost, tax and API delivery', () => {
  const result = forecastUnknownItemProfit({
    revenue: 30000,
    cost: 10000,
    commissionRate: 0.12,
    apiDeliveryCost: '1 500',
    orderShare: 1,
    deliveryPerUnit: 9999,
    quantity: 1,
  });

  assert.equal(result.commission, 3600);
  assert.equal(result.delivery, 1500);
  assert.equal(result.profit, 14000); // 30 000 - 10 000 - 3 600 - 1 500 - 900
  assert.equal(result.usedApiDelivery, true);
});

test('unknown-order forecast falls back to historical delivery only when API value is absent', () => {
  const result = forecastUnknownItemProfit({
    revenue: 60000,
    cost: 20000,
    commissionRate: 0.1,
    apiDeliveryCost: null,
    orderShare: 1,
    deliveryPerUnit: 1200,
    quantity: 2,
  });

  assert.equal(result.delivery, 2400);
  assert.equal(result.profit, 29800); // 60 000 - 20 000 - 6 000 - 2 400 - 1 800
  assert.equal(result.usedApiDelivery, false);
});

test('return impact includes commission credit, delivery adjustment and tax relief', () => {
  assert.equal(returnProfitImpact({
    amount: -30000,
    commissionTotal: 3600,
    deliveryCost: 0,
  }), 25500); // возврат 30 000 - комиссия 3 600 - налог 900
});

test('shared totals go to the product first and only the unlinked rest goes by revenue', () => {
  const { allocateToProducts } = require('./stats');
  const revenue = new Map([['a', 300], ['b', 100]]);

  const shares = allocateToProducts(100, new Map([['b', 60], ['sold-out', 20]]), revenue);
  assert.equal(shares.get('a'), 30, 'three quarters of the 40 left, nothing of its own');
  assert.equal(shares.get('b'), 70, 'its own 60 plus a quarter of the rest');
  assert.equal(shares.get('a') + shares.get('b'), 100, 'spend on a product with no sales stays in the total');

  assert.deepEqual([...allocateToProducts(80, new Map(), revenue).values()], [60, 20]);
  assert.deepEqual([...allocateToProducts(10, new Map(), new Map([['a', 0], ['b', 0]])).values()], [5, 5]);
});
