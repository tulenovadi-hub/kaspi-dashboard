// inventoryAsOf.js — деньги в товаре на начало заданного дня по Алматы и снимки на конец месяца.
//
// Статус заказа у нас хранится только текущий, поэтому прошлое положение заказа восстанавливается
// по датам, которые остались от него:
//   выдан         — completionDate у COMPLETED, иначе дата "Покупка" из Kaspi Pay (проходит в момент выдачи);
//   в работе      — заказ и сейчас не выдан, значит и тогда не был;
//   отмена едет   — first_seen_at (когда мы её увидели), конец — stock_returned_at (кнопка "+ в остаток").
// Когда дат не хватает, строка помечается оценкой, а заказ выданный, но без даты выдачи, уходит в
// "не определено": считать его ни выданным, ни едущим было бы подстановкой.
//
// Остаток считается той же формулой, что и "Склад" (assembleStock). Отличается только вход: партии,
// прибывшие до даты, с отменёнными перемещениями и списаниями, которые были позже, сверки до даты.
// С live: true тот же путь считает текущий момент по текущим статусам: это снимок на конец месяца
// и проверка checks.now, что формула сходится с "Деньгами в товаре" на "Складе".

const { STOCK_CUTOFF_DATE } = require('./constants');
const { MARKED_SELF_BUY_CITY, WRITE_OFF_CITY } = require('./warehouseMapping');
const { assembleStock, fifoRangeValue } = require('./stockAssembly');

const SALE_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];
const IN_PROGRESS_STATUSES = ['ACCEPTED_BY_MERCHANT', 'APPROVED_BY_BANK'];
const CUSTOMER_RETURN_STATUSES = ['KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED'];
const CANCELLATION_STATUSES = ['CANCELLING', 'CANCELLED'];

// Снимок считается снимком на начало дня, только если снят в первые часы этого дня.
const SNAPSHOT_MAX_DELAY_MS = 3 * 60 * 60 * 1000;

const almatyDayStart = (date) => new Date(`${date}T00:00:00+05:00`);
const almatyToday = (now = Date.now()) => new Date(now + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);

const isCancellation = (o) => CANCELLATION_STATUSES.includes(o.dc_status);

// Положение заказа сейчас. Те же условия, что в запросах computeWarehouseStock (routes/warehouse.js).
function classifyNow(o) {
  const hasCancellationRow = o.dc_order_number !== null;
  const countedAsSold = (o.was_completed
    || SALE_STATUSES.includes(o.status)
    || (CUSTOMER_RETURN_STATUSES.includes(o.status) && !hasCancellationRow))
    && !isCancellation(o);
  if (countedAsSold) {
    const inProgress = !o.was_completed && IN_PROGRESS_STATUSES.includes(o.status);
    return inProgress ? 'to_customers' : 'delivered';
  }

  const returning = o.stock_returned_at === null
    && o.archived_at === null
    && (isCancellation(o) || o.wonder_received === true)
    && (o.tracking_active === true
      || o.tracking_status === 'RETURNED'
      || o.wonder_received === true
      || (o.dc_status === 'CANCELLING' && o.tracking_status !== 'CANCELLED')
      || o.restored_from_archive === true)
    && (!o.was_completed || isCancellation(o))
    && (!SALE_STATUSES.includes(o.status) || isCancellation(o));
  return returning ? 'returning' : 'none';
}

const exact = (bucket) => ({ bucket, exact: true, reason: null });
const estimate = (bucket, reason) => ({ bucket, exact: false, reason });

function classifyDelivered(o, asOf, asOfDate) {
  if (o.manual_sale) return exact('delivered');
  if (o.status === 'COMPLETED' && o.completion_at) {
    return exact(new Date(o.completion_at) < asOf ? 'delivered' : 'to_customers');
  }
  if (o.first_purchase_date) return exact(o.first_purchase_date < asOfDate ? 'delivered' : 'to_customers');
  return { bucket: 'unresolved', exact: false, reason: 'Выдан, но нет ни даты выдачи от Kaspi, ни операции "Покупка" в Kaspi Pay' };
}

