const express = require('express');
const { pool } = require('../db');
const { MAIN_CITIES } = require('../warehouseMapping');

const router = express.Router();

const VALID_STATUSES = ['ACCEPTED_BY_MERCHANT', 'COMPLETED', 'APPROVED_BY_BANK'];

// Ставка налога на упрощёнке — та же, что в отчётах (см. reports.js/stats.js), подтверждена
// декларацией 910.00. НДС при импорте в Казахстане — 12%.
const TAX_RATE_PERCENT = 3;
const VAT_PERCENT = 12;

// Окно, по которому считаем реальные комиссию и доставку. Три месяца — достаточно, чтобы
// сгладить разброс, и достаточно свежо, чтобы отражать текущие условия Kaspi.
const WINDOW_DAYS = 90;

// Значения "по умолчанию" для калькулятора берём не с потолка, а из собственных продаж:
// сколько Kaspi реально забрал комиссии и сколько реально списал за доставку. Всё остальное
// (ставки логистики, схемы ввоза) взять неоткуда — это руками.
router.get('/defaults', async (req, res) => {
  try {
    const [feesResult, ratesResult, productsResult, presetsResult] = await Promise.all([
      // Комиссия и доставка по заказам с загруженным отчётом Kaspi Pay. Обе колонки хранятся
      // отрицательными (это расход) — переворачиваем в плюс.
      pool.query(
        // Сначала схлопываем отчёт Kaspi Pay до одной строки на заказ, и только потом
        // соединяем с заказами: у заказа из двух товаров две строки "Покупка", и без этого
        // количество штук посчиталось бы дважды.
        `WITH kpt_agg AS (
           SELECT order_number,
                  COALESCE(SUM(amount) FILTER (WHERE operation_type = 'Покупка'), 0) AS revenue,
                  -SUM(commission_total) AS commission,
                  -SUM(delivery_cost) AS delivery
           FROM kaspi_pay_transactions
           GROUP BY order_number
         ),
         sold AS (
           SELECT o.code, SUM(oi.quantity) AS units
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           WHERE o.creation_date >= now() - ($1 || ' days')::interval
             AND o.status = ANY($2::text[])
             AND o.origin_city = ANY($3::text[])
           GROUP BY o.code
         )
         SELECT
           COALESCE(SUM(k.revenue), 0) AS revenue,
           COALESCE(SUM(k.commission), 0) AS commission,
           COALESCE(SUM(k.delivery), 0) AS delivery,
           COALESCE(SUM(s.units), 0) AS units,
           COUNT(*) AS orders
         FROM sold s
         JOIN kpt_agg k ON k.order_number = s.code`,
        [String(WINDOW_DAYS), VALID_STATUSES, MAIN_CITIES]
      ),
      // Последний курс, по которому реально платили поставщику и за логистику.
      pool.query(
        `SELECT currency, rate FROM (
           SELECT purchase_currency AS currency, purchase_rate AS rate, received_date, id
           FROM product_batches WHERE purchase_currency IS NOT NULL AND purchase_rate > 0
           UNION ALL
           SELECT logistics_currency AS currency, logistics_rate AS rate, received_date, id
           FROM product_batches WHERE logistics_currency IS NOT NULL AND logistics_rate > 0
         ) t
         ORDER BY received_date DESC, id DESC`
      ),
      // Товары с недавними продажами: цена продажи и последняя партия — чтобы можно было
      // начать расчёт не с нуля, а от реального товара.
      pool.query(
        `WITH recent AS (
           SELECT oi.product_id,
                  MAX(oi.product_name) AS name,
                  SUM(oi.total_price) AS revenue,
                  SUM(oi.quantity) AS quantity
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE oi.creation_date >= now() - ($1 || ' days')::interval
             AND o.status = ANY($2::text[])
             AND o.origin_city = ANY($3::text[])
           GROUP BY oi.product_id
         ),
         last_batch AS (
           SELECT DISTINCT ON (product_id)
             product_id, cost_price, purchase_price, logistics_cost, quantity,
             purchase_currency, purchase_amount_foreign, purchase_rate, extra_expenses,
             logistics_currency, logistics_amount_foreign, logistics_rate
           FROM product_batches
           ORDER BY product_id, received_date DESC, id DESC
         )
         SELECT r.product_id, r.name, r.revenue, r.quantity,
                b.cost_price, b.purchase_price, b.logistics_cost, b.quantity AS batch_quantity,
                b.purchase_currency, b.purchase_amount_foreign, b.purchase_rate, b.extra_expenses,
                b.logistics_currency, b.logistics_amount_foreign, b.logistics_rate
         FROM recent r
         LEFT JOIN last_batch b ON b.product_id = r.product_id
         ORDER BY r.revenue DESC
         LIMIT 30`,
        [String(WINDOW_DAYS), VALID_STATUSES, MAIN_CITIES]
      ),
      // Ранее сохранённые расчёты — отдаём вместе со всем остальным, чтобы страница делала
      // один запрос, а не два.
      pool.query('SELECT product_id, form, updated_at FROM unit_economics_presets'),
    ]);

    const fees = feesResult.rows[0] || {};
    const revenue = Number(fees.revenue) || 0;
    const commission = Number(fees.commission) || 0;
    const delivery = Number(fees.delivery) || 0;
    const units = Number(fees.units) || 0;

    // Последний по времени курс для каждой валюты.
    const rates = {};
    for (const row of ratesResult.rows) {
      if (!rates[row.currency]) rates[row.currency] = Number(row.rate);
    }

    const products = productsResult.rows.map((row) => {
      const batchQuantity = Number(row.batch_quantity) || 0;
      // extra_expenses хранится за ВСЮ партию — приводим к штуке, чтобы подставлять в калькулятор.
      const extras = Array.isArray(row.extra_expenses) ? row.extra_expenses : [];
      const extraTotal = extras.reduce((sum, e) => {
        const amount = Number(e.amount) || 0;
        const rate = Number(e.rate) || 1;
        return sum + amount * (e.currency && e.currency !== 'KZT' ? rate : 1);
      }, 0);
      return {
        productId: row.product_id,
        name: row.name,
        // Средняя цена продажи за штуку по недавним продажам — стартовая цена в калькуляторе.
        sellPrice: Number(row.quantity) > 0 ? Math.round(Number(row.revenue) / Number(row.quantity)) : null,
        purchasePrice: row.purchase_price !== null ? Math.round(Number(row.purchase_price)) : null,
        logisticsPerUnit: row.logistics_cost !== null ? Math.round(Number(row.logistics_cost)) : null,
        costPrice: row.cost_price !== null ? Math.round(Number(row.cost_price)) : null,
        purchaseCurrency: row.purchase_currency,
        purchasePriceForeign:
          row.purchase_amount_foreign !== null && batchQuantity > 0
            ? Number((Number(row.purchase_amount_foreign) / batchQuantity).toFixed(2))
            : null,
        purchaseRate: row.purchase_rate !== null ? Number(row.purchase_rate) : null,
        // Логистика в партии записана суммой за всю партию — приводим к штуке, чтобы в
        // калькуляторе умножить обратно на ЕГО количество, а не на количество той поставки.
        logisticsCurrency: row.logistics_currency,
        logisticsPerUnitForeign:
          row.logistics_amount_foreign !== null && batchQuantity > 0
            ? Number((Number(row.logistics_amount_foreign) / batchQuantity).toFixed(2))
            : null,
        logisticsRate: row.logistics_rate !== null ? Number(row.logistics_rate) : null,
        extraPerUnit: batchQuantity > 0 ? Math.round(extraTotal / batchQuantity) : null,
      };
    });

    res.json({
      taxPercent: TAX_RATE_PERCENT,
      vatPercent: VAT_PERCENT,
      // Комиссия и доставка — не догадки, а факт по собственным продажам за последние 90 дней.
      commissionPercent: revenue > 0 ? Number(((commission / revenue) * 100).toFixed(2)) : null,
      deliveryPerUnit: units > 0 ? Math.round(delivery / units) : null,
      basedOn: {
        days: WINDOW_DAYS,
        orders: Number(fees.orders) || 0,
        units,
        revenue: Math.round(revenue),
      },
      rates,
      products,
      presets: Object.fromEntries(
        presetsResult.rows.map((row) => [row.product_id, { form: row.form, updatedAt: row.updated_at }])
      ),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить данные для калькулятора' });
  }
});

// Сохранить расчёт по конкретному товару. Один товар — одна запись: сохраняем поверх,
// потому что нужен именно последний вариант, а не история попыток.
router.put('/presets/:productId', async (req, res) => {
  const { productId } = req.params;
  const { form, productName } = req.body || {};
  if (!productId || !form || typeof form !== 'object' || Array.isArray(form)) {
    return res.status(400).json({ error: 'Нужны productId и form' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO unit_economics_presets (product_id, product_name, form, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (product_id) DO UPDATE SET
         product_name = EXCLUDED.product_name,
         form = EXCLUDED.form,
         updated_at = now()
       RETURNING updated_at`,
      [productId, productName || null, JSON.stringify(form)]
    );
    res.json({ ok: true, updatedAt: result.rows[0].updated_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить расчёт' });
  }
});

router.delete('/presets/:productId', async (req, res) => {
  try {
    await pool.query('DELETE FROM unit_economics_presets WHERE product_id = $1', [req.params.productId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить расчёт' });
  }
});

module.exports = router;
