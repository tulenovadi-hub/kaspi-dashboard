const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../db');

const router = express.Router();

const { ALL_CITIES: VALID_WAREHOUSES } = require('../warehouseMapping');
const VALID_STATUSES = ['in_transit', 'received'];
const VALID_CURRENCIES = ['KZT', 'USD', 'CNY'];

// Справочные поля курса валюты — необязательные, поэтому пустое/некорректное значение
// просто превращается в null, а не в ошибку валидации всей поставки.
function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Прочие расходы на партию (сертификаты, НДС, растаможка и т.п.) — произвольный список,
// названия придумывает пользователь. Приводим к чистому виду: выкидываем строки без
// названия или без суммы, отрезаем слишком длинные названия, валюту берём только из
// известного списка. Ошибку не кидаем: это необязательная часть формы, и одна кривая
// строка не должна мешать сохранить всю поставку.
const MAX_EXPENSE_NAME_LENGTH = 60;
// Артикул (product_id) — это offer.code из заказа Kaspi, ключ, по которому партия связывается
// с продажами при FIFO-списании. Название — только для отображения.
const MAX_PRODUCT_ID_LENGTH = 100;
const MAX_PRODUCT_NAME_LENGTH = 200;
const MAX_EXTRA_EXPENSES = 20;
const MAX_ALLOCATIONS = VALID_WAREHOUSES.length;

function normalizeExtraExpenses(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = String(item.name || '').trim().slice(0, MAX_EXPENSE_NAME_LENGTH);
      const amount = optionalNumber(item.amount);
      if (!name || amount === null || amount < 0) return null;
      const currency = VALID_CURRENCIES.includes(item.currency) ? item.currency : 'KZT';
      // Для тенге курс всегда 1, для остальных валют — что указали (по умолчанию тоже 1,
      // чтобы сумма не превратилась в ноль, если курс забыли заполнить).
      const rate = currency === 'KZT' ? 1 : (optionalNumber(item.rate) || 1);
      return { name, amount, currency, rate };
    })
    .filter(Boolean)
    .slice(0, MAX_EXTRA_EXPENSES);
}

// Прочие расходы указываются суммой за ВСЮ партию, а cost_price — за 1 шт,
// поэтому делим на количество (как закупку и логистику на фронтенде).
function extraExpensesPerUnit(expenses, qty) {
  if (!qty) return 0;
  const totalKzt = expenses.reduce((sum, e) => sum + e.amount * e.rate, 0);
  return totalKzt / qty;
}

// Одна поставка может быть сразу распределена между несколькими городами. В складских
// формулах одна строка product_batches по-прежнему означает один товар на одном складе,
// поэтому POST/PUT создают по строке на город, но делают это одной транзакцией. Старый формат
// warehouse + quantity оставляем рабочим для уже закэшированного фронтенда.
function normalizeAllocations(value, fallbackWarehouse, fallbackQuantity) {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : [{ warehouse: fallbackWarehouse, quantity: fallbackQuantity }];

  if (source.length > MAX_ALLOCATIONS) {
    return { error: 'В поставке указано слишком много городов' };
  }

  const seen = new Set();
  const allocations = [];
  for (const item of source) {
    const warehouse = String(item?.warehouse || '').trim();
    const quantity = Number(item?.quantity);
    if (!VALID_WAREHOUSES.includes(warehouse)) {
      return { error: 'Не указан склад (город)' };
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { error: `Количество для города «${warehouse}» должно быть целым числом больше нуля` };
    }
    if (seen.has(warehouse)) {
      return { error: `Город «${warehouse}» указан в поставке дважды` };
    }
    seen.add(warehouse);
    const rowId = Number(item?.id);
    allocations.push({
      id: Number.isInteger(rowId) && rowId > 0 ? rowId : null,
      warehouse,
      quantity,
    });
  }

  return {
    allocations,
    totalQuantity: allocations.reduce((sum, item) => sum + item.quantity, 0),
  };
}