// Заказ, который сейчас не списан с остатка: отмена, завершённый возврат или снятый до доставки.
// Трекинг без RETURNED закончился тем, что товар никуда не вернулся и не уехал (отменён до отправки,
// FINISHED): после этой даты заказа в пути нет. RETURNED — товар приехал и ждал кнопку, это ещё в пути.
function classifyReleased(o, asOf) {
  const seenBefore = new Date(o.first_seen_at) < asOf;
  const before = (value) => Boolean(value) && new Date(value) < asOf;
  if (o.dc_order_number !== null) {
    if (o.stock_returned_at !== null) {
      if (before(o.stock_returned_at)) return exact('none');
      return seenBefore
        ? exact('returning')
        : estimate('to_customers', 'Отмена замечена позже даты: заказ точно был в пути, но неизвестно, в какую сторону');
    }
    if (before(o.archived_at)) return exact('none');
    if (o.tracking_status === 'RETURNED' && seenBefore) return estimate('returning', 'Вернулся на склад, позже убран из списка без кнопки: неизвестно, когда именно');
    if (o.tracking_active === false && before(o.last_track_at)) return exact('none');
  }
  if (before(o.completion_at)) return exact('none');
  if (o.dc_order_number !== null && seenBefore) return estimate('returning', 'Отмена уже была, но закончилась позже даты: неизвестно, ехала ли она на эту дату');
  return estimate('to_customers', 'Заказ отменён позже даты: неизвестно, был ли он уже принят и списан с остатка');
}

// Положение заказа на момент asOf (начало дня asOfDate).
function classifyAt(o, asOf, asOfDate) {
  if (new Date(o.creation_date) >= asOf) return exact('none');
  const now = classifyNow(o);
  if (now === 'delivered') return classifyDelivered(o, asOf, asOfDate);
  if (now === 'to_customers') return exact('to_customers');
  if (now === 'returning' && new Date(o.first_seen_at) < asOf) return exact('returning');
  if (now === 'returning') return estimate('to_customers', 'Отмена замечена позже даты: заказ точно был в пути, но неизвестно, в какую сторону');
  return classifyReleased(o, asOf);
}

// Убирает из партий перемещения и списания, которые случились не раньше даты: возвращает
// количество на склад-отправитель, откуда его забрали.
function undoStockMovesAfter(batches, moves) {
  const rows = batches.map((b) => ({ ...b }));
  for (const move of moves) {
    let left = move.quantity;
    const sources = rows
      .filter((b) => b.product_id === move.product_id && b.warehouse === move.to_warehouse && b.quantity > 0)
      .sort((a, b) => a.received_date.localeCompare(b.received_date) || a.id - b.id);
    for (const source of sources) {
      if (left === 0) break;
      const take = Math.min(source.quantity, left);
      source.quantity -= take;
      left -= take;
      const target = rows.find((b) => b.warehouse === move.from_warehouse && b.supply_key === source.supply_key && b.product_id === source.product_id);
      if (target) target.quantity += take;
      else rows.push({ ...source, id: source.id + 1e9, warehouse: move.from_warehouse, quantity: take });
    }
  }
  return rows
    .filter((b) => b.quantity > 0)
    .sort((a, b) => a.product_id.localeCompare(b.product_id) || a.warehouse.localeCompare(b.warehouse)
      || a.received_date.localeCompare(b.received_date) || a.id - b.id);
}

