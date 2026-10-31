// warehouseTransfer.js — перемещение товара между складами.
//
// Партия в остатках — это строка product_batches на один город, а одна поставка уже умеет быть
// распределённой между городами (те же строки с общим supply_group_id). Поэтому перемещение
// меняет распределение поставки: количество уезжает из строки Алматы в строку Актобе той же
// поставки. Себестоимость и дата партии при этом не меняются, и все, кто читает product_batches
// (FIFO на "Складе", себестоимость в "Отчёте", "Закуп", оценка остатков), видят новый расклад
// без отдельной логики. На "Поставках" видно, что поставка теперь разделена.
//
// Забираем то, что ещё лежит в партиях, от старых к новым: как и продажа по FIFO. Единицы, уже
// списанные продажами, не трогаем, поэтому себестоимость прошлых заказов не меняется.
//
// Остаток бывает больше, чем лежит в партиях: сверка с фулфилментом могла добавить товар сверх
// расчёта. Такие единицы в партиях не записаны, и на новом складе у них не было бы себестоимости.
// Для них на складе-получателе заводится отдельная партия, а на складе-отправителе — списание в
// журнале сверок, чтобы общий остаток не изменился.

class TransferError extends Error {}

function planTransfer(product, quantity) {
  const layers = [];
  let left = quantity;
  for (const batch of product.batches) {
    if (left === 0) break;
    const take = Math.min(batch.remaining, left);
    if (take > 0) {
      layers.push({ batchId: batch.id, quantity: take });
      left -= take;
    }
  }
  return { layers, fromAdjustment: left };
}

const scaled = (value, share) => (value === null || value === undefined ? null : Number(value) * share);

function sumOptional(a, b) {
  if (a === null && b === null) return null;
  return Number(a || 0) + Number(b || 0);
}

function scaledExpenses(expenses, share) {
  return (Array.isArray(expenses) ? expenses : []).map((e) => ({ ...e, amount: Number(e.amount) * share }));
}

function mergeExpenses(current, added) {
  const merged = (Array.isArray(current) ? current : []).map((e) => ({ ...e }));
  for (const expense of added) {
    const match = merged.find((e) => e.name === expense.name && e.currency === expense.currency && e.rate === expense.rate);
    if (match) match.amount = Number(match.amount) + expense.amount;
    else merged.push(expense);
  }
  return merged;
}

