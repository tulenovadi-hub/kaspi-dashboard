// warehouseMapping.js — соответствие кода точки продаж Kaspi (pickupPointId) реальному складу.
// Префикс "18619047_" — это ID продавца в Kaspi, он не меняется для этого магазина.
// Если Kaspi добавит новую точку продаж, её код появится в orders.pickup_point_id
// как "неизвестный" (origin_city будет NULL) — тогда нужно будет добавить сюда новую строку.

const PICKUP_POINT_WAREHOUSE_MAP = {
  '18619047_PP2': 'Алматы',
  '18619047_PP3': 'Астана',
  '18619047_PP6': 'Юбилейное',
  '18619047_PP7': 'Талдыкорган',
};

function resolveWarehouse(pickupPointId) {
  return PICKUP_POINT_WAREHOUSE_MAP[pickupPointId] || null;
}

module.exports = { PICKUP_POINT_WAREHOUSE_MAP, resolveWarehouse };