async function loadSources(db) {
  const [batches, orders, items, moves, adjustments] = await Promise.all([
    db.query(`
      SELECT id, product_id, product_name, cost_price, warehouse, quantity, received_date::text AS received_date,
             MIN(created_at) OVER (PARTITION BY COALESCE(supply_group_id, 'batch-' || id)) AS created_at,
             status, note, COALESCE(purchase_price, cost_price) AS purchase_price,
             COALESCE(logistics_cost, 0) AS logistics_cost, extra_expenses,
             COALESCE(supply_group_id, 'batch-' || id) AS supply_key
      FROM product_batches
      ORDER BY product_id, warehouse, received_date, id
    `),
    db.query(
      `SELECT o.id, o.code, o.creation_date, o.status, o.was_completed, o.origin_city, o.manual_sale,
              CASE WHEN o.raw_data->'attributes'->>'completionDate' ~ '^[0-9]+$'
                   THEN to_timestamp((o.raw_data->'attributes'->>'completionDate')::numeric / 1000.0) END AS completion_at,
              pay.first_purchase_date,
              dc.order_number AS dc_order_number, dc.status AS dc_status, dc.first_seen_at, dc.stock_returned_at,
              dc.archived_at, dc.last_track_at, dc.tracking_active, dc.tracking_status, dc.wonder_received, dc.restored_from_archive
       FROM orders o
       LEFT JOIN delivery_cancellations dc ON dc.order_number = o.code
       LEFT JOIN (
         SELECT order_number, MIN(operation_date)::text AS first_purchase_date
         FROM kaspi_pay_transactions
         WHERE operation_type = 'Покупка'
         GROUP BY order_number
       ) pay ON pay.order_number = o.code
       WHERE o.origin_city IS NOT NULL AND o.creation_date >= $1::date`,
      [STOCK_CUTOFF_DATE]
    ),
    db.query(`SELECT order_id, product_id, product_name, quantity FROM order_items`),
    db.query(`
      SELECT t.id, t.from_warehouse, t.to_warehouse, t.created_at,
             COALESCE((t.effective_date::text || 'T00:00:00+05:00')::timestamptz, t.created_at) AS moved_at,
             i.product_id, i.quantity
      FROM warehouse_transfers t
      JOIN warehouse_transfer_items i ON i.transfer_id = t.id
      WHERE t.cancelled_at IS NULL
      ORDER BY t.created_at DESC, i.id DESC
    `),
    db.query(`
      SELECT product_id, product_name, warehouse, balance_delta, value_delta, unit_cost, created_at, id
      FROM warehouse_stock_adjustments
      ORDER BY created_at, id
    `),
  ]);
  return { batches: batches.rows, orders: orders.rows, items: items.rows, moves: moves.rows, adjustments: adjustments.rows };
}

// cost_price — полная себестоимость единицы: закупка,
// логистика и прочие расходы; именно её берёт "Склад". Проверка показывает партии, где это не так.
function auditCosts(batches) {
  const sumExtras = (b) => (Array.isArray(b.extra_expenses) ? b.extra_expenses : [])
    .reduce((sum, e) => sum + Number(e.amount || 0) * Number(e.rate || 1), 0);
  const suspicious = [];
  let withoutLogistics = 0;
  for (const b of batches) {
    if (Number(b.logistics_cost) === 0) withoutLogistics += 1;
    const parts = Number(b.purchase_price) + Number(b.logistics_cost);
    if (Number(b.cost_price) + 0.5 < parts) {
      suspicious.push({ batch_id: b.id, product_name: b.product_name, warehouse: b.warehouse, cost_price: Number(b.cost_price), purchase_price: Number(b.purchase_price), logistics_cost: Number(b.logistics_cost), extra_total: sumExtras(b) });
    }
  }
  return { batches: batches.length, without_separate_logistics: withoutLogistics, cost_below_purchase_plus_logistics: suspicious };
}

function supplyInTransitAt(batches, asOf, asOfDate, live) {
  const rows = batches.filter((b) => (live
    ? b.status === 'in_transit'
    : new Date(b.created_at) < asOf && (b.status === 'in_transit' || b.received_date >= asOfDate)));
  let value = 0;
  let quantity = 0;
  for (const b of rows) {
    const q = Number(b.quantity);
    value += Number(b.purchase_price) * q + Math.max(0, (Number(b.cost_price) - Number(b.purchase_price)) * q);
    quantity += q;
  }
  return { value, quantity };
}

