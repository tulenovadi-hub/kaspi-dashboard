const express = require('express');
const { pool } = require('../db');
const { MAIN_CITIES, SELF_BUY_CITIES } = require('../warehouseMapping');
const { REGIONS, REGION_BY_ID, resolveRegion, normalizeCity, displayCity } = require('../kzRegions');

const router = express.Router();

// Те же статусы, что на Главной и в Отчёте — чтобы выручка на карте сходилась с выручкой там.
const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// Читаемые названия режимов доставки Kaspi. Значения приходят в attributes.deliveryMode;
// если Kaspi добавит новый режим, он не потеряется — покажем сам код (см. modeLabel).
const DELIVERY_MODE_LABELS = {
  DELIVERY_LOCAL: 'Доставка по городу',
  DELIVERY_REGIONAL_TODOOR: 'Межгород, до двери',
  DELIVERY_REGIONAL_PICKUP: 'Межгород, до пункта выдачи',
  DELIVERY_PICKUP: 'Самовывоз от продавца',
  DELIVERY_POSTOMAT: 'Постомат',
};

function modeLabel(mode, isKaspiDelivery) {
  const base = DELIVERY_MODE_LABELS[mode] || mode || 'Способ не указан';
  // Самовывоз от продавца по определению не бывает "Kaspi доставкой", уточнение там лишнее.
  if (mode === 'DELIVERY_PICKUP' || isKaspiDelivery === null) return base;
  return `${base} (${isKaspiDelivery ? 'Kaspi доставка' : 'своя доставка'})`;
}

// Города отгрузки для режима страницы. 'all' — вообще без фильтра по складу: в него попадают
// и заказы без origin_city (это самовывоз напрямую у продавца, см. backend/routes/warehouse.js),
// которых в остальных режимах не видно.
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
  return { orders: 0, revenue: 0, deliveryCost: 0, ordersWithReport: 0 };
}

function addToBucket(bucket, row) {
  bucket.orders += 1;
  bucket.revenue += Number(row.total_price) || 0;
  if (row.has_report) {
    bucket.ordersWithReport += 1;
    // delivery_cost в Excel-отчёте Kaspi Pay хранится со знаком минус (это расход) —
    // так же, как его читает stats.js. Наружу отдаём положительную сумму расхода.
    bucket.deliveryCost += -(Number(row.delivery_cost) || 0);
  }
}

