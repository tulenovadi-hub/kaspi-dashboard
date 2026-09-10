const express = require('express');
const { pool } = require('../db');
const { syncDeliveryCancellations, syncOrderByNumber, refreshTrackedOrders, refreshTrackingStatuses, refreshWonderReceived, SEARCH_WINDOW_DAYS } = require('../deliveryReturnsSync');

const router = express.Router();

// Сколько дней без движения (или без единого трек-события вообще) — повод считать заказ
// подозрительным. Порог согласован с владельцем магазина.
const SUSPICIOUS_DAYS_THRESHOLD = 45;

router.get('/', async (req, res) => {
  try {
    // Наименование товара берём из order_items — чтобы по строке было видно, что именно едет
    // обратно. У заказа может быть несколько позиций, поэтому склеиваем их в одну строку.
    // LEFT JOIN: состав заказа мог не подтянуться (например, отмена случилась до того, как мы
    // впервые увидели заказ) — такую строку терять нельзя.
    const result = await pool.query(
      `SELECT dc.order_number, dc.creation_date, dc.total_price, dc.cancellation_reason, dc.delivery_mode,
              dc.origin_city, dc.state, dc.status, dc.tracking_status, dc.tracking_active,
              dc.last_track_at, dc.wonder_received, dc.stock_returned_at, dc.archived_at,
              items.product_names, items.quantity
       FROM delivery_cancellations dc
       LEFT JOIN orders o ON o.code = dc.order_number
       LEFT JOIN LATERAL (
         SELECT STRING_AGG(DISTINCT oi.product_name, ', ') AS product_names, SUM(oi.quantity) AS quantity
         FROM order_items oi
         WHERE oi.order_id = o.id
       ) items ON true
       ORDER BY dc.creation_date ASC`
    );

    const now = Date.now();
    const orders = result.rows.map((r) => {
      const daysSince = Math.floor((now - new Date(r.creation_date).getTime()) / (24 * 60 * 60 * 1000));
      // tracking_active = false — трекинг сам сообщил, что процесс закончен. И "RETURNED"
      // (реально вернулся), и "CANCELLED" (отменили ДО того, как заказ вообще уехал в
      // доставку — возвращать было нечего) — это нормальные, благополучные исходы, не повод
      // для подозрений. Пока трекинг ещё активен ("RETURNING" и т.п.) — подозрительно, только
      // если движения нет уже слишком долго. Если трекинг вообще не нашёлся (null) — данных
      // не хватает, лучше не флагать вслепую, чем повторить ошибку с returnedToWarehouse.
      let suspicious = false;
      let daysSinceLastTrack = null;
      if (r.tracking_active === true) {
        const lastTrackMs = r.last_track_at ? new Date(r.last_track_at).getTime() : null;
        daysSinceLastTrack = lastTrackMs ? Math.floor((now - lastTrackMs) / (24 * 60 * 60 * 1000)) : daysSince;
        suspicious = daysSinceLastTrack >= SUSPICIOUS_DAYS_THRESHOLD;
      }

      return {
        order_number: r.order_number,
        product_names: r.product_names,
        quantity: r.quantity === null ? null : Number(r.quantity),
        stock_returned_at: r.stock_returned_at,
        archived_at: r.archived_at,
        // Заказ реально уехал в возврат: либо едет прямо сейчас, либо Kaspi уже отчитался о
        // приёме. Только у таких есть смысл в кнопке "+ / − в остаток" — товар, который вообще
        // не отправляли, в остатке и так лежит.
        in_return_flow: r.tracking_active === true || r.tracking_status === 'RETURNED',
        // Вычтен ли заказ прямо сейчас из остатка на "Складе" (то же условие, что и в
        // computeWarehouseStock). От архива это НЕ зависит: если заказ убрали крестиком, не
        // добавив в остаток (например, посылка потерялась), товара на полке всё равно нет.
        subtracted_from_stock: r.stock_returned_at === null && (r.tracking_active === true || r.tracking_status === 'RETURNED'),
        creation_date: r.creation_date,
        days_since: daysSince,
        days_since_last_track: daysSinceLastTrack,
        total_price: Number(r.total_price),
        cancellation_reason: r.cancellation_reason,
        delivery_mode: r.delivery_mode,
        origin_city: r.origin_city,
        state: r.state,
        status: r.status,
        tracking_status: r.tracking_status,
        tracking_active: r.tracking_active,
        last_track_at: r.last_track_at,
        wonder_received: r.wonder_received,
        suspicious,
      };
    });

    res.json({ orders, threshold_days: SUSPICIOUS_DAYS_THRESHOLD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список отменённых при доставке заказов' });
  }
});

// Ручной запуск проверки: находит новые отмены за диапазон (по умолчанию последние
// SEARCH_WINDOW_DAYS дней — то же самое, что и ночная синхронизация; можно передать
// { "from": "2026-01-01" } для разового бэкфилла), перепроверяет статус ещё не архивных
// заказов в основном API, и обновляет реальный трекинг доставки/возврата для всех
// незавершённых заказов.
router.post('/sync', async (req, res) => {
  try {
    // Точечная проверка по номеру заказа — отдельная короткая ветка (два запроса к Kaspi
    // вместо полного прохода на несколько минут). Ею добирают отмены, которые не попали в
    // окно поиска по дате создания.
    const orderNumber = req.body && req.body.order ? String(req.body.order).trim() : null;
    if (orderNumber) {
      if (!/^\d+$/.test(orderNumber)) {
        return res.status(400).json({ error: 'Номер заказа — это только цифры' });
      }
      const result = await syncOrderByNumber(orderNumber);
      return res.json({ ok: true, order: orderNumber, ...result });
    }

    const dateToMs = Date.now();
    const dateFromMs = req.body && req.body.from
      ? new Date(req.body.from).getTime()
      : dateToMs - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const foundNew = await syncDeliveryCancellations(dateFromMs, dateToMs);
    const refreshed = await refreshTrackedOrders();
    const trackingChecked = await refreshTrackingStatuses();

    // Отдельный try/catch — если у Wonder не задан логин или он сам недоступен, это не должно
    // сбрасывать уже полученные результаты по остальным шагам синхронизации.
    let wonderChecked = 0;
    try {
      wonderChecked = await refreshWonderReceived();
    } catch (err) {
      console.error('Не удалось сверить заказы с Wonder:', err);
    }

    // window_days отдаём наружу, чтобы по ответу было видно, за какой период реально искали
    // (у ручного бэкфилла с { "from": ... } он больше, чем обычные SEARCH_WINDOW_DAYS).
    const windowDays = Math.round((dateToMs - dateFromMs) / (24 * 60 * 60 * 1000));
    res.json({ ok: true, window_days: windowDays, found_new: foundNew, refreshed, tracking_checked: trackingChecked, wonder_checked: wonderChecked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось проверить отменённые заказы' });
  }
});

// "+ в остаток" — владелец сама убедилась, что вернувшийся товар физически доехал до склада. До
// нажатия этой кнопки штуки вычтены из остатка на "Складе" (колонка "Возвращается"), после —
// снова в остатке. Автоматически по трекингу Kaspi этого не происходит специально: трекинг
// говорит "вернулся на склад" раньше, чем товар реально доходит. Строка при этом ОСТАЁТСЯ в
// основной таблице (в архив её убирает только крестик) — чтобы промах можно было тут же отменить.
router.post('/:orderNumber/return-to-stock', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE delivery_cancellations SET stock_returned_at = now()
       WHERE order_number = $1 AND stock_returned_at IS NULL
       RETURNING order_number, stock_returned_at`,
      [req.params.orderNumber]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Заказ не найден или уже добавлен в остаток' });
    }
    res.json({ ok: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось добавить заказ в остаток' });
  }
});

// "− из остатка" — отмена предыдущего действия (промахнулась кнопкой, или товар оказался не тем).
// Штуки снова вычитаются из остатка на "Складе".
router.delete('/:orderNumber/return-to-stock', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE delivery_cancellations SET stock_returned_at = NULL
       WHERE order_number = $1 AND stock_returned_at IS NOT NULL
       RETURNING order_number`,
      [req.params.orderNumber]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Заказ не найден или и так не добавлен в остаток' });
    }
    res.json({ ok: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось убрать заказ из остатка' });
  }
});

// Крестик в таблице — убрать заказ из основной таблицы в архив. Строка НЕ удаляется: она видна
// внизу страницы, и если товар так и не был добавлен в остаток, там у неё останется кнопка
// "+ в остаток". Раньше крестик удалял запись из базы совсем — теперь для этого есть отдельный
// DELETE ниже (в интерфейсе не используется, только руками через API).
router.post('/:orderNumber/archive', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE delivery_cancellations SET archived_at = now()
       WHERE order_number = $1 AND archived_at IS NULL
       RETURNING order_number`,
      [req.params.orderNumber]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Заказ не найден или уже в архиве' });
    }
    res.json({ ok: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось убрать заказ в архив' });
  }
});

// Вернуть строку из архива в основную таблицу. Кнопки в интерфейсе пока нет (в архиве их было бы
// под сотню, а нужна такая операция редко) — но действие крестика не должно быть необратимым,
// поэтому через API откатить можно.
router.delete('/:orderNumber/archive', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE delivery_cancellations SET archived_at = NULL
       WHERE order_number = $1 AND archived_at IS NOT NULL
       RETURNING order_number`,
      [req.params.orderNumber]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Заказ не найден или и так не в архиве' });
    }
    res.json({ ok: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось вернуть заказ из архива' });
  }
});

// Полное удаление записи. В интерфейсе кнопки нет (крестик отправляет в архив) — остаётся как
// ручная операция через API на случай мусорной записи.
router.delete('/:orderNumber', async (req, res) => {
  try {
    await pool.query('DELETE FROM delivery_cancellations WHERE order_number = $1', [req.params.orderNumber]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить заказ из списка' });
  }
});

module.exports = router;
