// syncJob.js — забирает заказы из Kaspi и сохраняет в базу данных.
// Запускается либо по расписанию (см. server.js), либо вручную: node syncJob.js

require('dotenv').config();
const { pool, initDb } = require('./db');
const { fetchOrders, fetchOrderEntries } = require('./kaspiClient');

// По умолчанию забираем заказы за последние 3 дня — так если синхронизация
// один раз не сработала (например, сервер был недоступен), данные всё равно
// подхватятся на следующий день благодаря перекрытию периодов.
async function syncRecentOrders(daysBack = 3) {
  const now = Date.now();
  const chunkDays = 10; // Kaspi не принимает периоды больше ~14 дней
  
  let cursor = now - daysBack * 24 * 60 * 60 * 1000;
  
  let totalOrders = 0;
  let totalItems = 0;

  while (cursor < now) {
    const chunkEnd = Math.min(cursor + chunkDays * 24 * 60 * 60 * 1000, now);
    
    console.log(`Синхронизация заказов с ${new Date(cursor).toISOString()} по ${new Date(chunkEnd).toISOString()}`);
    
    const orders = await fetchOrders(cursor, chunkEnd);
    console.log(`Получено заказов из Kaspi: ${orders.length}`);

    for (const order of orders) {
      const attrs = order.attributes;
      await pool.query(
        `INSERT INTO orders (id, code, creation_date, total_price, state, status, raw_data)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           total_price = EXCLUDED.total_price,
           state = EXCLUDED.state,
           status = EXCLUDED.status,
           raw_data = EXCLUDED.raw_data`,
        [order.id, attrs.code, attrs.creationDate, attrs.totalPrice, attrs.state, attrs.status, JSON.stringify(order)]
      );
      totalOrders += 1;

      const meaningfulStatuses = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];
      if (!meaningfulStatuses.includes(attrs.status)) continue;

      try {
        const entries = await fetchOrderEntries(order.id);
        for (const item of entries) {
          await pool.query(
            `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, total_price, creation_date)
             VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
             ON CONFLICT (id) DO UPDATE SET
               quantity = EXCLUDED.quantity,
               total_price = EXCLUDED.total_price,
               product_name = EXCLUDED.product_name`,
            [item.id, order.id, item.productId, item.productName, item.quantity, item.totalPrice, attrs.creationDate]
          );
          totalItems += 1;
        }
      } catch (err) {
        console.error(`Не удалось получить состав заказа ${order.id}:`, err.message);
      }
    }

    cursor = chunkEnd;
  }

  console.log(`Синхронизация завершена. Заказов сохранено: ${totalOrders}, позиций товаров: ${totalItems}`);
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

module.exports = { syncRecentOrders };
