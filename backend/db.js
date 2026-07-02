// db.js — подключение к базе данных и создание таблиц при первом запуске
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// Создаёт таблицы, если их ещё нет. Безопасно вызывать при каждом старте сервера.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,           -- уникальный ID заказа из Kaspi
      code TEXT NOT NULL,            -- номер заказа, который видит продавец
      creation_date TIMESTAMPTZ NOT NULL,
      total_price NUMERIC NOT NULL,
      state TEXT,
      status TEXT,
      raw_data JSONB                 -- сохраняем весь ответ Kaspi на случай, если понадобится что-то ещё
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,           -- уникальный ID позиции заказа из Kaspi
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT,
      product_name TEXT,
      quantity INTEGER NOT NULL,
      total_price NUMERIC NOT NULL,
      creation_date TIMESTAMPTZ NOT NULL  -- дублируем дату заказа сюда для быстрых выборок по товару
    );
  `);

  // Индексы для быстрых запросов по датам и товарам — без них при росте данных дашборд начнёт тормозить
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_creation_date ON orders(creation_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_creation_date ON order_items(creation_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_product_id ON order_items(product_id);`);

  // Партии (поставки) товара — нужны для учёта себестоимости по методу FIFO:
  // remaining_quantity уменьшается по мере продажи товара из этой партии
  // (логика списания появится позже, сейчас только ввод и хранение партий).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_batches (
      id SERIAL PRIMARY KEY,
      product_id TEXT NOT NULL,
      product_name TEXT,
      cost_price NUMERIC NOT NULL,
      quantity INTEGER NOT NULL,
      remaining_quantity INTEGER NOT NULL,
      received_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_product_id ON product_batches(product_id, received_date);`);

  // Миграция: раскладываем себестоимость на закупочную цену + логистику, добавляем примечание.
  // Для уже существующих партий закупочная цена = старая себестоимость, логистика = 0.
  await pool.query(`ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS purchase_price NUMERIC;`);
  await pool.query(`ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS logistics_cost NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS note TEXT;`);
  await pool.query(`UPDATE product_batches SET purchase_price = cost_price WHERE purchase_price IS NULL;`);

  // Данные, импортированные из Excel-отчёта Kaspi Pay (детализация по операциям):
  // выручка, все виды комиссий и стоимость доставки Kaspi по каждой операции.
  // Используется для отчёта по прибыли/марже/ROI помесячно.
  // Миграция: если таблица создана по старой схеме (уникальный order_number, без row_key),
  // в ней могли потеряться строки из-за бага с перезаписью по номеру заказа
  // (у одного заказа бывает несколько операций — например, покупка и её возврат).
  // Пересоздаём таблицу начисто — после этого нужно перезалить Excel-отчёт на странице "Отчёт".
  const rowKeyCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'kaspi_pay_transactions' AND column_name = 'row_key'
  `);
  if (rowKeyCheck.rowCount === 0) {
    await pool.query(`DROP TABLE IF EXISTS kaspi_pay_transactions;`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kaspi_pay_transactions (
      id SERIAL PRIMARY KEY,
      row_key TEXT UNIQUE NOT NULL,
      order_number TEXT NOT NULL,
      operation_date DATE NOT NULL,
      operation_type TEXT,
      product_name TEXT,
      amount NUMERIC NOT NULL DEFAULT 0,
      commission_total NUMERIC NOT NULL DEFAULT 0,
      delivery_cost NUMERIC NOT NULL DEFAULT 0,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kaspi_pay_date ON kaspi_pay_transactions(operation_date);`);

  console.log('База данных готова: таблицы orders, order_items, product_batches и kaspi_pay_transactions на месте.');
}

module.exports = { pool, initDb };
