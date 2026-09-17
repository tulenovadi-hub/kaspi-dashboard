const test = require('node:test');
const assert = require('node:assert/strict');

test('hidden products stay in response but do not affect purchasing totals', async () => {
  const dbPath = require.resolve('../db');
  const warehousePath = require.resolve('./warehouse');
  const purchasingPath = require.resolve('./purchasing');

  require.cache[warehousePath] = {
    id: warehousePath,
    filename: warehousePath,
    loaded: true,
    exports: {
      computeWarehouseStock: async () => ([
        { product_id: 'active', product_name: 'Новый товар', warehouse: 'Алматы', remaining: 0, current_cost_price: 1000 },
        { product_id: 'old', product_name: 'Старый товар', warehouse: 'Алматы', remaining: 0, current_cost_price: 2000 },
      ]),
    },
  };

  const query = async (sql) => {
    if (sql.includes('FROM purchasing_settings')) {
      return { rows: [{ lead_time_days: 14, buffer_pct: 30 }] };
    }
    if (sql.includes('FROM purchasing_hidden_products')) {
      return { rows: [{ product_id: 'old' }] };
    }
    if (sql.includes("status = 'in_transit'")) return { rows: [] };
    if (sql.includes('FROM order_items')) {
      return { rows: [{ product_id: 'active', qty: '30' }, { product_id: 'old', qty: '30' }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool: { query } },
  };
  delete require.cache[purchasingPath];
  const { computePurchasing } = require('./purchasing');

  const result = await computePurchasing();
  const active = result.products.find((product) => product.product_id === 'active');
  const old = result.products.find((product) => product.product_id === 'old');

  assert.equal(active.hidden, false);
  assert.equal(old.hidden, true);
  assert.equal(result.totals.to_purchase_qty, active.to_purchase);
  assert.equal(result.totals.to_purchase_value, active.to_purchase_value);
  assert.equal(result.totals.critical, 1);
});