// Переносит часть строки партии на другой склад в рамках той же поставки. В одной поставке на
// город ровно одна строка (иначе форма "Поставок" откажется её сохранять), поэтому существующую
// строку города дополняем, а опустевшую строку отправителя удаляем.
async function moveBatchQuantity(client, batchId, toWarehouse, quantity) {
  const { rows: [source] } = await client.query('SELECT * FROM product_batches WHERE id = $1 FOR UPDATE', [batchId]);
  if (!source) throw new TransferError('Партия изменилась, обновите страницу и повторите');

  const sourceQuantity = Number(source.quantity);
  if (quantity > sourceQuantity) throw new TransferError('Партия изменилась, обновите страницу и повторите');

  const share = quantity / sourceQuantity;
  const keep = 1 - share;
  const movedRemaining = Math.min(quantity, Number(source.remaining_quantity));
  const movedPurchase = scaled(source.purchase_amount_foreign, share);
  const movedLogistics = scaled(source.logistics_amount_foreign, share);
  const movedExpenses = scaledExpenses(source.extra_expenses, share);
  const supplyGroupId = source.supply_group_id || `batch-${source.id}`;

  const { rows: [target] } = await client.query(
    `SELECT id, extra_expenses, purchase_amount_foreign, logistics_amount_foreign
     FROM product_batches
     WHERE supply_group_id = $1 AND warehouse = $2 AND id <> $3
     ORDER BY id
     LIMIT 1
     FOR UPDATE`,
    [supplyGroupId, toWarehouse, source.id]
  );

  if (target) {
    await client.query(
      `UPDATE product_batches
       SET quantity = quantity + $1, remaining_quantity = remaining_quantity + $2,
           purchase_amount_foreign = $3, logistics_amount_foreign = $4, extra_expenses = $5
       WHERE id = $6`,
      [quantity, movedRemaining, sumOptional(target.purchase_amount_foreign, movedPurchase),
        sumOptional(target.logistics_amount_foreign, movedLogistics),
        JSON.stringify(mergeExpenses(target.extra_expenses, movedExpenses)), target.id]
    );
  } else {
    await client.query(
      `INSERT INTO product_batches
       (product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity,
        received_date, status, purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency,
        logistics_amount_foreign, logistics_rate, extra_expenses, supply_group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [source.product_id, source.product_name, source.cost_price, source.purchase_price, source.logistics_cost,
        source.note, toWarehouse, quantity, movedRemaining, source.received_date, source.status,
        source.purchase_currency, movedPurchase, source.purchase_rate, source.logistics_currency,
        movedLogistics, source.logistics_rate, JSON.stringify(movedExpenses), supplyGroupId]
    );
  }

  if (quantity === sourceQuantity) {
    await client.query('DELETE FROM product_batches WHERE id = $1', [source.id]);
  } else {
    await client.query(
      `UPDATE product_batches
       SET quantity = quantity - $1, remaining_quantity = remaining_quantity - $2, supply_group_id = $3,
           purchase_amount_foreign = $4, logistics_amount_foreign = $5, extra_expenses = $6
       WHERE id = $7`,
      [quantity, movedRemaining, supplyGroupId, scaled(source.purchase_amount_foreign, keep),
        scaled(source.logistics_amount_foreign, keep), JSON.stringify(scaledExpenses(source.extra_expenses, keep)), source.id]
    );
  }

  return quantity * Number(source.cost_price);
}

// Единицы сверх партий: партия на складе-получателе со сверочной себестоимостью и списание у
// отправителя. Строка сверки нужна, потому что корректировка остатка живёт только в этом журнале.
async function moveAdjustedQuantity(client, { transfer, product, quantity, id, createdAt }) {
  const unitCost = product.current_cost_price === null ? 0 : Number(product.current_cost_price);
  const value = quantity * unitCost;
  await client.query(
    `INSERT INTO product_batches
     (product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity,
      remaining_quantity, received_date, status, extra_expenses, supply_group_id)
     VALUES ($1,$2,$3,$3,0,$4,$5,$6,$6,$7::date,'received','[]',$8)`,
    [product.product_id, product.product_name, unitCost, `Перемещение из города ${transfer.from}: остаток по сверке`,
      transfer.to, quantity, createdAt, `transfer-${id}-${product.product_id}`]
  );
  const reconciliationId = `transfer-${id}-${product.product_id}`;
  await client.query(
    `INSERT INTO warehouse_reconciliations (id, source, source_captured_at, note, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [reconciliationId, `Перемещение: ${transfer.from} → ${transfer.to}`, createdAt, transfer.note, transfer.createdBy]
  );
  const before = Number(product.remaining);
  await client.query(
    `INSERT INTO warehouse_stock_adjustments
     (reconciliation_id, product_id, product_name, warehouse, quantity_before, target_quantity,
      display_change, balance_delta, unit_cost, value_delta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [reconciliationId, product.product_id, product.product_name, transfer.from, before, before - quantity,
      -quantity, -quantity, unitCost, -value]
  );
  return value;
}

// stock — результат computeWarehouseStock, посчитанный в этой же транзакции.
async function applyTransfer(client, transfer, stock, id, createdAt) {
  await client.query(
    `INSERT INTO warehouse_transfers (id, idempotency_key, from_warehouse, to_warehouse, note, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, transfer.idempotencyKey, transfer.from, transfer.to, transfer.note, transfer.createdBy, createdAt]
  );

  for (const item of transfer.items) {
    const product = stock.find((p) => p.product_id === item.productId && p.warehouse === transfer.from);
    const available = product ? Number(product.remaining) : 0;
    if (item.quantity > available) {
      throw new TransferError(`«${item.productName}»: на складе ${transfer.from} доступно ${available} шт.`);
    }

    const { layers, fromAdjustment } = planTransfer(product, item.quantity);
    let value = 0;
    for (const layer of layers) {
      value += await moveBatchQuantity(client, layer.batchId, transfer.to, layer.quantity);
    }
    if (fromAdjustment > 0) {
      value += await moveAdjustedQuantity(client, { transfer, product, quantity: fromAdjustment, id, createdAt });
    }

    await client.query(
      `INSERT INTO warehouse_transfer_items (transfer_id, product_id, product_name, quantity, value)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, item.productId, product.product_name || item.productName, item.quantity, value]
    );
  }
}

module.exports = { TransferError, planTransfer, applyTransfer };
