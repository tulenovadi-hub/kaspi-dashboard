// server.js — главный файл, который запускает веб-сервер
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { initDb } = require('./db');
const { syncRecentOrders } = require('./syncJob');
const statsRoutes = require('./routes/stats');
const batchesRoutes = require('./routes/batches');
const reportsRoutes = require('./routes/reports');
const warehouseRoutes = require('./routes/warehouse');
const debugRoutes = require('./routes/debug');

const app = express();
app.use(cors());
app.use(express.json());

// Простая защита паролем: фронтенд присылает пароль в заголовке X-Dashboard-Password
// на каждый запрос к /api/*, сервер сверяет его со значением из переменной окружения.
app.use('/api', (req, res, next) => {
  const provided = req.header('X-Dashboard-Password');
  if (!process.env.DASHBOARD_PASSWORD || provided !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  next();
});

app.use('/api/stats', statsRoutes);
app.use('/api/batches', batchesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/debug', debugRoutes);

// Эндпоинт, чтобы вручную запустить синхронизацию из дашборда (кнопка "Обновить сейчас")
app.post('/api/sync', async (req, res) => {
  try {
    res.json({ ok: true });
    syncRecentOrders().catch((err) => console.error('Ошибка фоновой синхронизации:', err));
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
