// syncJob.js — забирает заказы из Kaspi и сохраняет в базу данных.
// Запускается либо по расписанию (см. server.js), либо вручную: node syncJob.js

require('dotenv').config();
const { pool, initDb } = require('./db');
const { fetchOrders, fetchOrderEntries, fetchOrdersByStatus } = require('./kaspiClient');
const { resolveWarehouse } = require('./warehouseMapping');
const { STOCK_CUTOFF_DATE } = require('./constants');

const CUSTOMER_RETURN_STATUSES = ['KASPI_DELIVERY_RETURN_REQUESTED', 'RETURNED'];
const MEANINGFUL_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK', ...CUSTOMER_RETURN_STATUSES];
const ORDER_STATES = ['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'];

function hasCompletedEvidence(attrs) {
  return attrs.status === 'COMPLETED' || (attrs.completionDate !== null && attrs.completionDate !== undefined);
}

// Сохраняет уже полученный список заказов. Для частой live-синхронизации состав повторно
// запрашиваем только у нового заказа (или если он почему-то остался без позиций). Полная
// синхронизация сохраняет прежнее поведение и перечитывает состав всех заказов в окне.
async function saveOrders(orders, { onlyMissingEntries = false } = {}) {
  const ids = orders.map((order) => order.id);
  let existingIds = new Set();
  let ordersWithItems = new Set();

  if (ids.length > 0) {
    const [existingResult, itemsResult] = await Promise.all([
      pool.query(`SELECT id FROM orders WHERE id = ANY($1::text[])`, [ids]),
      onlyMissingEntries
        ? pool.query(`SELECT DISTINCT order_id FROM order_items WHERE order_id = ANY($1::text[])`, [ids])
        : Promise.resolve({ rows: [] }),
    ]);
    existingIds = new Set(existingResult.rows.map((row) => row.id));
    ordersWithItems = new Set(itemsResult.rows.map((row) => row.order_id));
  }

  let totalItems = 0;
  let newOrders = 0;
  const customerReturnCodes = [];

  for (const order of orders) {
    const attrs = order.attributes;
    const isNew = !existingIds.has(order.id);
    if (isNew) newOrders += 1;
    const completedEvidence = hasCompletedEvidence(attrs);
    if (CUSTOMER_RETURN_STATUSES.includes(attrs.status) && attrs.code) customerReturnCodes.push(String(attrs.code));

    const originCity = resolveWarehouse(attrs.pickupPointId);
    await pool.query(
      `INSERT INTO orders (id, code, creation_date, total_price, state, status, raw_data, origin_city, pickup_point_id, was_completed)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         total_price = EXCLUDED.total_price,
         state = EXCLUDED.state,
         status = EXCLUDED.status,
         raw_data = EXCLUDED.raw_data,
         origin_city = EXCLUDED.origin_city,
         pickup_point_id = EXCLUDED.pickup_point_id,
         was_completed = orders.was_completed OR EXCLUDED.was_completed`,
      [order.id, attrs.code, attrs.creationDate, attrs.totalPrice, attrs.state, attrs.status, JSON.stringify(order), originCity, attrs.pickupPointId || null, completedEvidence]
    );

    if (!MEANINGFUL_STATUSES.includes(attrs.status)) continue;
    if (onlyMissingEntries && !isNew && ordersWithItems.has(order.id)) continue;

    try {
      const entries = await fetchOrderEntries(order.id);
      for (const item of entries) {
        await pool.query(
          `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, total_price, creation_date, master_product_code)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8)
           ON CONFLICT (id) DO UPDATE SET
             quantity = EXCLUDED.quantity,
             total_price = EXCLUDED.total_price,
             product_name = EXCLUDED.product_name,
             master_product_code = EXCLUDED.master_product_code`,
          [item.id, order.id, item.productId, item.productName, item.quantity, item.totalPrice, attrs.creationDate, item.masterProductCode]
        );
        totalItems += 1;
      }
    } catch (err) {
      console.error(`Не удалось получить состав заказа ${order.id}:`, err.message);
    }
  }

  // RETURNED сам по себе двусмысленен: это может быть обычный возврат после выдачи либо
  // трекинг отмены при доставке. Одним запросом закрепляем was_completed только за теми
  // возвратами, которых нет в отдельном реестре delivery_cancellations.
  if (customerReturnCodes.length > 0) {
    await pool.query(
      `UPDATE orders o
       SET was_completed = true
       WHERE o.code = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM delivery_cancellations dc WHERE dc.order_number = o.code
         )`,
      [[...new Set(customerReturnCodes)]]
    );
  }

  return { orders: orders.length, items: totalItems, new_orders: newOrders };
}

// По умолчанию забираем заказы за последние 3 дня — так если синхронизация
// один раз не сработала (например, сервер был недоступен), данные всё равно
// подхватятся на следующий день благодаря перекрытию периодов.
async function syncRecentOrders(daysBack = 3) {
  const now = Date.now();
  const chunkDays = 10; // Kaspi не принимает периоды больше ~14 дней
  
  let cursor = now - daysBack * 24 * 60 * 60 * 1000;
  
  let totalOrders = 0;
  let totalItems = 0;
  let newOrders = 0;

  while (cursor < now) {
    const chunkEnd = Math.min(cursor + chunkDays * 24 * 60 * 60 * 1000, now);
    
    console.log(`Синхронизация заказов с ${new Date(cursor).toISOString()} по ${new Date(chunkEnd).toISOString()}`);
    
    const orders = await fetchOrders(cursor, chunkEnd);
    console.log(`Получено заказов из Kaspi: ${orders.length}`);

    const saved = await saveOrders(orders);
    totalOrders += saved.orders;
    totalItems += saved.items;
    newOrders += saved.new_orders;

    cursor = chunkEnd;
  }

  console.log(`Синхронизация завершена. Заказов сохранено: ${totalOrders}, позиций товаров: ${totalItems}`);
  // Итог нужен кнопке "Сверить с Kaspi" на Главной: она ждёт окончания и показывает, сколько
  // заказов приехало. Остальные вызовы (крон, запуск файла руками) результат просто игнорируют.
  return { orders: totalOrders, items: totalItems, new_orders: newOrders };
}

