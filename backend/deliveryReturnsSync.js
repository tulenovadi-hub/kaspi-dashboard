// deliveryReturnsSync.js — находит заказы, отменённые при доставке (Kaspi Доставка), и
// сохраняет их в delivery_cancellations. Запускается либо разово на широкий диапазон дат
// (первоначальный бэкфилл), либо каждую ночь на последние пару дней (см. server.js).

const { pool } = require('./db');
const { fetchOrdersByStatus, fetchOrderByCode } = require('./kaspiClient');
const { fetchTrackingStatus } = require('./kaspiLogistics');
const { fetchAllWonderOrderCodes } = require('./wonderClient');

// За сколько дней назад искать НОВЫЕ отмены (и в кнопке "Проверить сейчас", и в ночном cron).
// Окно считается по дате СОЗДАНИЯ заказа, а не по дате отмены — так фильтрует Kaspi. Раньше было
// 2 дня, и этого не хватало: заказ, созданный три недели назад и отменённый сегодня, не находился
// вообще никогда и в список не попадал совсем. 20 дней покрывают практически все реальные отмены,
// а стоят почти ничего: поиск идёт кусками по 10 дней по двум статусам, то есть 4 запроса к Kaspi
// вместо 2 (~1-3 с на фоне ~3 минут всего прогона; 98% времени занимает перепроверка трекинга уже
// известных заказов, которая от этого окна не зависит вовсе).
const SEARCH_WINDOW_DAYS = 20;

// Сколько запросов к Kaspi держим одновременно. Проверка ходит в API по одному заказу за раз,
// и на нескольких сотнях отслеживаемых заказов последовательный обход растягивался на минуты
// (владелец, 11.09.2026: "Проверить сейчас" грузилась минут пять). Шесть — компромисс: время
// падает примерно в шесть раз, а нагрузка на Kaspi остаётся вежливой.
const REQUEST_CONCURRENCY = 6;

// Сколько дней от создания заказа отмену ещё имеет смысл перепроверять. Отсечка нужна, потому
// что "перепроверить" раньше означало "обойти ВСЮ историю": условие `tracking_status <>
// 'RETURNED'` навсегда оставляло в выборке каждую отмену, по которой возврата не было вовсе
// (товар не отправляли). Их число только растёт, и с ним росло время кнопки "Проверить
// сейчас". Через три месяца по отмене уже ничего не меняется: возврат либо принят, либо
// потерян и разбирается руками.
const RECHECK_WINDOW_DAYS = 90;

// Строки, которые ещё имеет смысл перепроверять: свежие ИЛИ те, по которым возврат прямо
// сейчас идёт (такие держим сколько угодно долго — это как раз "зависшие", их и надо видеть).
const RECHECK_FILTER = `(dc.creation_date > now() - interval '${RECHECK_WINDOW_DAYS} days' OR dc.tracking_active = true)`;

// Прогоняет items через fn не больше REQUEST_CONCURRENCY штук одновременно. Ошибка на одном
// заказе не должна ронять весь проход — считаем только удачные.
async function mapWithConcurrency(items, fn, limit = REQUEST_CONCURRENCY) {
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      try {
        const handled = await fn(item);
        if (handled !== false) done += 1;
      } catch (err) {
        console.error('Ошибка при обработке заказа', item, err.message);
      }
    }
  });
  await Promise.all(workers);
  return done;
}

function upsertFromAttrs(client, attrs) {
  const originCity = attrs.originAddress && attrs.originAddress.city ? attrs.originAddress.city.name : null;
  const returnedToWarehouse = attrs.kaspiDelivery ? attrs.kaspiDelivery.returnedToWarehouse : null;

  return client.query(
    `INSERT INTO delivery_cancellations
       (order_number, creation_date, total_price, cancellation_reason, delivery_mode, origin_city, state, status, returned_to_warehouse)
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (order_number) DO UPDATE SET
       total_price = EXCLUDED.total_price,
       cancellation_reason = EXCLUDED.cancellation_reason,
       delivery_mode = EXCLUDED.delivery_mode,
       origin_city = EXCLUDED.origin_city,
       state = EXCLUDED.state,
       status = EXCLUDED.status,
       returned_to_warehouse = EXCLUDED.returned_to_warehouse`,
    [attrs.code, attrs.creationDate, attrs.totalPrice, attrs.cancellationReason, attrs.deliveryMode, originCity, attrs.state, attrs.status, returnedToWarehouse]
  );
}

