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
// ЧТОБЫ ДОБАВИТЬ СКЛАД — допиши одну строку в WAREHOUSES ниже. Больше ничего править не нужно:
// и валидация поставок, и выпадающие списки, и деление на основной/самовыкупы, и порядок городов
// подхватят его сами. Код точки (pickupPointId) виден в заказе Kaspi; префикс "18619047_" —
// это ID продавца, он для магазина не меняется.
//
// role: 'main'    — обычные продажи, идут в "Основной отчёт" и на Главную
//       'selfbuy' — самовыкупы, считаются отдельно и в основную статистику не входят
// display         — показывать ли склад на странице "Склад" (там нужны только рабочие склады)

const WAREHOUSES = [
  { pickupPointId: '18619047_PP2', city: 'Алматы', role: 'main', display: true },
  { pickupPointId: '18619047_PP3', city: 'Астана', role: 'main', display: true },
  { pickupPointId: '18619047_PP6', city: 'Юбилейное', role: 'selfbuy', display: false },
  { pickupPointId: '18619047_PP7', city: 'Талдыкорган', role: 'selfbuy', display: false },
  { pickupPointId: '18619047_PP8', city: 'Атырау', role: 'selfbuy', display: false },
];

// Порядок в массиве выше — это и порядок показа городов в интерфейсе, менять его осмысленно.
const ALL_CITIES = WAREHOUSES.map((w) => w.city);
const MAIN_CITIES = WAREHOUSES.filter((w) => w.role === 'main').map((w) => w.city);
const SELF_BUY_CITIES = WAREHOUSES.filter((w) => w.role === 'selfbuy').map((w) => w.city);
const DISPLAY_CITIES = WAREHOUSES.filter((w) => w.display).map((w) => w.city);

// { город: позиция } — для сортировки таблиц по городам вместо localeCompare
const CITY_ORDER = Object.fromEntries(ALL_CITIES.map((city, i) => [city, i]));

// { код точки: город } — в этом виде справочник нужен миграции в db.js, которая при каждом
// старте пересчитывает orders.origin_city из сохранённого pickup_point_id. Благодаря ей
// добавление склада сюда чинит и уже загруженные заказы, а не только будущие.
const PICKUP_POINT_WAREHOUSE_MAP = Object.fromEntries(
  WAREHOUSES.map((w) => [w.pickupPointId, w.city])
);

// Неизвестная точка продаж → null. Такой заказ не относится ни к одному складу: он не спишет
// товар со склада, по нему не посчитается себестоимость и он не попадёт в "Отчёт". Чтобы это
// не осталось незамеченным, количество таких заказов возвращается в /api/orders (см. orders.js).
function resolveWarehouse(pickupPointId) {
  return PICKUP_POINT_WAREHOUSE_MAP[pickupPointId] || null;
}

module.exports = {
  WAREHOUSES,
  ALL_CITIES,
  MAIN_CITIES,
  SELF_BUY_CITIES,
  DISPLAY_CITIES,
  CITY_ORDER,
  PICKUP_POINT_WAREHOUSE_MAP,
  resolveWarehouse,
};