// Лёгкая синхронизация для запуска раз в минуту с Oracle. Десятиминутное окно даёт большой
// запас на временный сбой сети, но состав уже известных заказов повторно не скачивается.
// Статусы попавших в это короткое окно всё равно обновляются через UPSERT выше.
async function syncLatestOrders(minutesBack = 10) {
  const safeMinutes = Math.max(2, Math.min(60, Number(minutesBack) || 10));
  const now = Date.now();
  const dateFrom = now - safeMinutes * 60 * 1000;
  console.log(`Live-синхронизация заказов за последние ${safeMinutes} мин.`);
  const orders = await fetchOrders(dateFrom, now);
  const result = await saveOrders(orders, { onlyMissingEntries: true });
  console.log(`Live-синхронизация завершена. Найдено: ${result.orders}, новых: ${result.new_orders}`);
  return result;
}

// Раз в 10 минут повторно читаем заказы за последние сутки. Так обновляются не только новые
// заказы, но и более поздние изменения уже известных: отмена, завершение и другие статусы.
// Состав заказа повторно скачивается только если заказ новый или позиции ещё не сохранены.
async function syncOrderStatuses(hoursBack = 24) {
  const safeHours = Math.max(1, Math.min(72, Number(hoursBack) || 24));
  const now = Date.now();
  const dateFrom = now - safeHours * 60 * 60 * 1000;
  console.log(`Сверка статусов заказов за последние ${safeHours} ч.`);
  const orders = await fetchOrders(dateFrom, now);
  const result = await saveOrders(orders, { onlyMissingEntries: true });
  console.log(`Сверка статусов завершена. Проверено: ${result.orders}, новых: ${result.new_orders}`);
  return result;
}

// Покупательский возврат оформляется уже после выдачи заказа, часто спустя несколько дней.
// Обычная сверка статусов смотрит только заказы, СОЗДАННЫЕ за последние сутки, поэтому такой
// переход в ожидание/завершение возврата могла никогда не увидеть. Отдельно ищем оба статуса
// покупательского возврата с даты складского снимка и сохраняем их в ту же таблицу orders.
//
// Это не означает возврат товара в доступный остаток: warehouse.js, наоборот, продолжает
// списывать оба статуса. Здесь мы только делаем историю полной и однозначной.
async function fetchCustomerReturnsByStatus(status, dateFrom, dateTo) {
  try {
    // Тот же быстрый путь, что уже используется поиском отмен: один статус сразу во всех
    // состояниях заказа. Так мы не угадываем, в каком state Kaspi держит ожидающий возврат.
    return await fetchOrdersByStatus(null, status, dateFrom, dateTo);
  } catch (err) {
    // Запасной путь для варианта API, который требует state. Состояния идем последовательно,
    // чтобы шесть широких исторических запросов не создавали всплеск параллельной нагрузки.
    console.error(`Поиск ${status} без состояния не прошёл, перебираем состояния:`, err.message);
    const orders = [];
    for (const state of ORDER_STATES) {
      const found = await fetchOrdersByStatus(state, status, dateFrom, dateTo).catch(() => []);
      orders.push(...found);
    }
    return orders;
  }
}

async function syncReturnedOrders() {
  const dateFrom = new Date(`${STOCK_CUTOFF_DATE}T00:00:00.000Z`).getTime();
  const dateTo = Date.now();
  console.log(`Сверка покупательских возвратов с ${STOCK_CUTOFF_DATE}.`);
  const byId = new Map();
  for (const status of CUSTOMER_RETURN_STATUSES) {
    const orders = await fetchCustomerReturnsByStatus(status, dateFrom, dateTo);
    for (const order of orders) byId.set(order.id, order);
  }
  const result = await saveOrders([...byId.values()], { onlyMissingEntries: true });
  console.log(`Сверка возвратов завершена. Найдено: ${result.orders}.`);
  return result;
}

// Если файл запущен напрямую (node syncJob.js), а не подключён как модуль — выполняем синхронизацию сразу
async function syncHistorical(daysBack = 60) {
  const dateTo = Date.now();
  const dateFrom = dateTo - daysBack * 24 * 60 * 60 * 1000;
  console.log(`Историческая синхронизация за ${daysBack} дней...`);
  const { fetchOrders, fetchOrderEntries } = require('./kaspiClient');
  const orders = await fetchOrders(dateFrom, dateTo);
  console.log(`Получено заказов: ${orders.length}`);
  // используем ту же логику что и syncRecentOrders
  await syncRecentOrders(daysBack);
}

if (require.main === module) {
  initDb()
    .then(() => syncRecentOrders(60))
    .then(() => pool.end())
    .catch((err) => {
      console.error('Ошибка синхронизации:', err);
      process.exit(1);
    });
}

module.exports = { syncRecentOrders, syncLatestOrders, syncOrderStatuses, syncReturnedOrders, hasCompletedEvidence };
