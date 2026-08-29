const express = require('express');
const { pool } = require('../db');
const { MAIN_CITIES, SELF_BUY_CITIES } = require('../warehouseMapping');
const { REGIONS, REGION_BY_ID, MACRO_REGIONS, resolveRegion, displayCity } = require('../kzRegions');

const router = express.Router();

// Те же статусы, что на Главной и в Отчёте — чтобы выручка на карте сходилась с выручкой там.
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Читаемые названия способов доставки.
//
// ВАЖНО про DELIVERY_PICKUP: это НЕ "покупатель зашёл к нам в магазин". У Kaspi это "покупатель
// забирает сам", и в подавляющем большинстве случаев (isKaspiDelivery = true) заказ до пункта
// выдачи везёт Kaspi, а нам за это выставляют счёт — проверено на живых заказах: заказ из
// Алматы в Караганду с DELIVERY_PICKUP стоил нам 1507 ₸ доставки. Настоящий самовывоз от
// продавца — это тот же режим, но с isKaspiDelivery = false.
function modeLabel(mode, isKaspiDelivery) {
  if (mode === 'DELIVERY_PICKUP') {
    return isKaspiDelivery === false ? 'Самовывоз от продавца' : 'Kaspi доставка, до пункта выдачи';
  }
  const base = {
    DELIVERY_LOCAL: 'Доставка по городу',
    DELIVERY_REGIONAL_TODOOR: 'Межгород, до двери',
    DELIVERY_REGIONAL_PICKUP: 'Межгород, до пункта выдачи',
    DELIVERY_POSTOMAT: 'Постомат',
  }[mode] || mode || 'Способ не указан';
  if (isKaspiDelivery === null) return base;
  return `${base} (${isKaspiDelivery ? 'Kaspi доставка' : 'своя доставка'})`;
}

// Города отгрузки для режима страницы. 'all' — вообще без фильтра по складу: в него попадают
// и заказы без origin_city, которых в остальных режимах не видно.
function warehouseFilter(mode) {
  if (mode === 'all') return null;
  return mode === 'selfbuy' ? SELF_BUY_CITIES : MAIN_CITIES;
}

// Из адреса вида "Алматы, Бостандыкский район, ул. ..." берём первую часть — город.
function cityFromFormattedAddress(address) {
  if (!address) return null;
  const head = String(address).split(',')[0].trim();
  return head || null;
}

function emptyBucket() {
  return { orders: 0, revenue: 0, deliveryCost: 0, ordersWithCost: 0 };
}

function addToBucket(bucket, row) {
  bucket.orders += 1;
  bucket.revenue += num(row.total_price) || 0;
  const cost = num(row.delivery_cost_for_seller);
  if (cost !== null) {
    bucket.ordersWithCost += 1;
    bucket.deliveryCost += cost;
  }
}

function finishBucket(bucket) {
  return {
    orders: bucket.orders,
    revenue: Math.round(bucket.revenue),
    avgCheck: bucket.orders > 0 ? Math.round(bucket.revenue / bucket.orders) : 0,
    deliveryCost: Math.round(bucket.deliveryCost),
    ordersWithCost: bucket.ordersWithCost,
    avgDeliveryCost: bucket.ordersWithCost > 0 ? Math.round(bucket.deliveryCost / bucket.ordersWithCost) : null,
  };
}

