const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSummary, excludeOrder, restoreOrder } = require('./orderExclusions');

function fakeDb(handler) {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return handler(sql, params);
    },
    release() {},
  };
  return { connect: async () => client, calls };
}

test('excludeOrder snapshots every source and removes it from active accounting', async () => {
  const db = fakeDb(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM excluded_orders') && sql.includes('FOR UPDATE')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM orders WHERE code')) return { rows: [{ id: 'o1', code: '1089589665' }], rowCount: 1 };
    if (sql.includes('FROM order_items')) return { rows: [{ id: 'i1', order_id: 'o1', quantity: 1 }], rowCount: 1 };
    if (sql.includes('FROM kaspi_pay_transactions')) {
      return { rows: [
        { id: 1, operation_type: 'Покупка', amount: '49900' },
        { id: 2, operation_type: 'Возврат', amount: '-49900' },
      ], rowCount: 2 };
    }
    if (sql.includes('FROM delivery_cancellations')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM quality_return_overrides')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO excluded_orders')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('DELETE FROM')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const summary = await excludeOrder('1089589665', 'Ошибка склада', 'admin', db);

  assert.deepEqual(summary, {
    orders: 1, item_rows: 1, item_quantity: 1, transactions: 2,
    purchase_amount: 49900, refund_amount: 49900,
  });
  const sql = db.calls.map((call) => call.sql).join('\n');
  assert.match(sql, /INSERT INTO excluded_orders/);
  assert.match(sql, /DELETE FROM kaspi_pay_transactions/);
  assert.match(sql, /DELETE FROM orders/);
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
});

test('restoreOrder restores the snapshot before removing the permanent exclusion', async () => {
  const snapshot = {
    orders: [{ id: 'o1', code: '1089589665' }],
    order_items: [{ id: 'i1', order_id: 'o1', quantity: 1 }],
    kaspi_pay_transactions: [{ id: 1, order_number: '1089589665' }],
    delivery_cancellations: [],
    quality_return_overrides: [],
  };
  const db = fakeDb(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('SELECT snapshot')) return { rows: [{ snapshot }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('DELETE FROM excluded_orders')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  });

  await restoreOrder('1089589665', db);

  const statements = db.calls.map((call) => call.sql);
  const restoreOrderAt = statements.findIndex((sql) => sql.includes('NULL::orders'));
  const restoreItemsAt = statements.findIndex((sql) => sql.includes('NULL::order_items'));
  const deleteRuleAt = statements.findIndex((sql) => sql.startsWith('DELETE FROM excluded_orders'));
  assert.ok(restoreOrderAt > -1 && restoreItemsAt > restoreOrderAt);
  assert.ok(deleteRuleAt > restoreItemsAt);
  assert.equal(statements.at(-1), 'COMMIT');
});

test('buildSummary reports the stock and both financial sides', () => {
  assert.deepEqual(buildSummary({
    orders: [{}],
    order_items: [{ quantity: 2 }, { quantity: 3 }],
    kaspi_pay_transactions: [
      { operation_type: 'Покупка', amount: '100' },
      { operation_type: 'Возврат', amount: '-80' },
    ],
  }), {
    orders: 1, item_rows: 2, item_quantity: 5, transactions: 2,
    purchase_amount: 100, refund_amount: 80,
  });
});