function sumLines(lines, predicate) {
  return lines.filter(predicate).reduce(
    (total, line) => ({ value: total.value + line.value, quantity: total.quantity + line.quantity }),
    { value: 0, quantity: 0 }
  );
}

// date — 'YYYY-MM-DD', начало этого дня по Алматы. Без date (live) — текущее положение.
async function computeInventoryAsOf(db, { date = null, live = false, sources = null } = {}) {
  const data = sources || await loadSources(db);
  const asOfDate = date || almatyToday();
  const asOf = live ? new Date() : almatyDayStart(asOfDate);

  const itemsByOrder = new Map();
  for (const item of data.items) {
    const list = itemsByOrder.get(item.order_id) || [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  const queues = new Map(); // `${product}::${city}` → счётчики и строки заказов в пути
  const queueOf = (item, order) => {
    const key = `${item.product_id}::${order.origin_city}`;
    if (!queues.has(key)) {
      queues.set(key, {
        product_id: item.product_id, product_name: item.product_name, warehouse: order.origin_city, delivered: 0, lines: [],
      });
    }
    return queues.get(key);
  };

  const ordersWithoutItems = [];
  const seenOrders = new Set();
  let duplicateOrders = 0;

  for (const order of data.orders) {
    if (seenOrders.has(order.id)) duplicateOrders += 1;
    seenOrders.add(order.id);
    if (order.origin_city === MARKED_SELF_BUY_CITY) continue;

    const placed = live
      ? exact(classifyNow(order))
      : classifyAt(order, asOf, asOfDate);
    if (placed.bucket === 'none') continue;

    const items = itemsByOrder.get(order.id) || [];
    if (items.length === 0) {
      if (placed.bucket !== 'delivered') ordersWithoutItems.push({ order_code: order.code, status: order.status, created_at: order.creation_date, bucket: placed.bucket });
      continue;
    }
    for (const item of items) {
      const queue = queueOf(item, order);
      const quantity = Number(item.quantity);
      if (placed.bucket === 'delivered') {
        queue.delivered += quantity;
      } else {
        queue.lines.push({
          order_code: order.code,
          created_at: order.creation_date,
          status: order.status,
          product_id: item.product_id,
          product_name: item.product_name,
          warehouse: order.origin_city,
          quantity,
          value: 0,
          bucket: placed.bucket,
          exact: placed.exact,
          reason: placed.reason,
        });
      }
    }
  }

  const received = live
    ? data.batches.filter((b) => b.status === 'received')
    : undoStockMovesAfter(data.batches, data.moves.filter((m) => new Date(m.moved_at) >= asOf))
      .filter((b) => b.status === 'received' && b.received_date < asOfDate);

  const inTransitOrder = { to_customers: 0, unresolved: 1, returning: 2 };
  const queueRows = [...queues.values()];
  for (const queue of queueRows) {
    queue.lines.sort((a, b) => inTransitOrder[a.bucket] - inTransitOrder[b.bucket]
      || new Date(a.created_at) - new Date(b.created_at));
  }

  const products = assembleStock({
    batches: received,
    sold: queueRows.map((q) => ({
      product_id: q.product_id,
      product_name: q.product_name,
      warehouse: q.warehouse,
      completed_qty: q.delivered,
      in_progress_qty: q.lines.filter((l) => l.bucket !== 'returning').reduce((sum, l) => sum + l.quantity, 0),
      customer_return_qty: 0,
    })),
    returning: queueRows.flatMap((q) => {
      const returning_qty = q.lines.filter((l) => l.bucket === 'returning').reduce((sum, l) => sum + l.quantity, 0);
      return returning_qty > 0 ? [{ product_id: q.product_id, product_name: q.product_name, warehouse: q.warehouse, returning_qty }] : [];
    }),
    adjustments: data.adjustments.filter((a) => live || new Date(a.created_at) < asOf),
  }).filter((p) => p.warehouse !== WRITE_OFF_CITY);

  // Цена каждой строки — её места в той же очереди FIFO, поэтому сумма строк равна вычтенному из остатка.
  const productByKey = new Map(products.map((p) => [`${p.product_id}::${p.warehouse}`, p]));
  const lines = [];
  for (const [key, queue] of queues) {
    const product = productByKey.get(key);
    let cursor = queue.delivered;
    for (const line of queue.lines) {
      if (product) {
        line.value = fifoRangeValue(product.batches, cursor, line.quantity, product.unit_cost_beyond);
        line.unpriced = product.unit_cost_beyond === null;
      }
      cursor += line.quantity;
      lines.push(line);
    }
  }
  lines.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const stockByWarehouse = new Map();
  let stockValue = 0;
  let stockQuantity = 0;
  for (const p of products) {
    stockValue += p.remaining_value;
    stockQuantity += p.remaining;
    stockByWarehouse.set(p.warehouse, (stockByWarehouse.get(p.warehouse) || 0) + p.remaining_value);
  }

  const supply = supplyInTransitAt(data.batches, asOf, asOfDate, live);
  const toCustomers = sumLines(lines, (l) => l.bucket === 'to_customers');
  const returning = sumLines(lines, (l) => l.bucket === 'returning');
  const unresolved = sumLines(lines, (l) => l.bucket === 'unresolved');
  const estimated = sumLines(lines, (l) => l.bucket !== 'unresolved' && !l.exact);
  const unpriced = sumLines(lines, (l) => l.unpriced);

  // Каждая единица должна быть ровно в одном месте: поставлено + сверки = выдано + в пути + на полке.
  const unitsBreak = products.flatMap((p) => {
    const queue = queues.get(`${p.product_id}::${p.warehouse}`);
    const inTransit = queue ? queue.lines.reduce((sum, l) => sum + l.quantity, 0) : 0;
    const delivered = queue ? queue.delivered : 0;
    const left = p.total_supplied + p.adjustment_balance - delivered - inTransit - p.remaining + p.oversold_qty;
    return left === 0 ? [] : [{ product_name: p.product_name, warehouse: p.warehouse, difference: left }];
  });
  const lineOrders = new Map();
  for (const line of lines) {
    const key = `${line.order_code}::${line.product_id}`;
    lineOrders.set(key, (lineOrders.get(key) || new Set()).add(line.bucket));
  }

  const backdated = live ? [] : data.batches
    .filter((b) => b.status === 'received' && b.received_date < asOfDate && new Date(b.created_at) >= asOf)
    .map((b) => ({ batch_id: b.id, product_name: b.product_name, warehouse: b.warehouse, quantity: Number(b.quantity), received_date: b.received_date, created_at: b.created_at }));

  return {
    date: asOfDate,
    as_of: asOf.toISOString(),
    source: live ? 'live' : 'reconstructed',
    stock_value: stockValue,
    stock_quantity: stockQuantity,
    stock_by_warehouse: [...stockByWarehouse.entries()].map(([warehouse, value]) => ({ warehouse, value })),
    in_transit_value: supply.value,
    in_transit_quantity: supply.quantity,
    total: stockValue + supply.value,
    to_customers_value: toCustomers.value,
    to_customers_quantity: toCustomers.quantity,
    returning_value: returning.value,
    returning_quantity: returning.quantity,
    off_shelf_value: toCustomers.value + returning.value,
    off_shelf_quantity: toCustomers.quantity + returning.quantity,
    estimated_value: estimated.value,
    estimated_quantity: estimated.quantity,
    // Не вошло ни в одну часть суммы: нет даты выдачи.
    unresolved_value: unresolved.value,
    unresolved_quantity: unresolved.quantity,
    off_shelf_unpriced_quantity: unpriced.quantity,
    orders_without_items: ordersWithoutItems,
    actual_total: stockValue + supply.value + toCustomers.value + returning.value,
    lines,
    checks: {
      units_break: unitsBreak,
      lines_in_several_buckets: [...lineOrders.entries()].filter(([, buckets]) => buckets.size > 1).map(([key]) => key),
      duplicate_orders: duplicateOrders,
      batches_entered_after_date: backdated,
      costs: auditCosts(data.batches.filter((b) => b.status === 'received')),
    },
  };
}

// Выдача и "Покупка" в Kaspi Pay должны приходиться на один день, иначе дата "Покупки" не годится
// как доказательство выдачи. Показывает, сколько заказов расходится и на сколько дней.
function comparePurchaseWithCompletion(orders) {
  const toAlmatyDay = (value) => almatyToday(new Date(value).getTime());
  const counts = {};
  for (const o of orders) {
    if (o.status !== 'COMPLETED' || !o.completion_at || !o.first_purchase_date) continue;
    const days = Math.round((new Date(o.first_purchase_date) - new Date(toAlmatyDay(o.completion_at))) / 86400000);
    counts[days] = (counts[days] || 0) + 1;
  }
  return counts; // { "0": 412, "1": 3 } — разница "Покупка" минус выдача, дней → заказов
}

// Как разошёлся бы расчёт текущего момента с "Деньгами в товаре" на "Складе". Должно быть 0.
async function checkAgainstWarehouse(db, computeInventoryValue) {
  const sources = await loadSources(db);
  const [rebuilt, warehouse] = await Promise.all([computeInventoryAsOf(db, { live: true, sources }), computeInventoryValue()]);
  return {
    stock_difference: rebuilt.stock_value - warehouse.stock_value,
    supply_difference: rebuilt.in_transit_value - warehouse.in_transit_value,
    to_customers_difference: rebuilt.to_customers_value - warehouse.to_customers_value,
    returning_difference: rebuilt.returning_value - warehouse.returning_value,
    purchase_minus_completion_days: comparePurchaseWithCompletion(sources.orders),
  };
}

// Снимок на начало текущего месяца: вызывается после каждой минутной синхронизации, снимается
// один раз, первым проходом месяца. Позже времени снимок дату не заменяет, см. getInventoryAt.
async function captureMonthSnapshot(db, now = Date.now()) {
  const date = `${almatyToday(now).slice(0, 7)}-01`;
  const existing = await db.query(`SELECT 1 FROM inventory_month_snapshots WHERE as_of_date = $1`, [date]);
  if (existing.rows.length > 0) return false;
  const snapshot = await computeInventoryAsOf(db, { date: almatyToday(now), live: true });
  await db.query(
    `INSERT INTO inventory_month_snapshots (as_of_date, payload) VALUES ($1, $2) ON CONFLICT (as_of_date) DO NOTHING`,
    [date, JSON.stringify(snapshot)]
  );
  return true;
}

// Снятый вовремя снимок точнее восстановления, всё остальное считается по датам.
async function getInventoryAt(db, date) {
  const { rows } = await db.query(
    `SELECT payload, captured_at FROM inventory_month_snapshots WHERE as_of_date = $1`,
    [date]
  );
  const snapshot = rows[0];
  if (snapshot && new Date(snapshot.captured_at) - almatyDayStart(date) <= SNAPSHOT_MAX_DELAY_MS) {
    return { ...snapshot.payload, date, source: 'snapshot', captured_at: snapshot.captured_at };
  }
  return computeInventoryAsOf(db, { date });
}

module.exports = {
  classifyNow, classifyAt, undoStockMovesAfter, computeInventoryAsOf, checkAgainstWarehouse, captureMonthSnapshot, getInventoryAt, almatyDayStart,
};
