const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { STOCK_CUTOFF_DATE } = require('../constants');
const { enqueueKaspiSync } = require('../syncCoordinator');

const router = express.Router();

// Обычные продажи и принятые в работу заказы.
const SALE_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];
const COMPLETED_STATUSES = ['COMPLETED'];
const IN_PROGRESS_STATUSES = ['ACCEPTED_BY_MERCHANT', 'APPROVED_BY_BANK'];
const CUSTOMER_RETURN_STATUSES = ['KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED'];
const DELIVERY_CANCELLATION_STATUSES = ['CANCELLING', 'CANCELLED'];

// На "Складе" показываем только склады с display: true в справочнике — самовыкупные
// (Юбилейное, Талдыкорган, Атырау) сюда не входят, они отслеживаются на других страницах.
const { DISPLAY_CITIES: DISPLAY_WAREHOUSES, CITY_ORDER: WAREHOUSE_SORT_ORDER, ALL_CITIES, MAIN_CITIES, SELF_BUY_CITIES, MARKED_SELF_BUY_CITY, WRITE_OFF_CITY } = require('../warehouseMapping');
const { TransferError, applyTransfer } = require('../warehouseTransfer');

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

// Считает остатки по методу FIFO отдельно для каждого склада (города):
// партии одного города списываются только продажами (и возвратами в пути, см. ниже),
// отгруженными с этого же города
// (Kaspi возвращает город отгрузки в attributes.originAddress.city.name — сохраняем
// его в orders.origin_city при синхронизации).
//
// ВАЖНО: product_batches.remaining_quantity в базе НЕ уменьшается при продажах (это просто
// значение, введённое при добавлении/редактировании партии) — настоящий остаток здесь всегда
// пересчитывается заново по факту продаж, эту функцию и нужно переиспользовать всюду, где нужен
// реальный остаток (например, AI Финансист), а не читать remaining_quantity напрямую.
//
// remaining здесь — это то, что РЕАЛЬНО ЛЕЖИТ НА ПОЛКЕ: из него вычтено и проданное, и
// потенциальное пополнение из основного списка "Отмены при доставке" (поле returning).
async function computeWarehouseStock(db = pool, { includeWrittenOff = false } = {}) {
  // Партии со статусом 'in_transit' (заказаны у поставщика, физически ещё не приехали) не входят
  // в реальный остаток склада — они учитываются отдельно на "Закупе" в колонке "В пути".
  const batchesResult = await db.query(`
    SELECT id, product_id, product_name, cost_price, warehouse, quantity, received_date
    FROM product_batches
    WHERE status = 'received'
    ORDER BY product_id, warehouse, received_date, id
  `);

  // Заказы без origin_city — это самовывоз напрямую у продавца (DELIVERY_PICKUP, не через Kaspi
  // Delivery), Kaspi не присылает по ним точку отгрузки. Владелец подтвердил, что это склад
  // "Юбилейное", который на сайте учитывать не нужно, поэтому такие заказы просто исключаем.
  const soldResult = await db.query(
    `SELECT oi.product_id, MAX(oi.product_name) AS product_name, o.origin_city AS warehouse,
            SUM(CASE WHEN o.status = ANY($2::text[])
                           OR (o.was_completed = true AND o.status <> ALL($4::text[]))
                     THEN oi.quantity ELSE 0 END) AS completed_qty,
            SUM(CASE WHEN o.was_completed = false AND o.status = ANY($3::text[])
                     THEN oi.quantity ELSE 0 END) AS in_progress_qty,
            SUM(CASE WHEN o.status = ANY($4::text[]) THEN oi.quantity ELSE 0 END) AS customer_return_qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN delivery_cancellations dc ON dc.order_number = o.code
     WHERE (o.was_completed = true
            OR o.status = ANY($1::text[])
            OR (o.status = ANY($4::text[]) AND dc.order_number IS NULL))
       AND o.origin_city IS NOT NULL
       AND o.creation_date >= $5::date
       AND (dc.order_number IS NULL OR dc.status IS NULL OR dc.status <> ALL($6::text[]))
     GROUP BY oi.product_id, o.origin_city`,
    [
      SALE_STATUSES,
      COMPLETED_STATUSES,
      IN_PROGRESS_STATUSES,
      CUSTOMER_RETURN_STATUSES,
      STOCK_CUTOFF_DATE,
      DELIVERY_CANCELLATION_STATUSES,
    ]
  );
  const soldMap = new Map(
    soldResult.rows.map((r) => [
      `${r.product_id}::${r.warehouse}`,
      {
        completed: Number(r.completed_qty),
        inProgress: Number(r.in_progress_qty),
        customerReturns: Number(r.customer_return_qty),
      },
    ])
  );
  const soldProductNames = new Map(soldResult.rows.map((r) => [r.product_id, r.product_name]));

  // "Возвращается" — количество товара из ОСНОВНОГО списка страницы "Отмены при доставке",
  // которое ещё может быть добавлено обратно кнопкой "+ в остаток". Поэтому источник истины
  // здесь те же правила, по которым строка попадает в основной список: активный возврат,
  // подтверждение фулфилмента Wonder либо ручное восстановление из архива, без archived_at.
  // После нажатия кнопки stock_returned_at заполняется и позиция перестаёт входить в колонку.
  //
  // Из выборки исключены заказы, статус которых у нас всё ещё "продажа" (SALE_STATUSES), а
  // также все заказы, которые когда-либо были выданы покупателю. Они уже навсегда списаны
  // выше, и кнопка отмены при доставке не должна суметь вернуть их в доступный остаток.
  const returningResult = await db.query(
    `SELECT oi.product_id, MAX(oi.product_name) AS product_name, o.origin_city AS warehouse,
            SUM(oi.quantity) AS returning_qty
     FROM delivery_cancellations dc
     JOIN orders o ON o.code = dc.order_number
     JOIN order_items oi ON oi.order_id = o.id
     WHERE dc.stock_returned_at IS NULL
       AND dc.archived_at IS NULL
       AND (dc.status = ANY($3::text[]) OR dc.wonder_received = true)
       AND (
         dc.tracking_active = true
         OR dc.tracking_status = 'RETURNED'
         OR dc.wonder_received = true
         OR (dc.status = 'CANCELLING' AND dc.tracking_status IS DISTINCT FROM 'CANCELLED')
         OR dc.restored_from_archive = true
       )
       AND o.origin_city IS NOT NULL
       AND o.creation_date >= $1::date
       AND (o.was_completed = false OR dc.status = ANY($3::text[]))
       AND (o.status <> ALL($2::text[]) OR dc.status = ANY($3::text[]))
     GROUP BY oi.product_id, o.origin_city`,
    [STOCK_CUTOFF_DATE, SALE_STATUSES, DELIVERY_CANCELLATION_STATUSES]
  );
  const returningMap = new Map(
    returningResult.rows.map((r) => [`${r.product_id}::${r.warehouse}`, Number(r.returning_qty)])
  );
  for (const r of returningResult.rows) {
    if (!soldProductNames.has(r.product_id)) soldProductNames.set(r.product_id, r.product_name);
  }

  // Группируем партии по паре (товар, склад) — у каждого склада своя FIFO-очередь
  const byKey = new Map();
  for (const b of batchesResult.rows) {
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
  for (const b of batchesResult.rows) {
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
  const adjustmentResult = await db.query(`
    SELECT product_id, product_name, warehouse, balance_delta, value_delta, unit_cost, created_at, id
    FROM warehouse_stock_adjustments
    ORDER BY created_at, id
  `);
  const adjustments = new Map();
  for (const row of adjustmentResult.rows) {
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
    product.in_progress_value = fifoRangeValue(product.batches, delivered, product.in_progress, unitCostBeyond);
    product.returning_value = fifoRangeValue(product.batches, delivered + product.in_progress, product.returning, unitCostBeyond);
    product.off_shelf_unpriced = unitCostBeyond === null ? product.in_progress + product.returning : 0;
  }

  // Списанный товар уже не лежит на складе: ни в остатках, ни в деньгах в товаре, ни на "Закупе".
  return includeWrittenOff ? products : products.filter((p) => p.warehouse !== WRITE_OFF_CITY);
}

// Партия "в пути" бывает не только товаром: ей же заводят депозиты и авансы поставщику
// (в примечании так и написано — "Депозит у поставщика 3000 USD", 1 шт по 1 464 000 ₸).
// Деньги по ним действительно отданы, поэтому из суммы "в пути" мы их не выкидываем, но
// показываем отдельной строкой "в том числе" — иначе полтора миллиона выглядят как один
// проектор по цене квартиры. Определяем по примечанию: отдельного признака у партии пока нет.
const DEPOSIT_NOTE_RE = /депозит|аванс|предоплат/i;

// "Сколько денег лежит в товаре": остаток на складах по себестоимости + оплаченное поставщику
// по партиям, которые ещё в пути. Считается по ВСЕМ складам, включая самовыкупные — на самой
// странице "Склад" их не видно (display: false), но деньги в этом товаре лежат такие же.
async function computeInventoryValue() {
  const products = await computeWarehouseStock();

  const stockByWarehouse = new Map();
  let stockValue = 0;
  // Деньги в товаре по КАЖДОМУ товару — для разбивки под плиткой "Деньги в товаре сейчас" на
  // Главной. Копится теми же слагаемыми и в том же порядке, что и total ниже (остаток по
  // себестоимости + всё вложенное в партии в пути), поэтому сумма по товарам равна итогу
  // до копейки — иначе проценты в разбивке врали бы.
  const byProduct = new Map();
  const addToProduct = (productId, name, value, quantity) => {
    const key = productId || `name:${name}`;
    const row = byProduct.get(key) || { product_id: productId || null, product_name: name, value: 0, quantity: 0 };
    row.value += value;
    row.quantity += quantity;
    if (!row.product_name && name) row.product_name = name;
    byProduct.set(key, row);
  };

  // Товар, который из остатка уже вычтен, но ещё наш: едет к клиенту или возвращается отменой.
  // В stock_value и total он не входит, это только для "Фактически в товаре" в "Отчёте".
  // Отмеченные самовыкупы со склада не уходили, им здесь не место.
  const toCustomers = { value: 0, quantity: 0 };
  const returning = { value: 0, quantity: 0 };
  let offShelfUnpriced = 0;

  for (const p of products) {
    stockValue += p.remaining_value;
    stockByWarehouse.set(p.warehouse, (stockByWarehouse.get(p.warehouse) || 0) + p.remaining_value);
    // Один товар лежит на нескольких складах — строки складов складываются в одну товарную.
    addToProduct(p.product_id, p.product_name, p.remaining_value, p.remaining);

    if (p.warehouse === MARKED_SELF_BUY_CITY) continue;
    toCustomers.value += p.in_progress_value;
    toCustomers.quantity += p.in_progress;
    returning.value += p.returning_value;
    returning.quantity += p.returning;
    offShelfUnpriced += p.off_shelf_unpriced;
  }

  // Считаем по ПОЛНОЙ себестоимости партии (cost_price = закупка + логистика + прочие расходы за
  // 1 шт), а закупка отдельно показывается в подписи. Сначала логистика в итог не входила, но это
  // расходилось с карточкой "На складе": там остаток тоже считается по cost_price, то есть уже с
  // логистикой. Владелец указал на это 2026-09-01 — из-за расхождения капитал был занижен
  // на 570 637 ₸. Всё, что вложено в товар, вложено в товар, когда бы оно ни было оплачено.
  // COALESCE — у партий, заведённых до появления отдельной колонки, purchase_price = cost_price.
  const transitResult = await pool.query(`
    SELECT id, product_id, product_name, warehouse, quantity, note,
           COALESCE(purchase_price, cost_price) AS purchase_price,
           cost_price
    FROM product_batches
    WHERE status = 'in_transit'
    ORDER BY id
  `);

  let transitPurchase = 0;
  let transitExtra = 0;
  let transitQuantity = 0;
  let depositsValue = 0;
  const deposits = [];

  for (const b of transitResult.rows) {
    const quantity = Number(b.quantity);
    const purchase = Number(b.purchase_price) * quantity;
    // Логистика и прочие расходы = разница между полной себестоимостью и закупкой. Отрицательной
    // она быть не может, но если данные кривые — не даём ей уменьшать сумму.
    const extra = Math.max(0, (Number(b.cost_price) - Number(b.purchase_price)) * quantity);

    transitPurchase += purchase;
    transitExtra += extra;
    transitQuantity += quantity;
    // Депозиты и авансы поставщику тоже заводятся партией в пути (см. DEPOSIT_NOTE_RE выше) —
    // они остаются в разбивке под своим названием партии, потому что деньги в них реально
    // вложены и в итоге они учтены.
    addToProduct(b.product_id, b.product_name, purchase + extra, quantity);

    if (b.note && DEPOSIT_NOTE_RE.test(b.note)) {
      depositsValue += purchase;
      deposits.push({ id: b.id, product_name: b.product_name, note: b.note, value: purchase });
    }
  }

  return {
    stock_value: stockValue,
    stock_by_warehouse: [...stockByWarehouse.entries()]
      .map(([warehouse, value]) => ({ warehouse, value }))
      .sort((a, b) => (WAREHOUSE_SORT_ORDER[a.warehouse] ?? 99) - (WAREHOUSE_SORT_ORDER[b.warehouse] ?? 99)),
    // in_transit_value — полная сумма, вложенная в партии в пути; purchase и extra — из чего она
    // состоит (для подписи под цифрой).
    in_transit_value: transitPurchase + transitExtra,
    in_transit_purchase: transitPurchase,
    in_transit_extra: transitExtra,
    in_transit_quantity: transitQuantity,
    deposits_value: depositsValue,
    deposits,
    // "Всего в товаре" = остаток по себестоимости + всё вложенное в партии, которые ещё едут.
    // Обе части считаются одинаково — по полной себестоимости, вместе с логистикой.
    total: stockValue + transitPurchase + transitExtra,
    to_customers_value: toCustomers.value,
    to_customers_quantity: toCustomers.quantity,
    returning_value: returning.value,
    returning_quantity: returning.quantity,
    // Штуки без единой партии на всех складах: цены у них нет, в сумму они вошли нулём.
    off_shelf_unpriced_quantity: offShelfUnpriced,
    actual_total: stockValue + transitPurchase + transitExtra + toCustomers.value + returning.value,
    // Те же деньги, разложенные по товарам (сумма by_product === total). Нули не отдаём: товар
    // с нулевым остатком в разбивке "сколько денег лежит" — просто шум.
    by_product: [...byProduct.values()]
      .filter((row) => row.value !== 0)
      .sort((a, b) => b.value - a.value),
  };
}

// Отдельный лёгкий роут: те же цифры нужны и блоку на "Складе", и плитке на Главной,
// а тащить ради них весь список товаров со склада не нужно.
// Состав складов для подписей на страницах. Отдаётся всем ролям: "Самовыкупы" и "Склад" открыты
// и менеджеру, а настройки складов — только админу.
router.get('/cities', (req, res) => {
  const selfbuy = SELF_BUY_CITIES.filter((city) => city !== MARKED_SELF_BUY_CITY);
  res.json({ main: MAIN_CITIES, selfbuy, display: DISPLAY_WAREHOUSES, all: ALL_CITIES });
});

router.get('/inventory-value', async (req, res) => {
  try {
    res.json(await computeInventoryValue());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось посчитать стоимость товарных остатков' });
  }
});

async function loadReconciliation(id = null, db = pool) {
  const params = id ? [id] : [];
  const where = id ? 'WHERE r.id = $1' : '';
  const result = await db.query(
    `SELECT r.id, r.idempotency_key, r.source, r.source_captured_at, r.note,
            r.created_by, r.created_at,
            a.id AS adjustment_id, a.product_id, a.product_name, a.warehouse,
            a.quantity_before, a.target_quantity, a.display_change, a.balance_delta,
            a.unit_cost, a.value_delta
     FROM warehouse_reconciliations r
     LEFT JOIN warehouse_stock_adjustments a ON a.reconciliation_id = r.id
     ${where}
     ORDER BY r.created_at DESC, a.id`,
    params
  );

  const groups = new Map();
  for (const row of result.rows) {
    if (!groups.has(row.id)) {
      groups.set(row.id, {
        id: row.id,
        idempotency_key: row.idempotency_key,
        source: row.source,
        source_captured_at: row.source_captured_at,
        note: row.note,
        created_by: row.created_by,
        created_at: row.created_at,
        items: [],
      });
    }
    if (row.adjustment_id !== null) {
      groups.get(row.id).items.push({
        id: row.adjustment_id,
        product_id: row.product_id,
        product_name: row.product_name,
        warehouse: row.warehouse,
        quantity_before: Number(row.quantity_before),
        target_quantity: Number(row.target_quantity),
        display_change: Number(row.display_change),
        balance_delta: Number(row.balance_delta),
        unit_cost: row.unit_cost === null ? null : Number(row.unit_cost),
        value_delta: Number(row.value_delta),
      });
    }
  }
  return [...groups.values()];
}

// Полная история контрольных точек: что показывал расчёт, что сообщил фулфилмент и какая
// разница была применена. Доступна на самой странице «Склад» всем вошедшим пользователям.
router.get('/reconciliations', async (req, res) => {
  try {
    res.json({ reconciliations: await loadReconciliation() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить историю сверок' });
  }
});

// Зафиксировать фактический снимок склада. Выполняется в общей очереди синхронизаций Kaspi:
// пока считаем «до» и записываем разницу, минутное обновление заказов не сможет вклиниться
// между этими двумя действиями.
router.post('/reconcile', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Недостаточно прав для фиксации остатков' });
  }

  const { source, source_captured_at: capturedAt, note, items, idempotency_key: idempotencyKey } = req.body || {};
  if (!source || !capturedAt || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Нужны источник, время снимка и список остатков' });
  }
  const capturedDate = new Date(capturedAt);
  if (Number.isNaN(capturedDate.getTime())) {
    return res.status(400).json({ error: 'Некорректное время снимка' });
  }

  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const productId = String(item.product_id || '').trim();
    const productName = String(item.product_name || productId).trim();
    const warehouse = String(item.warehouse || '').trim();
    const target = Number(item.target_quantity);
    const requestedCost = item.unit_cost === null || item.unit_cost === undefined || item.unit_cost === ''
      ? null
      : Number(item.unit_cost);
    const snapshotBefore = item.quantity_before === null || item.quantity_before === undefined || item.quantity_before === ''
      ? null
      : Number(item.quantity_before);
    const snapshotRawBalance = item.raw_balance_before === null || item.raw_balance_before === undefined || item.raw_balance_before === ''
      ? null
      : Number(item.raw_balance_before);
    const key = `${productId}::${warehouse}`;
    if (!productId || !DISPLAY_WAREHOUSES.includes(warehouse) || !Number.isInteger(target) || target < 0) {
      return res.status(400).json({ error: `Некорректная строка остатка: ${productName || productId}` });
    }
    if (requestedCost !== null && (!Number.isFinite(requestedCost) || requestedCost < 0)) {
      return res.status(400).json({ error: `Некорректная себестоимость: ${productName}` });
    }
    if ((snapshotBefore !== null && !Number.isInteger(snapshotBefore)) ||
        (snapshotRawBalance !== null && !Number.isInteger(snapshotRawBalance))) {
      return res.status(400).json({ error: `Некорректный исходный снимок: ${productName}` });
    }
    if (seen.has(key)) return res.status(400).json({ error: `Товар ${productName} повторяется на складе ${warehouse}` });
    seen.add(key);
    normalized.push({ productId, productName, warehouse, target, requestedCost, snapshotBefore, snapshotRawBalance });
  }

  try {
    const reconciliation = await enqueueKaspiSync('warehouse-reconciliation', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (idempotencyKey) {
          const existing = await client.query(
            'SELECT id FROM warehouse_reconciliations WHERE idempotency_key = $1',
            [String(idempotencyKey)]
          );
          if (existing.rowCount > 0) {
            await client.query('COMMIT');
            return (await loadReconciliation(existing.rows[0].id))[0];
          }
        }

        const currentProducts = await computeWarehouseStock(client);
        const currentMap = new Map(currentProducts.map((p) => [`${p.product_id}::${p.warehouse}`, p]));
        const id = crypto.randomUUID();
        await client.query(
          `INSERT INTO warehouse_reconciliations
             (id, idempotency_key, source, source_captured_at, note, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, idempotencyKey ? String(idempotencyKey) : null, String(source), capturedDate.toISOString(), note || null, req.user.username || null]
        );

        for (const item of normalized) {
          const key = `${item.productId}::${item.warehouse}`;
          const current = currentMap.get(key);
          const currentBefore = current ? Number(current.remaining) : 0;
          const currentRawBalance = current ? currentBefore - Number(current.oversold_qty || 0) : 0;
          // Для снимка, который прислали несколькими минутами раньше, разрешаем передать
          // значения «до» из того же момента. Тогда заказы, появившиеся пока шёл деплой, не
          // смешиваются со сверкой: в журнале остаётся честное 33 → 20, а новый заказ уже
          // после этой точки отдельно уменьшит текущий остаток до 19.
          const before = item.snapshotBefore !== null ? item.snapshotBefore : currentBefore;
          // remaining уже включает прошлые контрольные точки. oversold_qty хранит скрытую
          // отрицательную часть математического баланса, которую новая точка тоже сбрасывает.
          const rawBalance = item.snapshotRawBalance !== null
            ? item.snapshotRawBalance
            : item.snapshotBefore !== null
              ? item.snapshotBefore
              : currentRawBalance;
          const displayChange = item.target - before;
          const balanceDelta = item.target - rawBalance;
          const unitCost = item.requestedCost !== null
            ? item.requestedCost
            : current && current.current_cost_price !== null
              ? Number(current.current_cost_price)
              : null;
          if (item.target > 0 && unitCost === null) {
            throw new Error(`Для товара «${item.productName}» нужна себестоимость`);
          }
          const valueDelta = displayChange * (unitCost || 0);

          await client.query(
            `INSERT INTO warehouse_stock_adjustments
               (reconciliation_id, product_id, product_name, warehouse, quantity_before,
                target_quantity, display_change, balance_delta, unit_cost, value_delta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, item.productId, item.productName, item.warehouse, before, item.target,
              displayChange, balanceDelta, unitCost, valueDelta]
          );
        }

        await client.query('COMMIT');
        return (await loadReconciliation(id))[0];
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });

    res.status(201).json({ ok: true, reconciliation });
  } catch (err) {
    console.error(err);
    if (err.code === '23505' && idempotencyKey) {
      const existing = await pool.query('SELECT id FROM warehouse_reconciliations WHERE idempotency_key = $1', [String(idempotencyKey)]);
      if (existing.rowCount > 0) {
        return res.json({ ok: true, reconciliation: (await loadReconciliation(existing.rows[0].id))[0] });
      }
    }
    res.status(500).json({ error: err.message || 'Не удалось зафиксировать остатки' });
  }
});

