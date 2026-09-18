const test = require('node:test');
const assert = require('node:assert/strict');

test('RETURNED orders remain deducted from available warehouse stock', async () => {
  const dbPath = require.resolve('../db');
  const warehousePath = require.resolve('./warehouse');

  let soldQueryParams = null;
  let soldQuerySql = null;
  let cancellationQueryParams = null;
  const query = async (sql, params) => {
    if (sql.includes('FROM product_batches')) {
      return {
        rows: [{
          id: 1,
          product_id: 'sku-1',
          product_name: 'Товар',
          cost_price: 1000,
          warehouse: 'Алматы',
          quantity: 10,
          received_date: '2026-06-01',
        }],
      };
    }

    if (sql.includes('FROM order_items') && sql.includes('customer_return_qty')) {
      soldQuerySql = sql;
      soldQueryParams = params;
      return {
        rows: [{
          product_id: 'sku-1',
          product_name: 'Товар',
          warehouse: 'Алматы',
          completed_qty: 2,
          in_progress_qty: 1,
          customer_return_qty: 1,
        }],
      };
    }

    if (sql.includes('FROM delivery_cancellations')) {
      cancellationQueryParams = params;
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool: { query } },
  };
  delete require.cache[warehousePath];
  const { computeWarehouseStock } = require('./warehouse');

  const products = await computeWarehouseStock();

  assert.ok(!soldQueryParams[0].includes('RETURNED'));
  assert.deepEqual(soldQueryParams[3], ['KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED']);
  assert.match(soldQuerySql, /dc\.order_number IS NULL/);
  assert.ok(!cancellationQueryParams[1].includes('RETURNED'));
  assert.equal(products[0].total_sold, 2);
  assert.equal(products[0].in_progress, 1);
  assert.equal(products[0].customer_returns, 1);
  assert.equal(products[0].remaining, 6);
  assert.equal(products[0].remaining_value, 6000);
});
