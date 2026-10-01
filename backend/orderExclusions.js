const { pool } = require('./db');

function buildSummary(snapshot) {
  const items = snapshot.order_items || [];
  const transactions = snapshot.kaspi_pay_transactions || [];
  return {
    orders: (snapshot.orders || []).length,
    item_rows: items.length,
    item_quantity: items.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    transactions: transactions.length,
    purchase_amount: transactions
      .filter((row) => row.operation_type === 'Покупка')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0),
    refund_amount: Math.abs(transactions
      .filter((row) => row.operation_type === 'Возврат')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0)),
  };
}

async function excludeOrder(orderNumber, reason, excludedBy, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orderNumber]);

    const already = await client.query(
      'SELECT order_number FROM excluded_orders WHERE order_number = $1 FOR UPDATE',
      [orderNumber]
    );
    if (already.rowCount > 0) {
      const err = new Error('Этот заказ уже исключён из учёта');
      err.statusCode = 409;
      throw err;
    }

    const ordersResult = await client.query('SELECT * FROM orders WHERE code = $1 ORDER BY id', [orderNumber]);
    const orderIds = ordersResult.rows.map((row) => row.id);
    const [itemsResult, transactionsResult, cancellationResult, qualityResult] = await Promise.all([
      orderIds.length
        ? client.query('SELECT * FROM order_items WHERE order_id = ANY($1::text[]) ORDER BY id', [orderIds])
        : Promise.resolve({ rows: [] }),
      client.query('SELECT * FROM kaspi_pay_transactions WHERE order_number = $1 ORDER BY id', [orderNumber]),
      client.query('SELECT * FROM delivery_cancellations WHERE order_number = $1', [orderNumber]),
      client.query('SELECT * FROM quality_return_overrides WHERE order_number = $1', [orderNumber]),
    ]);

    const snapshot = {
      orders: ordersResult.rows,
      order_items: itemsResult.rows,
      kaspi_pay_transactions: transactionsResult.rows,
      delivery_cancellations: cancellationResult.rows,
      quality_return_overrides: qualityResult.rows,
    };
    const summary = buildSummary(snapshot);
    if (summary.orders === 0 && summary.transactions === 0 &&
        cancellationResult.rows.length === 0 && qualityResult.rows.length === 0) {
      const err = new Error(`Заказ ${orderNumber} не найден в данных сайта`);
      err.statusCode = 404;
      throw err;
    }

    await client.query(
      `INSERT INTO excluded_orders (order_number, reason, snapshot, excluded_by)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [orderNumber, reason, JSON.stringify(snapshot), excludedBy || null]
    );
    await client.query('DELETE FROM kaspi_pay_transactions WHERE order_number = $1', [orderNumber]);
    await client.query('DELETE FROM quality_return_overrides WHERE order_number = $1', [orderNumber]);
    await client.query('DELETE FROM delivery_cancellations WHERE order_number = $1', [orderNumber]);
    await client.query('DELETE FROM orders WHERE code = $1', [orderNumber]);
    await client.query('COMMIT');
    return summary;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function restoreRows(client, table, rows) {
  if (!rows || rows.length === 0) return;
  await client.query(
    `INSERT INTO ${table}
     SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(rows)]
  );
}

async function restoreOrder(orderNumber, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orderNumber]);
    const result = await client.query(
      'SELECT snapshot FROM excluded_orders WHERE order_number = $1 FOR UPDATE',
      [orderNumber]
    );
    if (result.rowCount === 0) {
      const err = new Error('Заказ не найден в списке исключений');
      err.statusCode = 404;
      throw err;
    }

    const snapshot = result.rows[0].snapshot || {};
    await restoreRows(client, 'orders', snapshot.orders);
    await restoreRows(client, 'order_items', snapshot.order_items);
    await restoreRows(client, 'kaspi_pay_transactions', snapshot.kaspi_pay_transactions);
    await restoreRows(client, 'delivery_cancellations', snapshot.delivery_cancellations);
    await restoreRows(client, 'quality_return_overrides', snapshot.quality_return_overrides);
    await client.query('DELETE FROM excluded_orders WHERE order_number = $1', [orderNumber]);
    await client.query('COMMIT');
    return buildSummary(snapshot);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { buildSummary, excludeOrder, restoreOrder };