async function loadTransfers(kind, db = pool) {
  const result = await db.query(
    `SELECT t.id, t.from_warehouse, t.to_warehouse, t.note, t.created_by, t.created_at,
            t.reason, to_char(t.effective_date, 'YYYY-MM-DD') AS effective_date, t.cancelled_at,
            COALESCE(json_agg(json_build_object(
              'id', i.id, 'product_name', i.product_name, 'quantity', i.quantity, 'value', i.value
            ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
     FROM warehouse_transfers t
     LEFT JOIN warehouse_transfer_items i ON i.transfer_id = t.id
     WHERE t.kind = $1
     GROUP BY t.id
     ORDER BY t.created_at DESC`,
    [kind]
  );
  return result.rows;
}

router.get('/transfers', async (req, res) => {
  try {
    res.json({ transfers: await loadTransfers('transfer') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить историю перемещений' });
  }
});

router.post('/transfer', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Недостаточно прав для перемещения товара' });
  }

  const { from_warehouse: from, to_warehouse: to, note, items, idempotency_key: idempotencyKey } = req.body || {};
  if (!ALL_CITIES.includes(from) || !ALL_CITIES.includes(to) || from === to) {
    return res.status(400).json({ error: 'Выберите два разных склада' });
  }
  const normalized = normalizeTransferItems(items);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const key = idempotencyKey ? String(idempotencyKey) : null;
  const transfer = {
    from,
    to,
    note: note ? String(note) : null,
    items: normalized.items,
    createdBy: req.user.username,
    idempotencyKey: key,
  };

  try {
    await runStockChange(key, {}, (client, stock) => (
      applyTransfer(client, transfer, stock, crypto.randomUUID(), new Date().toISOString())
    ));
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof TransferError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Не удалось переместить товар' });
  }
});

