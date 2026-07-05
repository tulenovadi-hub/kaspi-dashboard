const { pool } = require('./db');

// Считает себестоимость проданных товаров по методу FIFO (та же логика, что на "Складе"),
// но только по тем заказам, которые реально есть в загруженном Excel-отчёте Kaspi Pay со статусом
// "Покупка" — так себестоимость и выручка всегда считаются по одному и тому же набору заказов,
// без каких-либо предположений про статус или способ оплаты. warehouses — необязательный
// список городов для фильтрации (если не передан — считает по всем городам сразу).
//
// Заодно считает "себестоимость возвратов" — чисто информационная метрика (не входит в чистую
// прибыль): по возврату нельзя точно узнать, с какой именно партии была куплена та конкретная
// единица (это отдельная строка в Excel, без прямой связи с исходной покупкой), поэтому берём
// приближение — себестоимость партии, с которой в этот момент идёт списание по этому товару/складу.
// Остаток на складе при этом не трогаем — товар уже был списан один раз при продаже.
//
// Дополнительно возвращает byOrderNumber — себестоимость по каждому конкретному заказу
// (нужно для постраничного списка заказов, а не только для сводки по месяцам).
async function computeCosts(warehouses) {
  const batchesResult = await pool.query(`
    SELECT product_id, warehouse, cost_price, quantity, received_date
    FROM product_batches
    ORDER BY product_id, warehouse, received_date, id
  `);

  // Важно: у одного заказа может быть НЕСКОЛЬКО строк в Excel-отчёте Kaspi Pay (например,
  // если в заказе несколько разных товаров). Если сначала join'ить kaspi_pay_transactions
  // с order_items напрямую, а у заказа и то, и другое больше одной строки — строки перемножатся
  // (2 строки в Excel × 2 товара = 4 вместо 2), и себестоимость задвоится. Поэтому сначала
  // схлопываем Excel-строки по номеру заказа в один "агрегат", и только потом соединяем с товарами.
  const soldResult = await pool.query(
    `WITH kpt_agg AS (
       SELECT order_number, MIN(operation_date) AS operation_date, BOOL_OR(operation_type = 'Возврат') AS has_return
       FROM kaspi_pay_transactions
       WHERE operation_type IN ('Покупка', 'Возврат')
       GROUP BY order_number
     )
     SELECT oi.product_id, o.origin_city AS warehouse, oi.quantity, ka.order_number,
            to_char(ka.operation_date, 'YYYY-MM') AS month, ka.operation_date,
            CASE WHEN ka.has_return THEN 'Возврат' ELSE 'Покупка' END AS operation_type
     FROM kpt_agg ka
     JOIN orders o ON o.code = ka.order_number
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.origin_city IS NOT NULL
       ${warehouses ? 'AND o.origin_city = ANY($1::text[])' : ''}
     ORDER BY oi.product_id, o.origin_city, ka.operation_date ASC`,
    warehouses ? [warehouses] : []
  );

  const batchesByKey = new Map();
  for (const b of batchesResult.rows) {
    const key = `${b.product_id}::${b.warehouse}`;
    if (!batchesByKey.has(key)) batchesByKey.set(key, []);
    batchesByKey.get(key).push({ cost_price: Number(b.cost_price), remaining: Number(b.quantity) });
  }

  const cogsByMonth = {};
  const returnsCostByMonth = {};
  const byOrderNumber = {}; // order_number -> { cost, type: 'Покупка' | 'Возврат' }

  function addOrderCost(orderNumber, cost) {
    if (!byOrderNumber[orderNumber]) byOrderNumber[orderNumber] = 0;
    byOrderNumber[orderNumber] += cost;
  }

  for (const row of soldResult.rows) {
    const key = `${row.product_id}::${row.warehouse}`;
    const batches = batchesByKey.get(key);
    if (!batches) continue; // нет партий для этого товара/склада — себестоимость неизвестна, пропускаем

    if (row.operation_type === 'Возврат') {
      // Себестоимость возврата — информационная метрика, остаток на складе не трогаем
      // (товар уже был списан один раз при продаже). Берём цену партии, которая сейчас "активна".
      const activeBatch = batches.find((b) => b.remaining > 0) || batches[batches.length - 1];
      const cost = Number(row.quantity) * activeBatch.cost_price;
      returnsCostByMonth[row.month] = (returnsCostByMonth[row.month] || 0) + cost;
      addOrderCost(row.order_number, cost);
      continue;
    }

    let qtyToConsume = Number(row.quantity);

    for (const batch of batches) {
      if (qtyToConsume <= 0) break;
      if (batch.remaining <= 0) continue;
      const consume = Math.min(batch.remaining, qtyToConsume);
      batch.remaining -= consume;
      qtyToConsume -= consume;
      const cost = consume * batch.cost_price;
      cogsByMonth[row.month] = (cogsByMonth[row.month] || 0) + cost;
      addOrderCost(row.order_number, cost);
    }
    // если qtyToConsume всё ещё > 0 — партий не хватило (oversold), эта часть остаётся без себестоимости
  }

  return { cogsByMonth, returnsCostByMonth, byOrderNumber };
}

module.exports = { computeCosts };