// Статусы отмены: "Ожидает отмены" (CANCELLING) и уже отменённый (CANCELLED). Второй нужен,
// чтобы не терять заказы, которые успели разрешиться ещё до того, как мы их впервые увидели
// (заказ 915440447).
const CANCELLATION_STATUSES = ['CANCELLING', 'CANCELLED'];

// Все состояния заказа у Kaspi — запасной перебор, если поиск без указания состояния не
// сработает (см. fetchCancellationsByStatus).
const ORDER_STATES = ['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'];

// Ищем по СТАТУСУ, не привязываясь к состоянию заказа.
//
// Так это работает с 11.09.2026. До этого спрашивались ровно два сочетания —
// KASPI_DELIVERY/CANCELLING и ARCHIVE/CANCELLED, — и заказ 1069743154 не находился ничем:
// создан 10 сентября (то есть в окне поиска), "Ожидает отмены", уже передан курьеру, а в
// список так и не попал. Состояние у такого заказа оказалось не тем, которое мы угадали.
// Статус отмены — единственное, что про отмену известно точно, по нему и ищем.
// Принимает ли Kaspi поиск без указания состояния. Проверяется один раз за жизнь процесса:
// если не принимает, каждый следующий поиск сразу шёл бы через перебор шести состояний, но
// сначала всё равно тратил бы запрос на заведомо неудачную попытку.
let statelessSearchWorks = null;

// Сколько запросов к Kaspi ушло на последний поиск и каким путём — уходит в timings ответа
// /sync, чтобы "поиск идёт 52 секунды" разбиралось по цифрам, а не на ощупь.
const lastSearchStats = { requests: 0, fallback: false };

async function fetchCancellationsByStatus(status, dateFromMs, dateToMs) {
  if (statelessSearchWorks === false) {
    lastSearchStats.fallback = true;
    return fetchByEachState(status, dateFromMs, dateToMs);
  }

  try {
    lastSearchStats.requests += 1;
    const orders = await fetchOrdersByStatus(null, status, dateFromMs, dateToMs);
    statelessSearchWorks = true;
    return orders;
  } catch (err) {
    // Если Kaspi не принимает поиск без состояния — перебираем состояния сами. Дороже
    // (шесть запросов вместо одного на каждый кусок дат), зато не зависит от того, обязателен
    // фильтр по состоянию в их API или нет.
    console.error(`Поиск отмен по статусу ${status} без состояния не прошёл, перебираем состояния:`, err.message);
    statelessSearchWorks = false;
    lastSearchStats.fallback = true;
    return fetchByEachState(status, dateFromMs, dateToMs);
  }
}

async function fetchByEachState(status, dateFromMs, dateToMs) {
  lastSearchStats.requests += ORDER_STATES.length;
  const perState = await Promise.all(
    ORDER_STATES.map((state) => fetchOrdersByStatus(state, status, dateFromMs, dateToMs).catch(() => []))
  );
  return perState.flat();
}

async function syncDeliveryCancellations(dateFromMs, dateToMs) {
  lastSearchStats.requests = 0;
  lastSearchStats.fallback = false;
  const found = await Promise.all(
    CANCELLATION_STATUSES.map((status) => fetchCancellationsByStatus(status, dateFromMs, dateToMs))
  );

  // По номеру заказа: при переборе состояний один и тот же заказ может прийти дважды, да и
  // считать "найдено" надо заказы, а не строки ответа.
  const byCode = new Map();
  for (const order of found.flat()) {
    const attrs = order.attributes || {};
    if (attrs.code) byCode.set(attrs.code, attrs);
  }

  for (const attrs of byCode.values()) {
    await upsertFromAttrs(pool, attrs);
  }
  return byCode.size;
}