// Перемещения и списания намеренно НЕ стоят в очереди enqueueKaspiSync: она занята походами в
// Kaspi, и запись ждала бы их конца минутами (2026-11-01 списание висело на "Списываем…"). Если
// обновление заказов вклинится посреди записи, доступный остаток разойдётся максимум на один заказ,
// а сама запись от этого не ломается. Друг от друга такие операции защищает блокировка в базе.
// Повтор запроса с тем же ключом не создаст вторую запись. build получает client и остаток.
async function runStockChange(idempotencyKey, options, build) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('warehouse-stock-change'))`);
    if (idempotencyKey) {
      const existing = await client.query('SELECT id FROM warehouse_transfers WHERE idempotency_key = $1', [idempotencyKey]);
      if (existing.rowCount > 0) {
        await client.query('COMMIT');
        return;
      }
    }
    await build(client, await computeWarehouseStock(client, options));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function normalizeTransferItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'Добавьте хотя бы один товар' };
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const productId = String(item.product_id || '').trim();
    const productName = String(item.product_name || productId).trim();
    const quantity = Number(item.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      return { error: `Некорректное количество: ${productName || productId}` };
    }
    if (seen.has(productId)) return { error: `Товар ${productName} добавлен дважды` };
    seen.add(productId);
    normalized.push({ productId, productName, quantity });
  }
  return { items: normalized };
}

const WRITE_OFF_REASONS = ['Бартер блогеру', 'Для контента', 'Брак', 'Другое'];

// Остатки всех складов, включая самовыкупные: списывать можно и с них, а на "Складе" их не видно.
router.get('/write-off-stock', async (req, res) => {
  try {
    const products = await computeWarehouseStock();
    res.json({
      reasons: WRITE_OFF_REASONS,
      products: products
        .filter((p) => Number(p.remaining) > 0)
        .map((p) => ({ product_id: p.product_id, product_name: p.product_name, warehouse: p.warehouse, remaining: p.remaining })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить остатки складов' });
  }
});

router.get('/write-offs', async (req, res) => {
  try {
    res.json({ writeOffs: await loadTransfers('write_off') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить историю списаний' });
  }
});

router.post('/write-off', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Недостаточно прав для списания товара' });
  }

  const { warehouse, reason, note, effective_date: effectiveDate, items, idempotency_key: idempotencyKey } = req.body || {};
  if (!ALL_CITIES.includes(warehouse)) return res.status(400).json({ error: 'Выберите склад' });
  if (!WRITE_OFF_REASONS.includes(reason)) return res.status(400).json({ error: 'Выберите причину списания' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate))) return res.status(400).json({ error: 'Укажите дату списания' });
  const normalized = normalizeTransferItems(items);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const key = idempotencyKey ? String(idempotencyKey) : null;
  const transfer = {
    kind: 'write_off',
    from: warehouse,
    to: WRITE_OFF_CITY,
    reason,
    effectiveDate,
    note: note ? String(note) : null,
    items: normalized.items,
    createdBy: req.user.username,
    idempotencyKey: key,
  };

  try {
    await runStockChange(key, {}, (client, stock) => (
      applyTransfer(client, transfer, stock, crypto.randomUUID(), new Date().toISOString())
    ));
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof TransferError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Не удалось списать товар' });
  }
});

// Отмена возвращает те же количества на склад обратным перемещением и снимает расход из отчётов.
router.post('/write-offs/:id/cancel', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Недостаточно прав для отмены списания' });
  }

  try {
    await runStockChange(null, { includeWrittenOff: true }, async (client, stock) => {
      const original = await client.query(
        `SELECT t.from_warehouse, t.cancelled_at, i.product_id, i.product_name, i.quantity
         FROM warehouse_transfers t
         JOIN warehouse_transfer_items i ON i.transfer_id = t.id
         WHERE t.id = $1 AND t.kind = 'write_off'
         FOR UPDATE OF t`,
        [req.params.id]
      );
      if (original.rowCount === 0) throw new TransferError('Списание не найдено');
      if (original.rows[0].cancelled_at) throw new TransferError('Это списание уже отменено');

      const transfer = {
        kind: 'write_off_cancel',
        from: WRITE_OFF_CITY,
        to: original.rows[0].from_warehouse,
        note: null,
        items: original.rows.map((row) => ({ productId: row.product_id, productName: row.product_name, quantity: row.quantity })),
        createdBy: req.user.username,
        idempotencyKey: null,
      };
      await applyTransfer(client, transfer, stock, crypto.randomUUID(), new Date().toISOString());
      await client.query('UPDATE warehouse_transfers SET cancelled_at = now() WHERE id = $1', [req.params.id]);
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof TransferError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Не удалось отменить списание' });
  }
});

router.get('/', async (req, res) => {
  try {
    const products = await computeWarehouseStock();
    const visibleProducts = products.filter((p) => DISPLAY_WAREHOUSES.includes(p.warehouse));
    visibleProducts.sort((a, b) => {
      const warehouseDiff = (WAREHOUSE_SORT_ORDER[a.warehouse] ?? 99) - (WAREHOUSE_SORT_ORDER[b.warehouse] ?? 99);
      if (warehouseDiff !== 0) return warehouseDiff;
      return a.product_name.localeCompare(b.product_name, 'ru');
    });

    res.json({ products: visibleProducts, cutoff_date: STOCK_CUTOFF_DATE });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось рассчитать остатки склада' });
  }
});

module.exports = router;
module.exports.computeWarehouseStock = computeWarehouseStock;
module.exports.computeInventoryValue = computeInventoryValue;
module.exports.DISPLAY_WAREHOUSES = DISPLAY_WAREHOUSES;
