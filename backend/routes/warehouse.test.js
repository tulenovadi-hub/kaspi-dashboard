const test = require('node:test');
const assert = require('node:assert/strict');

test('active delivery cancellations remain deducted from available warehouse stock', async () => {
  const dbPath = require.resolve('../db');
  const warehousePath = require.resolve('./warehouse');

  let soldQueryParams = null;
  let soldQuerySql = null;
  let cancellationQueryParams = null;
  let cancellationQuerySql = null;
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
      cancellationQuerySql = sql;
      cancellationQueryParams = params;
      return { rows: [] };
    }
    if (sql.includes('FROM warehouse_stock_adjustments')) return { rows: [] };
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
  assert.match(soldQuerySql, /o\.was_completed = true/);
  assert.deepEqual(soldQueryParams[5], ['CANCELLING', 'CANCELLED']);
  assert.ok(!cancellationQueryParams[1].includes('RETURNED'));
  assert.deepEqual(cancellationQueryParams[2], ['CANCELLING', 'CANCELLED']);
  assert.match(cancellationQuerySql, /o\.was_completed = false OR dc\.status/);
  assert.match(cancellationQuerySql, /dc\.archived_at IS NULL/);
  assert.match(cancellationQuerySql, /dc\.restored_from_archive = true/);
  assert.match(cancellationQuerySql, /dc\.status = 'CANCELLING'/);
  assert.match(cancellationQuerySql, /dc\.wonder_received = true/);
  assert.match(cancellationQuerySql, /dc\.status = ANY\(\$3::text\[\]\) OR dc\.wonder_received = true/);
  assert.equal(products[0].total_sold, 2);
  assert.equal(products[0].in_progress, 1);
  assert.equal(products[0].customer_returns, 1);
  assert.equal(products[0].remaining, 6);
  assert.equal(products[0].remaining_value, 6000);
});

test('warehouse reconciliation shifts stock without rewriting supplied quantities', async () => {
  const dbPath = require.resolve('../db');
  const warehousePath = require.resolve('./warehouse');

  const query = async (sql) => {
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
    if (sql.includes('customer_return_qty')) {
      return {
        rows: [{
          product_id: 'sku-1', product_name: 'Товар', warehouse: 'Алматы',
          completed_qty: 2, in_progress_qty: 1, customer_return_qty: 0,
        }],
      };
    }
    if (sql.includes('FROM delivery_cancellations')) return { rows: [] };
    if (sql.includes('FROM warehouse_stock_adjustments')) {
      return {
        rows: [{
          id: 1, product_id: 'sku-1', product_name: 'Товар', warehouse: 'Алматы',
          balance_delta: -2, value_delta: -2000, unit_cost: 1000, created_at: '2026-09-18T04:40:00Z',
        }],
      };
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

  const [product] = await computeWarehouseStock();
  assert.equal(product.total_supplied, 10);
  assert.equal(product.calculated_remaining, 7);
  assert.equal(product.adjustment_balance, -2);
  assert.equal(product.remaining, 5);
  assert.equal(product.remaining_value, 5000);
});

test('actual money in goods adds units on the way to customers and back, at their own FIFO price', async () => {
  const dbPath = require.resolve('../db');
  const warehousePath = require.resolve('./warehouse');
  const { MARKED_SELF_BUY_CITY } = require('../warehouseMapping');

  const sale = (product_id, warehouse, counts) => ({
    product_id, product_name: product_id, warehouse, completed_qty: 0, in_progress_qty: 0, customer_return_qty: 0, ...counts,
  });
  const query = async (sql) => {
    if (sql.includes("status = 'in_transit'")) {
      return { rows: [{ id: 9, product_id: 'sku-1', product_name: 'Товар', warehouse: 'Алматы', quantity: 1, note: null, purchase_price: 400, cost_price: 500 }] };
    }
    if (sql.includes('FROM product_batches')) {
      return {
        rows: [
          { id: 1, product_id: 'sku-1', product_name: 'Товар', cost_price: 1000, warehouse: 'Алматы', quantity: 5, received_date: '2026-06-01' },
          { id: 2, product_id: 'sku-1', product_name: 'Товар', cost_price: 2000, warehouse: 'Алматы', quantity: 5, received_date: '2026-07-01' },
        ],
      };
    }
    if (sql.includes('customer_return_qty')) {
      return {
        rows: [
          sale('sku-1', 'Алматы', { completed_qty: 3, customer_return_qty: 1, in_progress_qty: 2 }),
          sale('sku-1', 'Актобе', { in_progress_qty: 1 }),
          sale('sku-1', MARKED_SELF_BUY_CITY, { in_progress_qty: 1 }),
          sale('sku-new', 'Алматы', { in_progress_qty: 2 }),
        ],
      };
    }
    if (sql.includes('FROM delivery_cancellations')) {
      return { rows: [{ product_id: 'sku-1', product_name: 'Товар', warehouse: 'Алматы', returning_qty: 1 }] };
    }
    if (sql.includes('FROM warehouse_stock_adjustments')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: { query } } };
  delete require.cache[warehousePath];
  const { computeInventoryValue } = require('./warehouse');

  const inventory = await computeInventoryValue();

  assert.equal(inventory.stock_value, 6000, 'остаток со "Склада" считается как раньше');
  assert.equal(inventory.total, 6500);
  // Алматы: 1 шт по 1000 и 1 по 2000, Актобе без партий: по цене последней партии товара.
  assert.equal(inventory.to_customers_value, 5000);
  assert.equal(inventory.to_customers_quantity, 5);
  assert.equal(inventory.returning_value, 2000);
  assert.equal(inventory.returning_quantity, 1);
  assert.equal(inventory.off_shelf_unpriced_quantity, 2);
  assert.equal(inventory.actual_total, 13500);
});