// Перепроверяет уже отслеживаемые заказы, которые ещё не в архиве — ловит момент, когда
// Kaspi наконец разрешает отмену и переходит в ARCHIVE/CANCELLED. Диапазон дат тут не при
// чём — просто дёргаем каждый заказ по его номеру напрямую.
async function refreshTrackedOrders() {
  const result = await pool.query(
    `SELECT order_number FROM delivery_cancellations dc
     WHERE dc.status IS DISTINCT FROM 'CANCELLED' AND ${RECHECK_FILTER}`
  );

  return mapWithConcurrency(result.rows, async (row) => {
    const order = await fetchOrderByCode(row.order_number);
    if (!order || !order.attributes) return false;
    await upsertFromAttrs(pool, order.attributes);
  });
}

// Подтягивает настоящий статус трекинга (публичный logistics.kaspi.kz) для всех заказов, по
// которым мы ещё не видели подтверждённый возврат — как только видим, статус уже не
// изменится, дальше можно не перепроверять.
//
// ВАЖНО: верхнеуровневым полям (orderStatus/active/lastActualTrack) нельзя верить ВМЕСТО
// tracks — на заказе 773482186 они показывали "ещё едет" (active: true, lastActualTrack:
// null), хотя в массиве tracks того же ответа явно есть событие "RETURNED" с датой. Поэтому
// факт возврата ищем в самом массиве tracks: если там есть код RETURNED — заказ точно
// вернулся, и берём дату САМОГО ПОЗДНЕГО события из tracks как last_track_at (а не
// lastActualTrack, который тоже может быть пустым при непустой истории).
async function refreshTrackingStatuses() {
  const result = await pool.query(
    `SELECT order_number FROM delivery_cancellations dc
     WHERE dc.tracking_status IS DISTINCT FROM 'RETURNED'
       AND dc.stock_returned_at IS NULL
       AND ${RECHECK_FILTER}`
  );
  return mapWithConcurrency(result.rows, (row) => refreshTrackingForOrder(row.order_number));
}

// Трекинг одного заказа. Возвращает false, если Kaspi ничего не отдал (тогда заказ не
// считается обработанным). Вынесено из цикла выше, чтобы тем же кодом можно было обновить
// один заказ, найденный по номеру вручную.
async function refreshTrackingForOrder(orderNumber) {
  const data = await fetchTrackingStatus(orderNumber);
  if (!data) return false;

  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const hasReturned = tracks.some((t) => t.code === 'RETURNED');
  // ...но и игнорировать их целиком нельзя. Заказ 1069743154 (11.09.2026): покупатель отказался
  // ночью, когда посылка уже лежала на складе курьерской службы, и в tracks последними стоят
  // RECIPIENT_DECLINED + CANCELLED — по ним выходило "отменён без доставки, товар не уезжал".
  // А верхнеуровневое orderStatus у того же ответа — "RETURNING": посылка на складе Zammler в
  // Астане и едет обратно. Событий RETURN_* Kaspi при этом не выдаёт вовсе.
  const isReturningByStatus = data.orderStatus === 'RETURNING';
  const lastTrack = tracks.reduce((latest, t) => {
    if (!t.actualDateTime) return latest;
    if (!latest || new Date(t.actualDateTime) > new Date(latest.actualDateTime)) return t;
    return latest;
  }, null);

  // "Активно возвращается" — только если ПОСЛЕДНЕЕ по времени событие начинается с RETURN_
  // (реально в процессе обратной перевозки). Любой другой код последним (CANCELLED, ожидание
  // в пункте выдачи и т.п.) означает, что процесс так или иначе завершился без явного
  // подтверждения RETURNED — это не повод считать заказ зависшим, просто у него не было
  // отдельного этапа возврата (например, отменили ещё до отправки).
  const lastCode = lastTrack ? lastTrack.code : null;
  const isActivelyReturning = isReturningByStatus || !!(lastCode && lastCode.startsWith('RETURN_'));

  // RETURNING ставим в статус вместо последнего кода: иначе строка называлась бы "Отменён без
  // доставки" при том, что заказ активно возвращается.
  const trackingStatus = hasReturned ? 'RETURNED' : isReturningByStatus ? 'RETURNING' : lastCode;
  const trackingActive = hasReturned ? false : isActivelyReturning;
  const lastTrackAt = lastTrack ? lastTrack.actualDateTime : null;

  await pool.query(
    `UPDATE delivery_cancellations
     SET tracking_status = $2, tracking_active = $3, last_track_at = $4
     WHERE order_number = $1`,
    [orderNumber, trackingStatus, trackingActive, lastTrackAt]
  );
}

