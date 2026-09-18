// server.js — главный файл, который запускает веб-сервер
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { initDb, pool } = require('./db');
const { syncRecentOrders, syncLatestOrders, syncOrderStatuses, syncReturnedOrders } = require('./syncJob');
const { syncDeliveryCancellations, refreshTrackedOrders, refreshTrackingStatuses, refreshWonderReceived, SEARCH_WINDOW_DAYS } = require('./deliveryReturnsSync');
const { enqueueKaspiSync, getKaspiSyncState } = require('./syncCoordinator');
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
const adExpensesRoutes = require('./routes/adExpenses');
const bonusExpensesRoutes = require('./routes/bonusExpenses');
const reviewBonusExpensesRoutes = require('./routes/reviewBonusExpenses');
const analystRoutes = require('./routes/analyst');
const deliveryReturnsRoutes = require('./routes/deliveryReturns');
const geographyRoutes = require('./routes/geography');
const abcRoutes = require('./routes/abc');
const unitEconomicsRoutes = require('./routes/unitEconomics');
const purchasingRoutes = require('./routes/purchasing');

const app = express();
app.use(cors());
// Лимит по умолчанию (100kb) слишком мал для выгрузки расходов на рекламу за длинные периоды —
// Tampermonkey-скрипт может прислать десятки кампаний с ежедневными данными за много месяцев.
app.use(express.json({ limit: '25mb' }));

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
app.use('/api/purchasing', requireRole('admin'), purchasingRoutes);
app.use('/api/reports', requireRole('admin'), reportsRoutes);
app.use('/api/expenses', requireRole('admin'), expensesRoutes);
app.use('/api/ad-expenses', requireRole('admin', 'marketer'), adExpensesRoutes);
app.use('/api/bonus-expenses', requireRole('admin', 'marketer'), bonusExpensesRoutes);
app.use('/api/review-bonus-expenses', requireRole('admin', 'marketer'), reviewBonusExpensesRoutes);
app.use('/api/analyst', requireRole('admin'), analystRoutes);
app.use('/api/delivery-returns', requireRole('admin'), deliveryReturnsRoutes);
app.use('/api/geography', requireRole('admin', 'marketer'), geographyRoutes);
app.use('/api/abc', requireRole('admin'), abcRoutes);
app.use('/api/unit-economics', requireRole('admin'), unitEconomicsRoutes);
app.use('/api/debug', requireRole('admin'), debugRoutes);

// Эндпоинт, чтобы вручную запустить синхронизацию из дашборда (кнопка "Сверить с Kaspi")
// или из внешнего планировщика (например, cron на своём сервере). Можно передать
// { "days": 150 } в теле запроса, чтобы сделать разовую глубокую синхронизацию.
//
// По умолчанию — 1 день (раньше было 3). Если синхронизация вызывается всего пару раз
// в день (например, ночным cron), лучше передавать days явно (2-3), чтобы не терять
// заказы при случайном сбое. Если же вызывать эту ручку часто (несколько раз в день,
// например с внешнего сервера) — 1 дня с запасом хватает на перекрытие интервалов.
// Поиск НОВЫХ отмен при доставке — четыре запроса к Kaspi, секунды. Специально без
// перепроверки трекинга (refreshTrackingStatuses обходит все незавершённые заказы и занимает
// ~3 минуты) — она остаётся ночному крону и кнопке "Проверить сейчас" на самой странице.
//
// Зачем понадобилось (11.09.2026): новая отмена не появлялась на сайте, сколько страницу ни
// обновляй. Обновление страницы просто перечитывает базу, а в базу отмены попадали ровно двумя
// путями — ночной cron в 03:00 внутри процесса и та самая кнопка. Ночной при этом мог и не
// сработать: на бесплатном тарифе инстанс к ночи спит, а спящий процесс своих таймеров не
// выполняет. Внешний крон дёргает /api/sync, но там были только обычные заказы. Теперь новые
// отмены приезжают тем же путём, что и заказы.
// Поиск за 20 дней стоит Kaspi десятки секунд (замер 11.09.2026), а внешний крон дёргает
// /api/sync часто — поэтому автоматический путь ищет отмены не чаще раза в полчаса. Кнопка
// "Проверить сейчас" на странице отмен этим ограничением не связана: там человек ждёт
// результат сознательно.
const STATUS_SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_SEARCH_MIN_INTERVAL_MS = 30 * 60 * 1000;
let lastOrderStatusSyncAt = 0;
let lastAutoCancellationSearchAt = 0;

async function syncRecentDeliveryCancellations() {
  const now = Date.now();
  if (now - lastAutoCancellationSearchAt < AUTO_SEARCH_MIN_INTERVAL_MS) return null;
  // Отмечаем попытку до запроса: если Kaspi временно ошибся, не долбим тяжёлый 20-дневный
  // поиск каждую следующую минуту, а повторяем его через обычные 30 минут.
  lastAutoCancellationSearchAt = now;
  return syncDeliveryCancellations(now - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000, now);
}

async function trySyncRecentDeliveryCancellations() {
  try {
    return await syncRecentDeliveryCancellations();
  } catch (err) {
    // Заказы к этому моменту уже сохранены. Ошибка дополнительной проверки отмен не должна
    // превращать весь live/manual запуск в неудачный и скрывать полезный результат.
    console.error('Ошибка поиска отмен при доставке:', err);
    return null;
  }
}

async function syncOrdersAndRecentCancellations(days) {
  const orders = await syncRecentOrders(days);
  if (days >= 1) lastOrderStatusSyncAt = Date.now();
  // Возвраты покупателей могут быть оформлены спустя много дней после создания заказа,
  // поэтому окно days для них неприменимо: каждый полный проход сверяет RETURNED со складской
  // даты отсечки. Очередь Kaspi гарантирует, что этот запрос не наложится на live-синхронизацию.
  const returnedOrders = await syncReturnedOrders();
  const cancellations = await trySyncRecentDeliveryCancellations();
  return { ...orders, returned_orders: returnedOrders.orders, delivery_cancellations: cancellations };
}

