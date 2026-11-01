// stockAssembly.js — сборка остатка из партий, продаж, возвратов в пути и сверок.
// Одна формула и для сегодняшнего "Склада" (routes/warehouse.js), и для расчёта на прошлую дату
// (inventoryAsOf.js): разница между ними только в том, какие строки сюда передать.

// Сколько стоят единицы очереди FIFO с места skip по место skip + take. Единицы за концом партий
// (их остаток добавила сверка или продано больше, чем заведено) идут по unitCostBeyond.
function fifoRangeValue(batches, skip, take, unitCostBeyond) {
  let toSkip = skip;
  let left = take;
  let value = 0;
  for (const batch of batches) {
    if (left === 0) break;
    const skipped = Math.min(batch.quantity, toSkip);
    toSkip -= skipped;
    const taken = Math.min(batch.quantity - skipped, left);
    value += taken * batch.cost_price;
    left -= taken;
  }
  return value + left * (unitCostBeyond || 0);
}

function assembleStock({ batches: batchRows, sold: soldRows, returning: returningRows, adjustments: adjustmentRows }) {
  const soldMap = new Map(
    soldRows.map((r) => [
      `${r.product_id}::${r.warehouse}`,
      {
        completed: Number(r.completed_qty),
        inProgress: Number(r.in_progress_qty),
        customerReturns: Number(r.customer_return_qty),
      },
    ])
  );
  const soldProductNames = new Map(soldRows.map((r) => [r.product_id, r.product_name]));

  const returningMap = new Map(
    returningRows.map((r) => [`${r.product_id}::${r.warehouse}`, Number(r.returning_qty)])
  );
  for (const r of returningRows) {
    if (!soldProductNames.has(r.product_id)) soldProductNames.set(r.product_id, r.product_name);
  }

  // Группируем партии по паре (товар, склад) — у каждого склада своя FIFO-очередь
  const byKey = new Map();
  for (const b of batchRows) {
    const key = `${b.product_id}::${b.warehouse}`;
    if (!byKey.has(key)) {
      byKey.set(key, { product_id: b.product_id, product_name: b.product_name, warehouse: b.warehouse, batches: [] });
    }
    byKey.get(key).batches.push({
      id: b.id,
      received_date: b.received_date,
      cost_price: Number(b.cost_price),
      quantity: Number(b.quantity),
      remaining: Number(b.quantity),
    });
  }

  // Цена товара в городе, где своих партий нет: последняя партия этого товара на любом складе.
  const newestBatchByProduct = new Map();
  for (const b of batchRows) {
    const newest = newestBatchByProduct.get(b.product_id);
    if (!newest || new Date(b.received_date) >= new Date(newest.received_date)) newestBatchByProduct.set(b.product_id, b);
  }

  const products = [];
  for (const [key, info] of byKey) {
    const sold = soldMap.get(key) || { completed: 0, inProgress: 0, customerReturns: 0 };
    const returning = returningMap.get(key) || 0;
    // Обычный возврат покупателя не становится доступным к продаже автоматически: он может
    // быть повреждён и сначала возвращается в пункт приёма Kaspi. Поэтому RETURNED остаётся
    // списанным навсегда. Ручное возвращение предусмотрено только для отмен при доставке.
    let toConsume = sold.completed + sold.inProgress + sold.customerReturns + returning;
    let totalSupplied = 0;
    let remainingValue = 0;

    for (const batch of info.batches) {
      totalSupplied += batch.quantity;
      const consume = Math.min(batch.remaining, toConsume);
      batch.remaining -= consume;
      toConsume -= consume;
      remainingValue += batch.remaining * batch.cost_price;
    }

    const totalRemaining = info.batches.reduce((sum, b) => sum + b.remaining, 0);
    const activeBatch = info.batches.find((b) => b.remaining > 0);

    products.push({
      product_id: info.product_id,
      product_name: info.product_name,
      warehouse: info.warehouse,
      total_supplied: totalSupplied,
      total_sold: sold.completed,
      in_progress: sold.inProgress,
      customer_returns: sold.customerReturns,
      returning,
      remaining: totalRemaining,
      remaining_value: remainingValue,
      current_cost_price: activeBatch ? activeBatch.cost_price : null,
      oversold_qty: toConsume > 0 ? toConsume : 0,
      batches: info.batches.map((b) => ({
        id: b.id,
        received_date: b.received_date,
        cost_price: b.cost_price,
        quantity: b.quantity,
        remaining: b.remaining,
      })),
    });
  }

  // Продажи (и возвраты в пути) с городом, для которого вообще нет ни одной партии — это тоже
  // важно показать, иначе они "потеряются" молча. Добавляем их отдельными строками с нулевым
  // остатком.
  for (const key of new Set([...soldMap.keys(), ...returningMap.keys()])) {
    const [productId, warehouse] = key.split('::');
    const alreadyListed = products.some((p) => p.product_id === productId && p.warehouse === warehouse);
    if (alreadyListed) continue;

    const sold = soldMap.get(key) || { completed: 0, inProgress: 0, customerReturns: 0 };
    const returning = returningMap.get(key) || 0;
    products.push({
      product_id: productId,
      product_name: soldProductNames.get(productId) || productId,
      warehouse,
      total_supplied: 0,
      total_sold: sold.completed,
      in_progress: sold.inProgress,
      customer_returns: sold.customerReturns,
      returning,
      remaining: 0,
      remaining_value: 0,
      current_cost_price: null,
      oversold_qty: sold.completed + sold.inProgress + sold.customerReturns + returning,
      batches: [],
    });
  }

  // Отдельный журнал сверок с физическим складом. Корректировки не переписывают партии и
  // продажи: они сдвигают математический баланс на зафиксированную разницу. Поэтому новый
  // заказ после сверки по-прежнему уменьшит остаток на одну штуку, а историю можно показать
  // человеку целиком и при необходимости проверить задним числом.
  const adjustments = new Map();
  for (const row of adjustmentRows) {
    const key = `${row.product_id}::${row.warehouse}`;
    const current = adjustments.get(key) || {
      product_id: row.product_id,
      product_name: row.product_name,
      warehouse: row.warehouse,
      balance: 0,
      value: 0,
      latestUnitCost: null,
    };
    current.balance += Number(row.balance_delta);
    current.value += Number(row.value_delta);
    if (row.product_name) current.product_name = row.product_name;
    if (row.unit_cost !== null) current.latestUnitCost = Number(row.unit_cost);
    adjustments.set(key, current);
  }

  const productByKey = new Map(products.map((p) => [`${p.product_id}::${p.warehouse}`, p]));
  for (const [key, adjustment] of adjustments) {
    let product = productByKey.get(key);
    // Нулевая строка нужна в журнале, чтобы снимок был полным (например, Wonder явно показал
    // 0 в Астане), но отдельную пустую карточку товара на самом «Складе» создавать не надо.
    if (!product && adjustment.balance === 0 && adjustment.value === 0) continue;
    if (!product) {
      product = {
        product_id: adjustment.product_id,
        product_name: adjustment.product_name || adjustment.product_id,
        warehouse: adjustment.warehouse,
        total_supplied: 0,
        total_sold: 0,
        in_progress: 0,
        customer_returns: 0,
        returning: 0,
        remaining: 0,
        remaining_value: 0,
        current_cost_price: null,
        oversold_qty: 0,
        batches: [],
      };
      products.push(product);
      productByKey.set(key, product);
    }

    // До корректировки отрицательный математический баланс показывался как остаток 0 плюс
    // предупреждение oversold. Сверка должна обнулить и этот скрытый долг, иначе товар с
    // фактическим остатком 500 превратился бы в 499 сразу после фиксации.
    const rawBalance = Number(product.remaining) - Number(product.oversold_qty || 0);
    const adjustedBalance = rawBalance + adjustment.balance;
    product.calculated_remaining = Number(product.remaining);
    product.adjustment_balance = adjustment.balance;
    product.remaining = Math.max(0, adjustedBalance);
    product.oversold_qty = Math.max(0, -adjustedBalance);

    if (product.batches.length === 0 && adjustment.latestUnitCost !== null) {
      // У нового товара партий ещё нет: стоимость контрольного остатка берём из сохранённой
      // себестоимости самой сверки и дальше уменьшаем вместе с количеством.
      product.remaining_value = product.remaining * adjustment.latestUnitCost;
      product.current_cost_price = adjustment.latestUnitCost;
    } else {
      product.remaining_value = Math.max(0, Number(product.remaining_value) + adjustment.value);
      if (product.current_cost_price === null && adjustment.latestUnitCost !== null) {
        product.current_cost_price = adjustment.latestUnitCost;
      }
    }
  }

  for (const product of products) {
    if (product.calculated_remaining === undefined) product.calculated_remaining = product.remaining;
    if (product.adjustment_balance === undefined) product.adjustment_balance = 0;

    // Товар, ушедший с полки, но ещё не у покупателя: в той же очереди FIFO он стоит сразу за
    // уже выданным, поэтому и цена у него та самая, по которой он списался из остатка.
    const lastBatch = product.batches[product.batches.length - 1];
    const newestBatch = newestBatchByProduct.get(product.product_id);
    const unitCostBeyond = lastBatch?.cost_price ?? product.current_cost_price ?? (newestBatch ? Number(newestBatch.cost_price) : null);
    const delivered = product.total_sold + product.customer_returns;
    product.unit_cost_beyond = unitCostBeyond;
    product.in_progress_value = fifoRangeValue(product.batches, delivered, product.in_progress, unitCostBeyond);
    product.returning_value = fifoRangeValue(product.batches, delivered + product.in_progress, product.returning, unitCostBeyond);
    product.off_shelf_unpriced = unitCostBeyond === null ? product.in_progress + product.returning : 0;
  }

  return products;
}

module.exports = { fifoRangeValue, assembleStock };