// Проверка ОДНОГО заказа по номеру — минуя обход по датам. Нужна, когда отмена есть в
// кабинете Kaspi, но в списке её нет: обычный поиск фильтрует по дате СОЗДАНИЯ заказа за
// последние SEARCH_WINDOW_DAYS дней, и заказ, оформленный давно и отменённый вчера, в это
// окно не попадает (заказ 1069743154, 11.09.2026).
//
// Отвечает подробно, а не просто "не найдено": если заказ есть, но не отменён, так и
// говорим — иначе с виду это неотличимо от "Kaspi его не отдал".
async function syncOrderByNumber(code) {
  const order = await fetchOrderByCode(code).catch(() => null);
  if (!order || !order.attributes) {
    return { found: false, added: false, message: `Kaspi не знает заказ ${code}` };
  }

  const attrs = order.attributes;
  // Сырые данные Kaspi по заказу — и карточка заказа, и трекинг. Отдаём наружу как есть:
  // когда строка ведёт себя странно (заказ 1069743154 — "Ожидает отмены" в кабинете, а в
  // трекинге последнее событие CANCELLED), спорить о причинах без исходных данных бесполезно.
  const tracking = await fetchTrackingStatus(code).catch(() => null);
  const diagnostics = { order: attrs, tracking };

  const isCancellation = attrs.status === 'CANCELLED' || attrs.status === 'CANCELLING';
  if (!isCancellation) {
    return {
      found: true,
      added: false,
      state: attrs.state,
      status: attrs.status,
      diagnostics,
      message: `Заказ ${code} не отменён (${attrs.state} / ${attrs.status})`,
    };
  }

  await upsertFromAttrs(pool, attrs);
  await refreshTrackingForOrder(code);

  const tracks = tracking && Array.isArray(tracking.tracks) ? tracking.tracks : [];
  const lastCode = tracks.length ? tracks[tracks.length - 1].code : null;
  return {
    found: true,
    added: true,
    state: attrs.state,
    status: attrs.status,
    diagnostics,
    message: `Заказ ${code} добавлен: ${attrs.state} / ${attrs.status}` +
      (tracks.length ? `, трек: ${lastCode}, событий ${tracks.length}` : ', трекинга нет'),
  };
}

// Сверяет заказы, реально уехавшие в доставку (tracking_status != 'CANCELLED' — тем, что
// отменили ещё до отправки, сверяться не с чем), со списком refund-order-groups у Wonder.
// Если WONDER_EMAIL/WONDER_PASSWORD не заданы (или Wonder вернул ошибку логина) — просто
// ничего не делает, остальная синхронизация не должна из-за этого падать.
async function refreshWonderReceived() {
  const codes = await fetchAllWonderOrderCodes();
  if (!codes) return 0;

  // Один запрос на всё, а не UPDATE на каждую строку. База в другом дата-центре, и на паре
  // сотен отмен эти круги складывались в десятки секунд — заметная часть тех самых пяти минут,
  // которые ждала владелец (11.09.2026). Сам список у Wonder уже в памяти, сравнивать построчно
  // на стороне сервера незачем.
  const result = await pool.query(
    `UPDATE delivery_cancellations
     SET wonder_received = (order_number = ANY($1::text[]))
     WHERE tracking_status IS DISTINCT FROM 'CANCELLED'`,
    [[...codes]]
  );
  return result.rowCount;
}

module.exports = { syncDeliveryCancellations, syncOrderByNumber, refreshTrackedOrders, refreshTrackingStatuses, refreshWonderReceived, SEARCH_WINDOW_DAYS, lastSearchStats };
