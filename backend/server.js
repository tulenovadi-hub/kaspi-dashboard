// server.js — главный файл, который запускает веб-сервер
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { initDb, pool } = require('./db');
const { syncRecentOrders } = require('./syncJob');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const statsRoutes = require('./routes/stats');
const batchesRoutes = require('./routes/batches');
const reportsRoutes = require('./routes/reports');
const warehouseRoutes = require('./routes/warehouse');
const debugRoutes = require('./routes/debug');
const imagesRoutes = require('./routes/images');
const expensesRoutes = require('./routes/expenses');
const ordersRoutes = require('./routes/orders');

const app = express();
app.use(cors());
app.use(express.json());

// Авторизация по токену сессии: фронтенд присылает токен в заголовке X-Session-Token,
// сервер проверяет его в базе и подставляет req.user = { id, username, role }.
// /api/auth/login — единственный публичный роут (туда ещё нет токена, им только получают его).
async function authMiddleware(req, res, next) {
  if (req.path === '/auth/login') return next();

  const token = req.header('X-Session-Token');
  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Сессия истекла, войдите заново' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка проверки авторизации' });
  }
}

// Ограничивает роут только перечисленными ролями (req.user уже должен быть заполнен authMiddleware)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    }
    next();
  };
}

app.use('/api', authMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/users', requireRole('admin'), usersRoutes);

// Главная, Самовыкупы, Склад доступны всем ролям (admin, manager, marketer)
app.use('/api/stats', statsRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/product-images', imagesRoutes);
app.use('/api/orders', ordersRoutes);

// Поставки, Отчёт, Расходы — только для админа (у менеджера/маркетолога этих разделов нет в меню)
app.use('/api/batches', requireRole('admin'), batchesRoutes);
app.use('/api/reports', requireRole('admin'), reportsRoutes);
app.use('/api/expenses', requireRole('admin'), expensesRoutes);
app.use('/api/debug', requireRole('admin'), debugRoutes);

// Эндпоинт, чтобы вручную запустить синхронизацию из дашборда (кнопка "Обновить сейчас")
// или из внешнего планировщика (например, cron на своём сервере). Можно передать
// { "days": 150 } в теле запроса, чтобы сделать разовую глубокую синхронизацию.
//
// По умолчанию — 1 день (раньше было 3). Если синхронизация вызывается всего пару раз
// в день (например, ночным cron), лучше передавать days явно (2-3), чтобы не терять
// заказы при случайном сбое. Если же вызывать эту ручку часто (несколько раз в день,
// например с внешнего сервера) — 1 дня с запасом хватает на перекрытие интервалов.
app.post('/api/sync', async (req, res) => {
  try {
    const days = Number(req.body && req.body.days) || 1;
    res.json({ ok: true, days });
    syncRecentOrders(days).catch((err) => console.error('Ошибка фоновой синхронизации:', err));
  } catch (err) {
    console.error('Ошибка ручной синхронизации:', err);
    res.status(500).json({ error: 'Синхронизация не удалась' });
  }
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
    });

    // Автоматическая синхронизация каждую ночь в 03:00 (время сервера).
    // Этого времени обычно достаточно, чтобы все заказы за прошедший день уже были обработаны Kaspi.
    cron.schedule('0 3 * * *', () => {
      console.log('Запуск плановой ночной синхронизации...');
      syncRecentOrders().catch((err) => console.error('Ошибка плановой синхронизации:', err));
    });

    // Сразу при запуске сервера тоже делаем синхронизацию —
    // это полезно после каждого деплоя, чтобы не ждать до ночи.
    syncRecentOrders(60).catch((err) => console.error('Ошибка стартовой синхронизации:', err));
  })
  .catch((err) => {
    console.error('Не удалось подключиться к базе данных:', err);
    process.exit(1);
  });