function finishBucket(bucket) {
  return {
    orders: bucket.orders,
    revenue: Math.round(bucket.revenue),
    avgCheck: bucket.orders > 0 ? Math.round(bucket.revenue / bucket.orders) : 0,
    deliveryCost: Math.round(bucket.deliveryCost),
    ordersWithReport: bucket.ordersWithReport,
    avgDeliveryCost: bucket.ordersWithReport > 0 ? Math.round(bucket.deliveryCost / bucket.ordersWithReport) : null,
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
         -- Куда уехал заказ. Основное поле у Kaspi — deliveryAddress.town, но у части заказов
         -- (постоматы, пункты выдачи) города там может не быть, поэтому есть запасные варианты
         -- и разбор строки адреса уже в JS.
         COALESCE(
           o.raw_data->'attributes'->'deliveryAddress'->>'town',
           o.raw_data->'attributes'->'deliveryAddress'->'city'->>'name',
           CASE WHEN jsonb_typeof(o.raw_data->'attributes'->'deliveryAddress'->'city') = 'string'
                THEN o.raw_data->'attributes'->'deliveryAddress'->>'city' END,
           o.raw_data->'attributes'->'deliveryAddress'->>'district'
         ) AS dest_city,
         o.raw_data->'attributes'->'deliveryAddress'->>'formattedAddress' AS formatted_address,
         kpt.delivery_cost,
         (kpt.order_number IS NOT NULL) AS has_report
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
    let pickupOrders = 0;
    let destCityKnown = 0;

    const byRegion = new Map();
    const byCity = new Map();
    const byMode = new Map();
    const unknownCities = new Map();

    for (const row of rows) {
      addToBucket(totals, row);

      const isKaspiDelivery = row.is_kaspi_delivery === null ? null : row.is_kaspi_delivery === 'true';
      if (row.express !== null) {
        expressKnown += 1;
        if (row.express === 'true') expressOrders += 1;
      }
      if (row.delivery_mode === 'DELIVERY_PICKUP') pickupOrders += 1;

      // --- разрез по способу доставки ---
      const modeKey = `${row.delivery_mode || 'UNKNOWN'}|${isKaspiDelivery}`;
      if (!byMode.has(modeKey)) {
        byMode.set(modeKey, { key: modeKey, label: modeLabel(row.delivery_mode, isKaspiDelivery), ...emptyBucket() });
      }
      addToBucket(byMode.get(modeKey), row);

      // --- разрез по географии ---
      const rawCity = row.dest_city || cityFromFormattedAddress(row.formatted_address);
      if (rawCity) destCityKnown += 1;

      const regionId = resolveRegion(rawCity);
      if (rawCity && !regionId) {
        const key = displayCity(rawCity);
        unknownCities.set(key, (unknownCities.get(key) || 0) + 1);
      }

      const regionKey = regionId || 'unknown';
      if (!byRegion.has(regionKey)) byRegion.set(regionKey, emptyBucket());
      addToBucket(byRegion.get(regionKey), row);

      if (rawCity) {
        const cityKey = normalizeCity(rawCity);
        if (!byCity.has(cityKey)) {
          byCity.set(cityKey, { key: cityKey, city: displayCity(rawCity), regionId, ...emptyBucket() });
        }
        addToBucket(byCity.get(cityKey), row);
      }
    }

    const totalsOut = finishBucket(totals);
    const regionsWithSales = [...byRegion.keys()].filter((k) => k !== 'unknown').length;

    const regions = REGIONS.map((r) => {
      const bucket = byRegion.get(r.id) || emptyBucket();
      const done = finishBucket(bucket);
      return {
        id: r.id,
        name: r.name,
        short: r.short,
        isCity: Boolean(r.isCity),
        ...done,
        revenueShare: totalsOut.revenue > 0 ? (done.revenue / totalsOut.revenue) * 100 : 0,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const unknownBucket = byRegion.get('unknown');

    const citiesOut = [...byCity.values()]
      .map((c) => {
        const done = finishBucket(c);
        return {
          key: c.key,
          city: c.city,
          regionId: c.regionId,
          regionName: c.regionId ? REGION_BY_ID[c.regionId].name : null,
          ...done,
          revenueShare: totalsOut.revenue > 0 ? (done.revenue / totalsOut.revenue) * 100 : 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

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
        pickupOrders,
        regionsWithSales,
        regionsTotal: REGIONS.length,
        citiesCount: citiesOut.length,
      },
      regions,
      cities: citiesOut,
      deliveryModes,
      // Заказы, у которых город доставки не разобрался вообще (нет адреса в raw_data).
      unknownRegion: unknownBucket ? finishBucket(unknownBucket) : null,
      // Города, которых нет в справочнике kzRegions.js — их надо туда дописать, иначе они
      // видны в таблице городов, но не попадают на карту.
      unknownCities: [...unknownCities.entries()]
        .map(([city, orders]) => ({ city, orders }))
        .sort((a, b) => b.orders - a.orders),
      // Диагностика: по какой доле заказов Kaspi вообще отдал нужные поля. Без неё пустая
      // карта выглядела бы как "нет продаж", хотя на деле просто нет адреса в данных.
      coverage: {
        orders: rows.length,
        destCity: rows.length > 0 ? destCityKnown / rows.length : 0,
        express: rows.length > 0 ? expressKnown / rows.length : 0,
        payReport: rows.length > 0 ? totalsOut.ordersWithReport / rows.length : 0,
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
        for (const k of Object.keys(addr)) addressKeys.set(k, (addressKeys.get(k) || 0) + 1);
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