router.get('/', async (req, res) => {
  const { from, to, mode } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  const cities = warehouseFilter(mode);

  // $1 from, $2 to, $3 статусы, $4 (только в режимах кроме 'all') — города отгрузки.
  const params = [from, to, VALID_STATUSES];
  if (cities) params.push(cities);

  try {
    const result = await pool.query(
      `SELECT
         o.code,
         o.total_price,
         o.origin_city,
         o.raw_data->'attributes'->>'deliveryMode' AS delivery_mode,
         o.raw_data->'attributes'->>'isKaspiDelivery' AS is_kaspi_delivery,
         o.raw_data->'attributes'->'kaspiDelivery'->>'express' AS express,
         -- Сколько Kaspi списал с НАС за доставку этого заказа. Есть у каждого заказа, в отличие
         -- от Excel-отчёта Kaspi Pay, и совпадает с ним до тенге (сверено на живых заказах).
         o.raw_data->'attributes'->>'deliveryCostForSeller' AS delivery_cost_for_seller,
         -- Куда уехал заказ. Основное поле — deliveryAddress.town; у заказов Kaspi Delivery
         -- улицы и координат в адресе нет, зато у своей доставки есть и они, и точные координаты.
         COALESCE(
           o.raw_data->'attributes'->'deliveryAddress'->>'town',
           CASE WHEN jsonb_typeof(o.raw_data->'attributes'->'deliveryAddress'->'city') = 'string'
                THEN o.raw_data->'attributes'->'deliveryAddress'->>'city' END,
           o.raw_data->'attributes'->'deliveryAddress'->>'district'
         ) AS dest_city,
         o.raw_data->'attributes'->'deliveryAddress'->>'formattedAddress' AS formatted_address,
         o.raw_data->'attributes'->'deliveryAddress'->>'latitude' AS lat,
         o.raw_data->'attributes'->'deliveryAddress'->>'longitude' AS lon,
         kpt.delivery_cost AS report_delivery_cost
       FROM orders o
       LEFT JOIN (
         SELECT order_number, SUM(delivery_cost) AS delivery_cost
         FROM kaspi_pay_transactions
         GROUP BY order_number
       ) kpt ON kpt.order_number = o.code
       WHERE o.creation_date >= $1::timestamp - interval '5 hours'
         AND o.creation_date < $2::timestamp - interval '5 hours' + interval '1 day'
         AND o.status = ANY($3::text[])
         ${cities ? 'AND o.origin_city = ANY($4::text[])' : ''}`,
      params
    );

    const rows = result.rows;

    const totals = emptyBucket();
    let expressOrders = 0;
    let expressKnown = 0;
    let sellerPickupOrders = 0;
    let kaspiPickupOrders = 0;
    let destCityKnown = 0;
    let coordsKnown = 0;
    // Тот же расход, но по Excel-отчёту Kaspi Pay — держим рядом как контрольную цифру.
    let reportDeliveryCost = 0;
    let ordersWithReport = 0;

    const byRegion = new Map();
    const byMacro = new Map();
    const byMode = new Map();
    const unknownPlaces = new Map();

    for (const row of rows) {
      const lat = num(row.lat);
      const lon = num(row.lon);
      // Пустые координаты Kaspi присылает нулями — это не точка в Гвинейском заливе.
      row.coords = lat && lon ? { lat, lon } : null;
      if (row.coords) coordsKnown += 1;

      addToBucket(totals, row);

      if (row.report_delivery_cost !== null) {
        ordersWithReport += 1;
        // В Excel расход лежит со знаком минус — как его читает stats.js.
        reportDeliveryCost += -(num(row.report_delivery_cost) || 0);
      }

      const isKaspiDelivery = row.is_kaspi_delivery === null ? null : row.is_kaspi_delivery === 'true';
      if (row.express !== null) {
        expressKnown += 1;
        if (row.express === 'true') expressOrders += 1;
      }
      if (row.delivery_mode === 'DELIVERY_PICKUP') {
        if (isKaspiDelivery === false) sellerPickupOrders += 1;
        else kaspiPickupOrders += 1;
      }

      // --- разрез по способу доставки ---
      const modeKey = `${row.delivery_mode || 'UNKNOWN'}|${isKaspiDelivery}`;
      if (!byMode.has(modeKey)) {
        byMode.set(modeKey, { key: modeKey, label: modeLabel(row.delivery_mode, isKaspiDelivery), ...emptyBucket() });
      }
      addToBucket(byMode.get(modeKey), row);

      // --- разрез по географии ---
      const rawCity = row.dest_city || cityFromFormattedAddress(row.formatted_address);
      if (rawCity) destCityKnown += 1;

      const regionId = resolveRegion(rawCity, row.coords);
      if (rawCity && !regionId) {
        // Населённый пункт, который не удалось отнести к области. Сам по себе он на странице
        // не нужен — но без списка таких мест непонятно, почему часть заказов не на карте.
        const key = displayCity(rawCity);
        unknownPlaces.set(key, (unknownPlaces.get(key) || 0) + 1);
      }

      const regionKey = regionId || 'unknown';
      if (!byRegion.has(regionKey)) byRegion.set(regionKey, emptyBucket());
      addToBucket(byRegion.get(regionKey), row);

      const macroKey = (regionId && REGION_BY_ID[regionId].macro) || 'unknown';
      if (!byMacro.has(macroKey)) byMacro.set(macroKey, emptyBucket());
      addToBucket(byMacro.get(macroKey), row);
    }

    const totalsOut = finishBucket(totals);
    const regionsWithSales = [...byRegion.keys()].filter((k) => k !== 'unknown').length;

    const share = (value) => (totalsOut.revenue > 0 ? (value / totalsOut.revenue) * 100 : 0);

    const regions = REGIONS.map((r) => {
      const done = finishBucket(byRegion.get(r.id) || emptyBucket());
      return {
        id: r.id,
        name: r.name,
        short: r.short,
        macro: r.macro,
        isCity: Boolean(r.isCity),
        ...done,
        revenueShare: share(done.revenue),
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // Макрорегионы отдаём всегда все пять, даже с нулями: "куда мы вообще не возим" —
    // такой же ответ на вопрос о складах, как и "куда возим больше всего".
    const macroRegions = MACRO_REGIONS.map((m) => {
      const done = finishBucket(byMacro.get(m.id) || emptyBucket());
      return {
        id: m.id,
        name: m.name,
        short: m.short,
        oblasts: REGIONS.filter((r) => r.macro === m.id).map((r) => r.short),
        ...done,
        revenueShare: share(done.revenue),
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const unknownBucket = byRegion.get('unknown');

    const deliveryModes = [...byMode.values()]
      .map((m) => ({
        key: m.key,
        label: m.label,
        ...finishBucket(m),
        share: totalsOut.orders > 0 ? (m.orders / totalsOut.orders) * 100 : 0,
      }))
      .sort((a, b) => b.orders - a.orders);

    res.json({
      totals: {
        ...totalsOut,
        expressOrders,
        expressKnown,
        sellerPickupOrders,
        kaspiPickupOrders,
        regionsWithSales,
        regionsTotal: REGIONS.length,
        macroWithSales: macroRegions.filter((m) => m.orders > 0).length,
        macroTotal: MACRO_REGIONS.length,
      },
      macroRegions,
      regions,
      deliveryModes,
      // Заказы, у которых область определить не удалось ничем.
      unknownRegion: unknownBucket ? finishBucket(unknownBucket) : null,
      // Населённые пункты, которые не разобрались ни по подсказке Kaspi, ни по справочнику,
      // ни по координатам — их надо дописать в backend/kzRegions.js.
      unknownPlaces: [...unknownPlaces.entries()]
        .map(([city, orders]) => ({ city, orders }))
        .sort((a, b) => b.orders - a.orders),
      // Диагностика: по какой доле заказов Kaspi отдал нужные поля, плюс контрольная сумма
      // расходов на доставку по Excel-отчёту — она должна сходиться с основной цифрой на той
      // части заказов, где отчёт загружен.
      coverage: {
        orders: rows.length,
        destCity: rows.length > 0 ? destCityKnown / rows.length : 0,
        coords: rows.length > 0 ? coordsKnown / rows.length : 0,
        express: rows.length > 0 ? expressKnown / rows.length : 0,
        deliveryCost: rows.length > 0 ? totalsOut.ordersWithCost / rows.length : 0,
        ordersWithReport,
        reportDeliveryCost: Math.round(reportDeliveryCost),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить географию продаж' });
  }
});

// Диагностический роут: какие поля Kaspi реально кладёт в заказ. Отдаёт только ИМЕНА полей и
// доли заполненности — без самих адресов, чтобы не светить персональные данные покупателей.
router.get('/fields', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT raw_data->'attributes' AS attrs
       FROM orders
       WHERE raw_data IS NOT NULL
       ORDER BY creation_date DESC
       LIMIT 200`
    );
    const attrKeys = new Map();
    const addressKeys = new Map();
    for (const row of result.rows) {
      const attrs = row.attrs || {};
      for (const k of Object.keys(attrs)) attrKeys.set(k, (attrKeys.get(k) || 0) + 1);
      const addr = attrs.deliveryAddress;
      if (addr && typeof addr === 'object') {
        // Считаем только НЕПУСТЫЕ значения: ключи Kaspi присылает всегда, а вот улица и
        // координаты заполнены только у своей доставки.
        for (const [k, v] of Object.entries(addr)) {
          if (v === null || v === undefined || v === '' || v === 0) continue;
          addressKeys.set(k, (addressKeys.get(k) || 0) + 1);
        }
      }
    }
    const toList = (m) => [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
    res.json({ sampled: result.rows.length, attributeKeys: toList(attrKeys), deliveryAddressKeys: toList(addressKeys) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось прочитать поля заказа' });
  }
});

module.exports = router;
