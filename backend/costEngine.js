const { pool } = require('./db');
const { STOCK_CUTOFF_DATE } = require('./constants');

// Считает себестоимость проданных товаров по методу FIFO (та же логика, что на "Складе"),
// но только по тем заказам, которые реально есть в загруженном Excel-отчёте Kaspi Pay со статусом
// "Покупка" — так себестоимость и выручка всегда считаются по одному и тому же набору заказов,
// без каких-либо предположений про статус или способ оплаты. warehouses — необязательный
// список городов для фильтрации (если не передан — считает по всем городам сразу).
//
// ВАЖНО про дату отсечки (STOCK_CUTOFF_DATE): партии на "Поставках" были введены как снимок
// остатков НА эту дату. Поэтому заказы СТАРШЕ этой даты (например, история продаж с начала года,
// загруженная позже) вообще не списывают эти партии — иначе они "съели" бы остаток, который
// на самом деле относится только к продажам с даты отсечки и позже. Вместо списания для таких
// старых заказов себестоимость единицы товара берётся из цены САМОЙ ПЕРВОЙ (по дате поступления)
// партии этого товара/склада — это просто оценка, ничего физически не списывается.
//
// Заодно считает "себестоимость возвратов" — чисто информационная метрика (не входит в чистую
// прибыль): по возврату нельзя точно узнать, с какой именно партии была куплена та конкретная
// единица (это отдельная строка в Excel, без прямой связи с исходной покупкой), поэтому берём
// приближение — себестоимость партии, с которой в этот момент идёт списание по этому товару/складу
// (или цену первой партии, если возврат тоже относится к периоду до даты отсечки).
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

  // Важно: у одного заказа может быть НЕСКОЛЬКО строк в Excel-отчёте Kaspi Pay — например,
  // если в заказе несколько разных товаров (тогда несколько строк "Покупка"), либо если товар
  // купили и потом вернули (тогда одна строка "Покупка" и одна "Возврат" с тем же номером заказа).
  // Группируем по (номер заказа, тип операции) — так покупка и возврат внутри одного заказа
  // считаются раздельно (возврат не "перекрывает" покупку целиком), а несколько строк одного
  // типа (несколько товаров в заказе) по-прежнему схлопываются в одну группу, чтобы не задваивать
  // себестоимость при последующем join с order_items.
  //
  // Дата для сравнения с cutoff — дата ЗАКАЗА (o.creation_date), а не дата операции в Excel-отчёте:
  // это те же поля, что использует "Склад" и графики "Чистая прибыль", так что все части приложения
  // одинаково понимают, какие заказы относятся к периоду "до остатков", а какие — после.
  const soldResult = await pool.query(
    `WITH kpt_agg AS (
       SELECT order_number, operation_type, MIN(operation_date) AS operation_date
       FROM kaspi_pay_transactions
       WHERE operation_type IN ('Покупка', 'Возврат')
       GROUP BY order_number, operation_type
     )
     SELECT oi.product_id, o.origin_city AS warehouse, oi.quantity, ka.order_number,
            to_char(ka.operation_date, 'YYYY-MM') AS month, ka.operation_date, ka.operation_type,
            o.creation_date
     FROM kpt_agg ka
     JOIN orders o ON o.code = ka.order_number
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.origin_city IS NOT NULL
       ${warehouses ? 'AND o.origin_city = ANY($1::text[])' : ''}
     ORDER BY oi.product_id, o.origin_city, o.creation_date ASC`,
    warehouses ? [warehouses] : []
  );

  const batchesByKey = new Map();
  const firstBatchPriceByKey = new Map(); // цена самой первой (по дате поступления) партии — для оценки старых заказов
  for (const b of batchesResult.rows) {
    const key = `${b.product_id}::${b.warehouse}`;
    if (!batchesByKey.has(key)) batchesByKey.set(key, []);
    batchesByKey.get(key).push({ cost_price: Number(b.cost_price), remaining: Number(b.quantity) });
    if (!firstBatchPriceByKey.has(key)) firstBatchPriceByKey.set(key, Number(b.cost_price));
  }

  const cogsByMonth = {};
  const returnsCostByMonth = {};
  const byOrderKey = {}; // "order_number::operation_type" -> себестоимость

  function addOrderCost(orderNumber, operationType, cost) {
    const key = `${orderNumber}::${operationType}`;
    byOrderKey[key] = (byOrderKey[key] || 0) + cost;
  }

  for (const row of soldResult.rows) {
    const key = `${row.product_id}::${row.warehouse}`;
    const isBeforeCutoff = new Date(row.creation_date) < new Date(STOCK_CUTOFF_DATE);

    if (isBeforeCutoff) {
      // Заказ старше даты отсечки — склад не трогаем вообще, просто оцениваем по цене первой
      // поставки (если по этому товару/складу вообще нет ни одной партии — оценить нечем, пропускаем).
      const price = firstBatchPriceByKey.get(key);
      if (price === undefined) continue;
      const cost = Number(row.quantity) * price;
      if (row.operation_type === 'Возврат') {
        returnsCostByMonth[row.month] = (returnsCostByMonth[row.month] || 0) + cost;
      } else {
        cogsByMonth[row.month] = (cogsByMonth[row.month] || 0) + cost;
      }
      addOrderCost(row.order_number, row.operation_type, cost);
      continue;
    }

    const batches = batchesByKey.get(key);
    if (!batches) continue; // нет партий для этого товара/склада — себестоимость неизвестна, пропускаем

    if (row.operation_type === 'Возврат') {
      // Себестоимость возврата — информационная метрика, остаток на складе не трогаем
      // (товар уже был списан один раз при продаже). Берём цену партии, которая сейчас "активна".
      const activeBatch = batches.find((b) => b.remaining > 0) || batches[batches.length - 1];
      const cost = Number(row.quantity) * activeBatch.cost_price;
      returnsCostByMonth[row.month] = (returnsCostByMonth[row.month] || 0) + cost;
      addOrderCost(row.order_number, row.operation_type, cost);
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
      addOrderCost(row.order_number, row.operation_type, cost);
    }
    // если qtyToConsume всё ещё > 0 — партий не хватило (oversold), эта часть остаётся без себестоимости
  }

  return { cogsByMonth, returnsCostByMonth, byOrderKey };
}

module.exports = { computeCosts };
