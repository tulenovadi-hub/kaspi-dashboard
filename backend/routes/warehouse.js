const express = require('express');
const { pool } = require('../db');
const { STOCK_CUTOFF_DATE } = require('../constants');

const router = express.Router();

// Заказы, которые реально считаются продажей (совпадает с логикой в stats.js)
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];
const COMPLETED_STATUSES = ['COMPLETED'];
const IN_PROGRESS_STATUSES = ['ACCEPTED_BY_MERCHANT', 'APPROVED_BY_BANK'];

// На "Складе" показываем только склады с display: true в справочнике — самовыкупные
// (Юбилейное, Талдыкорган, Атырау) сюда не входят, они отслеживаются на других страницах.
const { DISPLAY_CITIES: DISPLAY_WAREHOUSES, CITY_ORDER: WAREHOUSE_SORT_ORDER } = require('../warehouseMapping');

// Считает остатки по методу FIFO отдельно для каждого склада (города):
// партии одного города списываются только продажами, отгруженными с этого же города
// (Kaspi возвращает город отгрузки в attributes.originAddress.city.name — сохраняем
// его в orders.origin_city при синхронизации).
//
// ВАЖНО: product_batches.remaining_quantity в базе НЕ уменьшается при продажах (это просто
// значение, введённое при добавлении/редактировании партии) — настоящий остаток здесь всегда
// пересчитывается заново по факту продаж, эту функцию и нужно переиспользовать всюду, где нужен
// реальный остаток (например, AI Финансист), а не читать remaining_quantity напрямую.
async function computeWarehouseStock() {
  // Партии со статусом 'in_transit' (заказаны у поставщика, физически ещё не приехали) не входят
  // в реальный остаток склада — они учитываются отдельно на "Закупе" в колонке "В пути".
  const batchesResult = await pool.query(`
    SELECT id, product_id, product_name, cost_price, warehouse, quantity, received_date
    FROM product_batches
    WHERE status = 'received'
    ORDER BY product_id, warehouse, received_date, id
  `);

  // Заказы без origin_city — это самовывоз напрямую у продавца (DELIVERY_PICKUP, не через Kaspi
  // Delivery), Kaspi не присылает по ним точку отгрузки. Владелец подтвердил, что это склад
  // "Юбилейное", который на сайте учитывать не нужно, поэтому такие заказы просто исключаем.
  const soldResult = await pool.query(
    `SELECT oi.product_id, MAX(oi.product_name) AS product_name, o.origin_city AS warehouse,
            SUM(CASE WHEN o.status = ANY($2::text[]) THEN oi.quantity ELSE 0 END) AS completed_qty,
            SUM(CASE WHEN o.status = ANY($3::text[]) THEN oi.quantity ELSE 0 END) AS in_progress_qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status = ANY($1::text[])
       AND o.origin_city IS NOT NULL
       AND o.creation_date >= $4::date
     GROUP BY oi.product_id, o.origin_city`,
    [VALID_STATUSES, COMPLETED_STATUSES, IN_PROGRESS_STATUSES, STOCK_CUTOFF_DATE]
  );
  const soldMap = new Map(
    soldResult.rows.map((r) => [
      `${r.product_id}::${r.warehouse}`,
      { completed: Number(r.completed_qty), inProgress: Number(r.in_progress_qty) },
    ])
  );
  const soldProductNames = new Map(soldResult.rows.map((r) => [r.product_id, r.product_name]));

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

  const products = [];
  for (const [key, info] of byKey) {
    const sold = soldMap.get(key) || { completed: 0, inProgress: 0 };
    // Списываем со склада и завершённые, и ещё обрабатываемые заказы — товар физически уже уехал
    // в обоих случаях, просто в разных колонках показываем для наглядности.
    let toConsume = sold.completed + sold.inProgress;
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

  // Продажи с городом, для которого вообще нет ни одной партии — это тоже важно показать,
  // иначе продажи "потеряются" молча. Добавляем их отдельными строками с нулевым остатком.
  for (const [key, sold] of soldMap) {
    const [productId, warehouse] = key.split('::');
    const alreadyListed = products.some((p) => p.product_id === productId && p.warehouse === warehouse);
    if (!alreadyListed) {
      products.push({
        product_id: productId,
        product_name: soldProductNames.get(productId) || productId,
        warehouse,
        total_supplied: 0,
        total_sold: sold.completed,
        in_progress: sold.inProgress,
        remaining: 0,
        remaining_value: 0,
        current_cost_price: null,
        oversold_qty: sold.completed + sold.inProgress,
        batches: [],
      });
    }
  }

  return products;
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
  for (const p of products) {
    stockValue += p.remaining_value;
    stockByWarehouse.set(p.warehouse, (stockByWarehouse.get(p.warehouse) || 0) + p.remaining_value);
  }

  // Считаем по ПОЛНОЙ себестоимости партии (cost_price = закупка + логистика + прочие расходы за
  // 1 шт), а закупка отдельно показывается в подписи. Сначала логистика в итог не входила, но это
  // расходилось с карточкой "На складе": там остаток тоже считается по cost_price, то есть уже с
  // логистикой. Владелец указал на это 2026-09-01 — из-за расхождения капитал был занижен
  // на 570 637 ₸. Всё, что вложено в товар, вложено в товар, когда бы оно ни было оплачено.
  // COALESCE — у партий, заведённых до появления отдельной колонки, purchase_price = cost_price.
  const transitResult = await pool.query(`
    SELECT id, product_name, warehouse, quantity, note,
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
  };
}

// Отдельный лёгкий роут: те же цифры нужны и блоку на "Складе", и плитке на Главной,
// а тащить ради них весь список товаров со склада не нужно.
router.get('/inventory-value', async (req, res) => {
  try {
    res.json(await computeInventoryValue());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось посчитать стоимость товарных остатков' });
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
module.exports.DISPLAY_WAREHOUSES = DISPLAY_WAREHOUSES;
