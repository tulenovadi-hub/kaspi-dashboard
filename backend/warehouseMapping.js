// warehouseMapping.js — ЕДИНЫЙ справочник складов. Здесь и только здесь описано, какие склады
// существуют, как они называются, какой код точки продаж Kaspi им соответствует и относится ли
// склад к основному магазину или к самовыкупам.
//
// До 2026-08-29 эти сведения были размазаны по восьми спискам в шести файлах (VALID_WAREHOUSES,
// SELF_BUY_WAREHOUSES, MAIN_CITIES, SELF_BUY_CITIES, DISPLAY_WAREHOUSES, WAREHOUSE_SORT_ORDER,
// CITY_ORDER и WAREHOUSES во фронтенде). Списки успели разъехаться: "основной магазин" на Главной
// означал "всё, кроме самовыкупов", а в Отчёте — "ровно Алматы и Астана", и заказы с неизвестной
// точкой продаж попадали на Главную, но пропадали из Отчёта. Теперь всё выводится отсюда.
//
// С 2026-11-01 склады живут в таблице warehouses и меняются на странице "Настройки". Модули берут
// списки ниже один раз при загрузке, поэтому applyWarehouses меняет их НА МЕСТЕ, а не заменяет:
// так новый состав сразу виден всем маршрутам. Заменять эти массивы и объекты новыми нельзя.
// Код точки виден в заказе Kaspi; префикс "18619047_" — это ID продавца, он для магазина не меняется.
//
// role: 'main'    — реальный склад: хранит товар, виден на "Складе", продажи идут в "Основной
//                   отчёт" и на Главную
//       'selfbuy' — самовыкупы, считаются отдельно и в основную статистику не входят
//       null      — тип ещё не выбран: заказы привязаны к складу, но не входят ни в одну группу

const PICKUP_POINT_PREFIX = '18619047_';

// Начальное содержимое таблицы warehouses. Дальше источник правды — база: миграция только
// дописывает отсутствующие строки и выбранный на сайте тип не перезаписывает.
const DEFAULT_WAREHOUSES = [
  { pickupPointId: '18619047_PP2', city: 'Алматы', role: 'main' },
  { pickupPointId: '18619047_PP3', city: 'Астана', role: 'main' },
  { pickupPointId: '18619047_PP5', city: 'Явленка', role: 'selfbuy' },
  { pickupPointId: '18619047_PP6', city: 'Юбилейное', role: 'selfbuy' },
  { pickupPointId: '18619047_PP7', city: 'Талдыкорган', role: 'selfbuy' },
  { pickupPointId: '18619047_PP8', city: 'Атырау', role: 'selfbuy' },
  { pickupPointId: '18619047_PP9', city: 'Актобе', role: null },
];

// Порядок в справочнике — это и порядок показа городов в интерфейсе.
const WAREHOUSES = [];
const ALL_CITIES = [];
const MAIN_CITIES = [];
const SELF_BUY_CITIES = [];
const DISPLAY_CITIES = [];

// { город: позиция } — для сортировки таблиц по городам вместо localeCompare
const CITY_ORDER = {};

// { код точки: город } — нужен синхронизации заказов (см. resolveWarehouse).
const PICKUP_POINT_WAREHOUSE_MAP = {};

function replaceArray(target, items) {
  target.splice(0, target.length, ...items);
}

function replaceObject(target, entries) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, Object.fromEntries(entries));
}

function applyWarehouses(rows) {
  const cities = rows.map((w) => w.city);
  const main = rows.filter((w) => w.role === 'main').map((w) => w.city);
  replaceArray(WAREHOUSES, rows);
  replaceArray(ALL_CITIES, cities);
  replaceArray(MAIN_CITIES, main);
  replaceArray(SELF_BUY_CITIES, rows.filter((w) => w.role === 'selfbuy').map((w) => w.city));
  // На "Складе" показываем только реальные склады.
  replaceArray(DISPLAY_CITIES, main);
  replaceObject(CITY_ORDER, cities.map((city, i) => [city, i]));
  replaceObject(PICKUP_POINT_WAREHOUSE_MAP, rows.map((w) => [w.pickupPointId, w.city]));
}

async function loadWarehouses(pool) {
  const result = await pool.query(
    `SELECT pickup_point_id AS "pickupPointId", city, role
     FROM warehouses
     ORDER BY sort_order, created_at`
  );
  applyWarehouses(result.rows);
}

// До чтения базы (тесты, отдельный запуск syncJob.js) работают начальные значения.
applyWarehouses(DEFAULT_WAREHOUSES);

// Неизвестная точка продаж → null. Такой заказ не относится ни к одному складу: он не спишет
// товар со склада, по нему не посчитается себестоимость и он не попадёт в "Отчёт". Чтобы это
// не осталось незамеченным, количество таких заказов возвращается в /api/orders (см. orders.js).
function resolveWarehouse(pickupPointId) {
  return PICKUP_POINT_WAREHOUSE_MAP[pickupPointId] || null;
}

module.exports = {
  PICKUP_POINT_PREFIX,
  DEFAULT_WAREHOUSES,
  WAREHOUSES,
  ALL_CITIES,
  MAIN_CITIES,
  SELF_BUY_CITIES,
  DISPLAY_CITIES,
  CITY_ORDER,
  PICKUP_POINT_WAREHOUSE_MAP,
  applyWarehouses,
  loadWarehouses,
  resolveWarehouse,
};
