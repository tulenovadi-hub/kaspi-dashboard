const test = require('node:test');
const assert = require('node:assert/strict');

test('product breakdown uses monthly operations and allocates shared costs by issued orders', async () => {
  const month = '2026-09';
  const dbPath = require.resolve('../db');
  const costEnginePath = require.resolve('../costEngine');
  const reportsPath = require.resolve('./reports');

  require.cache[costEnginePath] = {
    id: costEnginePath,
    filename: costEnginePath,
    loaded: true,
    exports: {
      computeCosts: async () => ({
        cogsByProductMonth: { [month]: { a: 200, b: 150 } },
        returnsCostByProductMonth: { [month]: { a: 100 } },
      }),
    },
  };

  const query = async (sql, params = []) => {
    if (sql.includes('FROM kaspi_pay_transactions kpt')) {
      return {
        rows: [
          {
            order_number: 'current-sale', transaction_product_name: 'A + B',
            purchases_amount: '1000', returns_amount: '0',
            commission_total: '-100', delivery_total: '-50',
          },
          {
            order_number: 'old-sale-returned-now', transaction_product_name: 'A',
            purchases_amount: '0', returns_amount: '-300',
            commission_total: '30', delivery_total: '0',
          },
        ],
      };
    }

    if (sql.includes('FROM order_items') && sql.includes('order_number')) {
      return {
        rows: [
          { order_number: 'current-sale', product_id: 'a', product_name: 'A', total_price: '600' },
          { order_number: 'current-sale', product_id: 'b', product_name: 'B', total_price: '400' },
          { order_number: 'old-sale-returned-now', product_id: 'a', product_name: 'A', total_price: '300' },
        ],
      };
    }

    if (sql.includes('FROM order_items')) return { rows: [] };

    if (sql.includes('FROM ad_expenses') && sql.includes('GROUP BY campaign_id')) {
      return { rows: [{ campaign_id: 'ad-a', total_cost: '60' }, { campaign_id: 'ad-b', total_cost: '40' }] };
    }
    if (sql.includes('FROM ad_campaign_products')) {
      return { rows: [{ campaign_id: 'ad-a', product_id: 'a' }, { campaign_id: 'ad-b', product_id: 'b' }] };
    }
    if (sql.includes('FROM bonus_expenses') && sql.includes('GROUP BY campaign_id')) return { rows: [] };
    if (sql.includes('FROM review_bonus_expenses') && sql.includes('GROUP BY campaign_id')) return { rows: [] };

    if (sql.includes('FROM ad_expenses')) return { rows: [{ month, total: '100' }] };
    if (sql.includes('FROM bonus_expenses')) return { rows: [] };
    if (sql.includes('FROM review_bonus_expenses')) return { rows: [] };

    if (sql.includes('FROM expenses')) {
      return params[0] === 'Упаковка'
        ? { rows: [{ month, total: '100' }] }
        : { rows: [{ month, total: '200' }] };
    }

    throw new Error(`Unexpected query: ${sql}`);
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool: { query } },
  };
  delete require.cache[reportsPath];
  const { getProductBreakdownForMonth } = require('./reports');

  const rows = await getProductBreakdownForMonth(month, null);
  const byId = new Map(rows.map((row) => [row.product_id, row]));
  const sum = (key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

  assert.equal(sum('revenue'), 1000, 'return of an old sale must not add that sale to current revenue');
  assert.equal(sum('returns'), 300);
  assert.equal(sum('issued_orders'), 2, 'the return must not count as an issued order');
  assert.equal(byId.get('a').packaging, 50);
  assert.equal(byId.get('b').packaging, 50);
  assert.equal(byId.get('a').other_expenses, 100);
  assert.equal(byId.get('b').other_expenses, 100);
  assert.equal(sum('taxes'), 21);
  assert.equal(sum('net_profit'), -191);
  assert.equal(byId.get('a').margin, (-179 / 600) * 100, 'margin must use gross revenue before returns');
});