async function runLiveSyncCycle() {
  const statusSyncDue = Date.now() - lastOrderStatusSyncAt >= STATUS_SYNC_MIN_INTERVAL_MS;
  let orderMode = 'latest';
  let orders;

  if (statusSyncDue) {
    orderMode = 'statuses_24h';
    // При временной ошибке повторим широкую сверку через 10 минут, а между ними продолжим
    // короткие минутные проходы по новым заказам.
    lastOrderStatusSyncAt = Date.now();
    orders = await syncOrderStatuses(24);
  } else {
    orders = await syncLatestOrders(10);
  }

  // Выполняется после заказов в той же очереди, поэтому даже долгая проверка отмен не
  // пересекается с очередным минутным запросом.
  const cancellations = await trySyncRecentDeliveryCancellations();
  return { mode: orderMode, ...orders, delivery_cancellations: cancellations };
}

async function runNightlySync() {
  const orders = await syncRecentOrders();
  lastOrderStatusSyncAt = Date.now();
  const returnedOrders = await syncReturnedOrders();

  const now = Date.now();
  const cancellations = await syncDeliveryCancellations(
    now - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    now
  );
  lastAutoCancellationSearchAt = Date.now();
  const refreshed = await refreshTrackedOrders();
  const trackingChecked = await refreshTrackingStatuses();
  const wonderChecked = await refreshWonderReceived();
  return { orders, returnedOrders, cancellations, refreshed, trackingChecked, wonderChecked };
}

// Отдельная лёгкая ручка для внешнего минутного cron на Oracle. Один запуск может затянуться
// из-за ответа Kaspi, поэтому следующий не стартует параллельно, а получает skipped=true.
// Обычно проверяет новые заказы за 10 минут; раз в 10 минут сверяет статусы за сутки, а раз
// в 30 минут ищет отмены при доставке. Все этапы идут строго последовательно.
app.post('/api/sync/live', async (req, res) => {
  const syncPromise = enqueueKaspiSync('live', runLiveSyncCycle, { skipIfBusy: true });
  if (!syncPromise) return res.json({ ok: true, skipped: true, reason: 'already_running', queue: getKaspiSyncState() });

  const startedAt = Date.now();
  try {
    const result = await syncPromise;
    res.json({ ok: true, duration_ms: Date.now() - startedAt, ...result });
  } catch (err) {
    console.error('Ошибка live-синхронизации:', err);
    res.status(500).json({ error: 'Live-синхронизация не удалась' });
  }
});

app.post('/api/sync', async (req, res) => {
  const days = Number(req.body && req.body.days) || 1;
  // `wait` — дождаться конца синхронизации и ответить итогом.
  //
  // Зачем понадобилось (2026-09-10): кнопка "Сверить с Kaspi" на Главной получала ответ
  // МГНОВЕННО, ещё до того, как сервер сходит в Kaspi, и страница перечитывала базу раньше,
  // чем в неё попадали новые заказы. Выглядело так, будто кнопка не работает: нажимаешь,
  // надпись "Обновляем..." гаснет, а свежего заказа нет — он доезжал через несколько секунд,
  // и увидеть его можно было только свайпом вниз.
  //
  // Крон на Oracle флаг не шлёт и работает по-старому, ответом сразу: ему итог не нужен,
  // а держать curl открытым лишние секунды незачем.
  const wait = Boolean(req.body && req.body.wait);

  if (!wait) {
    res.json({ ok: true, days });
    enqueueKaspiSync('full-background', () => syncOrdersAndRecentCancellations(days))
      .catch((err) => console.error('Ошибка фоновой синхронизации:', err));
    return;
  }

  try {
    // Ответа ждём вместе с заказами: кнопка "Сверить с Kaspi" на Главной для того и ждёт,
    // чтобы страница перечитала базу уже со всем свежим.
    const result = await enqueueKaspiSync('full-manual', () => syncOrdersAndRecentCancellations(days));
    res.json({ ok: true, days, ...result });
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
      // Отменённые при доставке заказы: новые за последние SEARCH_WINDOW_DAYS дней (окно
      // считается по дате создания заказа, см. комментарий у константы) + перепроверка уже
      // отслеживаемых незавершённых заказов (вдруг переехали в архив) + обновление реального
      // трекинга доставки/возврата. Исходный бэкфилл всей истории делается один раз вручную
      // (см. backend/routes/deliveryReturns.js POST /sync).
      enqueueKaspiSync('nightly', runNightlySync)
        .catch((err) => console.error('Ошибка плановой синхронизации:', err));
    });

    // Сразу при запуске сервера тоже делаем синхронизацию —
    // это полезно после каждого деплоя/рестарта, чтобы не ждать до ночи.
    // 5 дней с запасом покрывает любой разумный перерыв в работе сервиса (например,
    // "просыпание" после сна на бесплатном тарифе) — раньше было 60, но это того не стоило:
    // каждый рестарт заново гонял тяжёлую синхронизацию на два месяца назад.
    // И отмены при доставке — по той же причине: инстанс просыпается днём, ночной cron к
    // этому моменту уже не сработал. Оба шага выполняются последовательно в общей очереди.
    enqueueKaspiSync('startup', () => syncOrdersAndRecentCancellations(5))
      .catch((err) => console.error('Ошибка стартовой синхронизации:', err));
  })
  .catch((err) => {
    console.error('Не удалось подключиться к базе данных:', err);
    process.exit(1);
  });
