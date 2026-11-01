const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyNow, classifyAt, undoStockMovesAfter, almatyDayStart } = require('./inventoryAsOf');

const DATE = '2026-10-01';
const AS_OF = almatyDayStart(DATE);

const order = (fields) => ({
  creation_date: '2026-09-29T05:00:00Z', status: 'COMPLETED', was_completed: true, manual_sale: false,
  completion_at: null, first_purchase_date: null, dc_order_number: null, dc_status: null, first_seen_at: null,
  stock_returned_at: null, archived_at: null, tracking_active: null, tracking_status: null, wonder_received: null,
  restored_from_archive: false, ...fields,
});
const at = (fields) => classifyAt(order(fields), AS_OF, DATE);
const cancellation = (fields) => ({ status: 'CANCELLED', was_completed: false, dc_order_number: 'c', dc_status: 'CANCELLED', ...fields });

test('the day starts at midnight in Almaty, not UTC', () => {
  assert.equal(AS_OF.toISOString(), '2026-09-30T19:00:00.000Z');
  assert.equal(at({ completion_at: '2026-09-30T18:59:00Z' }).bucket, 'delivered');
  assert.equal(at({ completion_at: '2026-09-30T19:00:00Z' }).bucket, 'to_customers');
});

test('a delivered order is placed by the delivery date, never guessed', () => {
  assert.deepEqual(at({ status: 'RETURNED', first_purchase_date: '2026-09-30' }), { bucket: 'delivered', exact: true, reason: null });
  assert.equal(at({ status: 'RETURNED', first_purchase_date: '2026-10-01' }).bucket, 'to_customers');
  assert.equal(at({ status: 'RETURNED', completion_at: '2026-10-20T00:00:00Z' }).bucket, 'unresolved', 'completionDate возврата — не дата выдачи');
  assert.equal(at({}).bucket, 'unresolved');
  assert.equal(at({ manual_sale: true }).bucket, 'delivered');
});

test('an order created on or after the date does not exist yet', () => {
  assert.equal(at({ creation_date: '2026-09-30T19:00:00Z', first_purchase_date: '2026-09-01' }).bucket, 'none');
});

test('an order still in progress now was on its way then', () => {
  assert.deepEqual(at({ status: 'ACCEPTED_BY_MERCHANT', was_completed: false }), { bucket: 'to_customers', exact: true, reason: null });
});

test('a cancellation is on its way back from when it was seen until the stock button', () => {
  const returning = cancellation({ first_seen_at: '2026-09-29T10:00:00Z', stock_returned_at: '2026-10-15T00:00:00Z' });
  assert.deepEqual(at(returning), { bucket: 'returning', exact: true, reason: null });
  assert.equal(at({ ...returning, stock_returned_at: '2026-09-30T00:00:00Z' }).bucket, 'none');

  const seenLater = at(cancellation({ first_seen_at: '2026-10-05T00:00:00Z', stock_returned_at: '2026-10-07T00:00:00Z' }));
  assert.equal(seenLater.bucket, 'to_customers');
  assert.equal(seenLater.exact, false);

  const stillComing = cancellation({ status: 'CANCELLING', dc_status: 'CANCELLING', first_seen_at: '2026-09-29T10:00:00Z', tracking_active: true });
  assert.equal(classifyNow(order(stillComing)), 'returning');
  assert.deepEqual(at(stillComing), { bucket: 'returning', exact: true, reason: null });
});

test('a cancellation without tracking now is only an estimate for the past', () => {
  const placed = at(cancellation({ first_seen_at: '2026-09-29T10:00:00Z' }));
  assert.equal(placed.bucket, 'returning');
  assert.equal(placed.exact, false);
});

test('an order cancelled before delivery is out once its life ended, an estimate before that', () => {
  const dropped = { status: 'CANCELLED', was_completed: false };
  assert.deepEqual(at({ ...dropped, completion_at: '2026-09-30T00:00:00Z' }), { bucket: 'none', exact: true, reason: null });
  assert.equal(at({ ...dropped, completion_at: '2026-10-02T00:00:00Z' }).exact, false);
});

test('undoing a later write-off puts units back into the same supply', () => {
  const batches = [
    { id: 1, product_id: 'p', warehouse: 'Алматы', quantity: 8, received_date: '2026-09-15', supply_key: 'g', status: 'received' },
    { id: 2, product_id: 'p', warehouse: 'Списано', quantity: 2, received_date: '2026-09-15', supply_key: 'g', status: 'received' },
    { id: 3, product_id: 'p', warehouse: 'Актобе', quantity: 3, received_date: '2026-09-20', supply_key: 'h', status: 'received' },
  ];
  const rows = undoStockMovesAfter(batches, [
    { product_id: 'p', from_warehouse: 'Алматы', to_warehouse: 'Списано', quantity: 2 },
    { product_id: 'p', from_warehouse: 'Алматы', to_warehouse: 'Актобе', quantity: 1 },
  ]);
  assert.deepEqual(rows.map((b) => [b.warehouse, b.supply_key, b.quantity]), [['Актобе', 'h', 2], ['Алматы', 'g', 10], ['Алматы', 'h', 1]]);
  assert.equal(batches[0].quantity, 8, 'исходные строки не меняются');
});
