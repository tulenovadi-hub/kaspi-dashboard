const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExpirySchedule,
  buildMetricWindow,
  getMetricState,
  getReturnCapacity,
} = require('./qualityReturnsLogic');

test('строит закрытое 30-дневное окно с задержкой кабинета на один день', () => {
  assert.deepEqual(buildMetricWindow('2026-09-18'), { start: '2026-08-19', end: '2026-09-17' });
});

test('для 3 возвратов из 280 показывает 1,1% и запас ещё в 2 возврата', () => {
  const state = getMetricState(3, 280);
  assert.equal(state.key, 'normal');
  assert.equal(Number(state.rate.toFixed(1)), 1.1);
  assert.equal(getReturnCapacity(3, 280), 2);
});

test('ровно 2% уже считается риском', () => {
  assert.equal(getMetricState(2, 100).key, 'risk');
  assert.equal(getReturnCapacity(1, 100), 0);
});

test('показывает день, когда возврат пропадёт из кабинета', () => {
  assert.deepEqual(buildExpirySchedule([
    { order_number: '1', return_date: '2026-08-30' },
    { order_number: '2', return_date: '2026-08-30' },
    { order_number: '3', return_date: '2026-09-03' },
  ]), [
    { date: '2026-09-30', count: 2, orders: ['1', '2'] },
    { date: '2026-10-04', count: 1, orders: ['3'] },
  ]);
});
