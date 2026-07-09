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

  // Город склада, с которого реально отгружен заказ. Раньше брали из attributes.originAddress.city.name,
  // но это поле пустое для заказов без Kaspi Delivery (самовывоз). Понадёжнее — attributes.pickupPointId,
  // он есть у ЛЮБОГО заказа всегда, просто это код точки (например "18619047_PP2"), а не название города —
  // сопоставляем через справочник warehouseMapping.js.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS origin_city TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_point_id TEXT;`);
  await pool.query(`UPDATE orders SET pickup_point_id = raw_data->'attributes'->>'pickupPointId' WHERE raw_data IS NOT NULL;`);

  const { PICKUP_POINT_WAREHOUSE_MAP } = require('./warehouseMapping');
  const mappingEntries = Object.entries(PICKUP_POINT_WAREHOUSE_MAP);
  if (mappingEntries.length > 0) {
    const caseSql = mappingEntries.map(([id, city]) => `WHEN '${id}' THEN '${city}'`).join(' ');
    await pool.query(`
      UPDATE orders
      SET origin_city = CASE pickup_point_id ${caseSql} ELSE NULL END
      WHERE raw_data IS NOT NULL
    `);
  }

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

  // Склад (город), на который пришла партия — Алматы или Астана.
  // Для партий, добавленных до этой миграции, считаем, что это Алматы (можно поправить вручную).
  await pool.query(`ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS warehouse TEXT NOT NULL DEFAULT 'Алматы';`);

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

  // Код товара в общем каталоге Kaspi (не путать с product_id — это код именно вашего
  // предложения). Нужен, чтобы построить ссылку на публичную страницу товара и вытащить оттуда картинку.
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS master_product_code TEXT;`);

  // Кэш картинок товаров — чтобы не дёргать kaspi.kz при каждой загрузке страницы "Склад".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_images (
      product_id TEXT PRIMARY KEY,
      master_product_code TEXT,
      image_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // is_manual = true — картинку загрузили вручную на странице "Склад". Такие картинки
  // никогда не перезаписываются автоматическим скрейпингом с kaspi.kz (в отличие от обычного
  // кэша, у которого раз в 30 дней проверяется свежесть).
  await pool.query(`ALTER TABLE product_images ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false;`);

  // Расходы, синхронизируемые из гугл-таблицы (лист "Расход"). При каждой синхронизации
  // таблица полностью перезаписывается свежими данными из Google Sheets — так проще и надёжнее,
  // чем пытаться сопоставлять строки, если в таблице что-то поменяли местами или удалили.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      expense_date DATE,
      name TEXT,
      category TEXT,
      source TEXT,
      amount NUMERIC NOT NULL DEFAULT 0,
      comment TEXT,
      row_index INTEGER,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);`);

  // Расходы на рекламу (сервис "Маркетинг" в Kaspi Pay) — по дням и по конкретным рекламным
  // кампаниям (кампания = один товар). Официального API для этого нет, данные заливаются либо
  // вручную, либо через пользовательский скрипт (Tampermonkey), который дёргает внутренний,
  // недокументированный эндпоинт marketing.kaspi.kz от имени залогиненного пользователя в браузере.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_expenses (
      id SERIAL PRIMARY KEY,
      expense_date DATE NOT NULL,
      campaign_id TEXT NOT NULL,
      campaign_name TEXT,
      cost NUMERIC NOT NULL DEFAULT 0,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (expense_date, campaign_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ad_expenses_date ON ad_expenses(expense_date);`);

  // Привязка рекламной кампании к конкретным товарам — по merchantSku (= ваш собственный код
  // товара, тот же самый product_id, что используется везде в дашборде: Склад, Заказы, Поставки).
  // Точная привязка вместо угадывания по названию кампании (Kaspi даёт кампаниям своё, часто
  // сокращённое название, не совпадающее с названием товара в каталоге).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_campaign_products (
      campaign_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, product_id)
    );
  `);

  // Пользователи сайта с ролями. Раньше был один общий пароль на всех (DASHBOARD_PASSWORD) —
  // теперь у каждого свой логин/пароль. role: 'admin' | 'manager' | 'marketer'.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'marketer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Сессии — простой токен вместо пароля в каждом запросе. Выдаётся при входе, живёт,
  // пока пользователь сам не выйдет (как и раньше с localStorage).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Миграция: если пользователей ещё нет вообще — создаём одного admin'а из старого общего
  // пароля (DASHBOARD_PASSWORD), чтобы не потерять доступ к сайту после обновления.
  const usersCount = await pool.query(`SELECT COUNT(*) AS count FROM users`);
  if (Number(usersCount.rows[0].count) === 0 && process.env.DASHBOARD_PASSWORD) {
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(process.env.DASHBOARD_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin')`,
      [passwordHash]
    );
    console.log('Создан пользователь по умолчанию: admin / (старый общий пароль сайта). Обязательно смените его в Настройках!');
  }

  console.log('База данных готова: таблицы orders, order_items, product_batches, kaspi_pay_transactions, product_images, expenses, ad_expenses, users и sessions на месте.');
}

module.exports = { pool, initDb };