function sumOptional(rows, field) {
  const values = rows.map((row) => optionalNumber(row[field])).filter((value) => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function weightedValue(rows, field) {
  const totalQuantity = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  if (!totalQuantity) return Number(rows[0]?.[field] || 0);
  return rows.reduce(
    (sum, row) => sum + Number(row[field] || 0) * Number(row.quantity || 0),
    0
  ) / totalQuantity;
}

function combineExtraExpenses(rows) {
  const combined = new Map();
  for (const row of rows) {
    const expenses = Array.isArray(row.extra_expenses) ? row.extra_expenses : [];
    for (const expense of expenses) {
      const key = `${expense.name}\u0000${expense.currency}\u0000${expense.rate}`;
      const current = combined.get(key) || { ...expense, amount: 0 };
      current.amount += Number(expense.amount || 0);
      combined.set(key, current);
    }
  }
  return [...combined.values()];
}

// Собирает городские строки обратно в одну запись для интерфейса. Финансовые суммы,
// распределённые по строкам пропорционально количеству, здесь складываются обратно.
function groupBatchRows(rows) {
  if (!rows.length) return null;
  const sorted = rows.slice().sort((a, b) => Number(a.id) - Number(b.id));
  const first = sorted[0];
  const warehouses = [...new Set(sorted.map((row) => row.warehouse))];
  return {
    ...first,
    id: Number(first.id),
    supply_group_id: first.supply_group_id,
    cost_price: weightedValue(sorted, 'cost_price'),
    purchase_price: weightedValue(sorted, 'purchase_price'),
    logistics_cost: weightedValue(sorted, 'logistics_cost'),
    quantity: sorted.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    remaining_quantity: sorted.reduce((sum, row) => sum + Number(row.remaining_quantity || 0), 0),
    purchase_amount_foreign: sumOptional(sorted, 'purchase_amount_foreign'),
    logistics_amount_foreign: sumOptional(sorted, 'logistics_amount_foreign'),
    extra_expenses: combineExtraExpenses(sorted),
    warehouse: warehouses[0],
    warehouses,
    allocations: sorted.map((row) => ({
      id: Number(row.id),
      warehouse: row.warehouse,
      quantity: Number(row.quantity),
      remaining_quantity: Number(row.remaining_quantity),
    })),
  };
}

function proportionalValue(value, quantity, totalQuantity) {
  return value === null ? null : value * quantity / totalQuantity;
}

function proportionalExpenses(expenses, quantity, totalQuantity) {
  return expenses.map((expense) => ({
    ...expense,
    amount: expense.amount * quantity / totalQuantity,
  }));
}

// Список товаров для выпадающего списка при добавлении партии — чтобы не вводить название
// руками и не ошибиться в артикуле. Источников два:
//   1) order_items — всё, что когда-либо продавалось (приходит из API Kaspi при синхронизации);
//   2) product_batches — товары, добавленные вручную на "Поставках".
// Второй источник нужен для НОВОГО товара: карточка на Kaspi уже создана, товар едет, но
// продаж ещё не было — значит в order_items его нет и в списке он бы не появился. Один раз
// введя его вручную, дальше его можно выбирать из списка как обычно.
// from_sales показывает, есть ли по товару реальные продажи: у введённого вручную артикула
// это false, и на фронтенде рядом с ним видна пометка — если артикул набран с ошибкой,
// продажи к нему никогда не привяжутся, и такая пометка останется навсегда.
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query(
      `WITH all_products AS (
         SELECT product_id, product_name, true AS from_sales
         FROM order_items
         WHERE product_id IS NOT NULL
         UNION ALL
         SELECT product_id, product_name, false
         FROM product_batches
         WHERE product_id IS NOT NULL
       )
       SELECT product_id,
              -- если товар есть и в продажах, и в поставках, показываем название из продаж:
              -- оно приходит от Kaspi и всегда актуальнее того, что набрали руками
              (array_agg(product_name ORDER BY from_sales DESC))[1] AS product_name,
              bool_or(from_sales) AS from_sales
       FROM all_products
       GROUP BY product_id
       ORDER BY product_name`
    );
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список товаров' });
  }
});

// Список всех партий, сгруппированных по товару, отсортированных по дате поступления (FIFO-порядок)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
              purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses,
              COALESCE(supply_group_id, 'batch-' || id) AS supply_group_id
       FROM product_batches
       ORDER BY product_name, received_date, id`
    );
    const groups = new Map();
    for (const row of result.rows) {
      const groupId = row.supply_group_id || `batch-${row.id}`;
      if (!groups.has(groupId)) groups.set(groupId, []);
      groups.get(groupId).push(row);
    }
    const batches = [...groups.values()].map(groupBatchRows);
    // Список складов отдаём вместе с партиями, чтобы фронтенду не приходилось держать
    // собственную копию — источник правды один, backend/warehouseMapping.js.
    res.json({ batches, warehouses: VALID_WAREHOUSES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список партий' });
  }
});

// Добавление новой партии
router.post('/', async (req, res) => {
  const {
    product_id, product_name, purchase_price, logistics_cost, note, warehouse, quantity, received_date, status,
    purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate,
    extra_expenses, allocations: requestedAllocations, declared_quantity,
  } = req.body;

  // product_id/product_name могут прийти как из выпадающего списка, так и набранными вручную
  // (новый товар, которого ещё не было в продажах), поэтому чистим и ограничиваем длину.
  const productId = String(product_id || '').trim().slice(0, MAX_PRODUCT_ID_LENGTH);
  const productName = String(product_name || '').trim().slice(0, MAX_PRODUCT_NAME_LENGTH);
  if (!productId || !productName) {
    return res.status(400).json({ error: 'Не указан товар' });
  }
  const normalizedAllocations = normalizeAllocations(requestedAllocations, warehouse, quantity);
  if (normalizedAllocations.error) {
    return res.status(400).json({ error: normalizedAllocations.error });
  }
  const { allocations, totalQuantity: allocatedQuantity } = normalizedAllocations;
  const qty = Number(declared_quantity ?? quantity ?? allocatedQuantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Общее количество должно быть целым числом больше нуля' });
  }
  if (allocatedQuantity !== qty) {
    return res.status(400).json({
      error: `По городам распределено ${allocatedQuantity} шт., а заявлено всего ${qty} шт.`,
    });
  }
  const purchasePrice = Number(purchase_price);
  const logisticsCost = Number(logistics_cost || 0);
  const batchStatus = VALID_STATUSES.includes(status) ? status : 'received';
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
    return res.status(400).json({ error: 'Закупочная цена указана некорректно' });
  }
  if (!Number.isFinite(logisticsCost) || logisticsCost < 0) {
    return res.status(400).json({ error: 'Логистика указана некорректно' });
  }
  if (!received_date || !/^\d{4}-\d{2}-\d{2}$/.test(received_date)) {
    return res.status(400).json({ error: 'Дата поступления указана некорректно' });
  }

  const extraExpenses = normalizeExtraExpenses(extra_expenses);
  // Прочие расходы входят в себестоимость наравне с закупкой и логистикой — значит
  // автоматически учитываются в FIFO-списании, оценке склада и расчёте прибыли.
  const costPrice = purchasePrice + logisticsCost + extraExpensesPerUnit(extraExpenses, qty);
  const purchaseCurrency = VALID_CURRENCIES.includes(purchase_currency) ? purchase_currency : null;
  const purchaseAmountForeign = optionalNumber(purchase_amount_foreign);
  const purchaseRate = optionalNumber(purchase_rate);
  const logisticsCurrency = VALID_CURRENCIES.includes(logistics_currency) ? logistics_currency : null;
  const logisticsAmountForeign = optionalNumber(logistics_amount_foreign);
  const logisticsRate = optionalNumber(logistics_rate);

  const client = await pool.connect().catch((err) => {
    console.error(err);
    return null;
  });
  if (!client) return res.status(500).json({ error: 'Не удалось добавить партию' });

  try {
    await client.query('BEGIN');
    const batches = [];
    const supplyGroupId = randomUUID();
    for (const allocation of allocations) {
      // Справочные суммы в валюте и статьи расходов заданы за всю поставку. Храним в
      // городской строке только её долю: тогда открытие/редактирование строки не покажет
      // полную сумму повторно и общая стоимость не задвоится.
      const rowPurchaseAmount = proportionalValue(purchaseAmountForeign, allocation.quantity, qty);
      const rowLogisticsAmount = proportionalValue(logisticsAmountForeign, allocation.quantity, qty);
      const rowExpenses = proportionalExpenses(extraExpenses, allocation.quantity, qty);
      const result = await client.query(
        `INSERT INTO product_batches (product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status,
                                       purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses, supply_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
                   purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses, supply_group_id`,
        [productId, productName, costPrice, purchasePrice, logisticsCost, note || null,
          allocation.warehouse, allocation.quantity, received_date, batchStatus,
          purchaseCurrency, rowPurchaseAmount, purchaseRate, logisticsCurrency, rowLogisticsAmount, logisticsRate,
          JSON.stringify(rowExpenses), supplyGroupId]
      );
      batches.push(result.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ batch: groupBatchRows(batches), rows: batches });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Не удалось добавить партию' });
  } finally {
    client.release();
  }
});

// Редактирование существующей поставки целиком. Связанные городские строки загружаются и
// сохраняются одной транзакцией; уже проданные единицы при этом не возвращаются в остаток.
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    warehouse, purchase_price, logistics_cost, note, quantity, received_date, status,
    purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate,
    extra_expenses, allocations: requestedAllocations, declared_quantity,
  } = req.body;

  const normalizedAllocations = normalizeAllocations(requestedAllocations, warehouse, quantity);
  if (normalizedAllocations.error) {
    return res.status(400).json({ error: normalizedAllocations.error });
  }
  const { allocations, totalQuantity: allocatedQuantity } = normalizedAllocations;
  const qty = Number(declared_quantity ?? quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Общее количество должно быть целым числом больше нуля' });
  }
  if (allocatedQuantity !== qty) {
    return res.status(400).json({
      error: `По городам распределено ${allocatedQuantity} шт., а заявлено всего ${qty} шт.`,
    });
  }
  const purchasePrice = Number(purchase_price);
  const logisticsCost = Number(logistics_cost || 0);
  const batchStatus = VALID_STATUSES.includes(status) ? status : 'received';
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
    return res.status(400).json({ error: 'Закупочная цена указана некорректно' });
  }
  if (!Number.isFinite(logisticsCost) || logisticsCost < 0) {
    return res.status(400).json({ error: 'Логистика указана некорректно' });
  }
  if (!received_date || !/^\d{4}-\d{2}-\d{2}$/.test(received_date)) {
    return res.status(400).json({ error: 'Дата поступления указана некорректно' });
  }

  const extraExpenses = normalizeExtraExpenses(extra_expenses);
  // Прочие расходы входят в себестоимость наравне с закупкой и логистикой — значит
  // автоматически учитываются в FIFO-списании, оценке склада и расчёте прибыли.
  const costPrice = purchasePrice + logisticsCost + extraExpensesPerUnit(extraExpenses, qty);
  const purchaseCurrency = VALID_CURRENCIES.includes(purchase_currency) ? purchase_currency : null;
  const purchaseAmountForeign = optionalNumber(purchase_amount_foreign);
  const purchaseRate = optionalNumber(purchase_rate);
  const logisticsCurrency = VALID_CURRENCIES.includes(logistics_currency) ? logistics_currency : null;
  const logisticsAmountForeign = optionalNumber(logistics_amount_foreign);
  const logisticsRate = optionalNumber(logistics_rate);

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Не удалось сохранить изменения' });
  }

  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT pb.id, pb.product_id, pb.product_name, pb.quantity, pb.remaining_quantity,
              COALESCE(pb.supply_group_id, 'batch-' || pb.id) AS supply_group_id
       FROM product_batches pb
       WHERE COALESCE(pb.supply_group_id, 'batch-' || pb.id) = (
         SELECT COALESCE(anchor.supply_group_id, 'batch-' || anchor.id)
         FROM product_batches anchor
         WHERE anchor.id = $1
       )
       ORDER BY pb.id
       FOR UPDATE`,
      [id]
    );
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Партия не найдена' });
    }
    if (existing.rows.length > 1 && declared_quantity === undefined) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Поставка содержит несколько городов. Обновите страницу и откройте её заново' });
    }
    const oldQuantity = existing.rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    const oldRemaining = existing.rows.reduce((sum, row) => sum + Number(row.remaining_quantity), 0);
    // Уже проданные единицы не должны внезапно вернуться в остаток после разделения.
    // Сначала относим их к первой строке (исходной партии), затем — к следующим,
    // если количество первой строки оказалось меньше уже проданного количества.
    let soldToDistribute = Math.max(0, oldQuantity - oldRemaining);
    const allocationsWithRemaining = allocations.map((allocation) => {
      const soldFromRow = Math.min(allocation.quantity, soldToDistribute);
      soldToDistribute -= soldFromRow;
      return { ...allocation, remainingQuantity: allocation.quantity - soldFromRow };
    });
    const anchor = existing.rows.find((row) => Number(row.id) === Number(id)) || existing.rows[0];
    const supplyGroupId = anchor.supply_group_id || `batch-${anchor.id}`;
    const existingById = new Map(existing.rows.map((row) => [Number(row.id), row]));
    const usedIds = new Set();

    for (let index = 0; index < allocationsWithRemaining.length; index += 1) {
      const allocation = allocationsWithRemaining[index];
      const rowPurchaseAmount = proportionalValue(purchaseAmountForeign, allocation.quantity, qty);
      const rowLogisticsAmount = proportionalValue(logisticsAmountForeign, allocation.quantity, qty);
      const rowExpenses = proportionalExpenses(extraExpenses, allocation.quantity, qty);
      let target = null;
      if (index === 0) {
        target = anchor;
      } else if (allocation.id && existingById.has(allocation.id) && !usedIds.has(allocation.id)) {
        target = existingById.get(allocation.id);
      } else {
        target = existing.rows.find((row) => !usedIds.has(Number(row.id)) && Number(row.id) !== Number(anchor.id)) || null;
      }

      if (target) {
        usedIds.add(Number(target.id));
        await client.query(
          `UPDATE product_batches
           SET cost_price = $1, purchase_price = $2, logistics_cost = $3, note = $4, warehouse = $5,
               quantity = $6, remaining_quantity = $7, received_date = $8, status = $9,
               purchase_currency = $10, purchase_amount_foreign = $11, purchase_rate = $12,
               logistics_currency = $13, logistics_amount_foreign = $14, logistics_rate = $15,
               extra_expenses = $16, supply_group_id = $17
           WHERE id = $18`,
          [costPrice, purchasePrice, logisticsCost, note || null, allocation.warehouse, allocation.quantity,
            allocation.remainingQuantity, received_date, batchStatus, purchaseCurrency, rowPurchaseAmount, purchaseRate,
            logisticsCurrency, rowLogisticsAmount, logisticsRate, JSON.stringify(rowExpenses), supplyGroupId, target.id]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO product_batches
           (product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status,
            purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses, supply_group_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING id`,
          [anchor.product_id, anchor.product_name, costPrice, purchasePrice, logisticsCost,
            note || null, allocation.warehouse, allocation.quantity, allocation.remainingQuantity, received_date, batchStatus,
            purchaseCurrency, rowPurchaseAmount, purchaseRate, logisticsCurrency, rowLogisticsAmount, logisticsRate,
            JSON.stringify(rowExpenses), supplyGroupId]
        );
        usedIds.add(Number(inserted.rows[0].id));
      }
    }

    const obsoleteIds = existing.rows
      .map((row) => Number(row.id))
      .filter((rowId) => !usedIds.has(rowId));
    if (obsoleteIds.length > 0) {
      await client.query(`DELETE FROM product_batches WHERE id = ANY($1::int[])`, [obsoleteIds]);
    }

    const saved = await client.query(
      `SELECT id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
              purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses, supply_group_id
       FROM product_batches
       WHERE supply_group_id = $1
       ORDER BY id`,
      [supplyGroupId]
    );
    await client.query('COMMIT');
    res.json({ batch: groupBatchRows(saved.rows), rows: saved.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить изменения' });
  } finally {
    client.release();
  }
});

// Быстрая отметка "Прибыло" (для партий со статусом in_transit) — переводит статус в received
// и проставляет фактическую дату поступления = сегодня (до этого там была ожидаемая дата).
router.post('/:id/receive', async (req, res) => {
  const { id } = req.params;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      `WITH target AS (
         SELECT COALESCE(supply_group_id, 'batch-' || id) AS group_id
         FROM product_batches WHERE id = $2
       )
       UPDATE product_batches
       SET status = 'received', received_date = $1
       WHERE COALESCE(supply_group_id, 'batch-' || id) = (SELECT group_id FROM target)
       RETURNING id, product_id, product_name, cost_price, purchase_price, logistics_cost, note, warehouse, quantity, remaining_quantity, received_date, status, created_at,
                 purchase_currency, purchase_amount_foreign, purchase_rate, logistics_currency, logistics_amount_foreign, logistics_rate, extra_expenses, supply_group_id`,
      [today, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Партия не найдена' });
    }
    res.json({ batch: groupBatchRows(result.rows), rows: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось отметить поставку как прибывшую' });
  }
});

// Удаление партии (на случай, если ввели по ошибке)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `WITH target AS (
         SELECT COALESCE(supply_group_id, 'batch-' || id) AS group_id
         FROM product_batches WHERE id = $1
       )
       DELETE FROM product_batches
       WHERE COALESCE(supply_group_id, 'batch-' || id) = (SELECT group_id FROM target)
       RETURNING id`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Партия не найдена' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить партию' });
  }
});

module.exports = router;
