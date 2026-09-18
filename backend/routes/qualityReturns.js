const express = require('express');
const { pool } = require('../db');
const {
  buildExpirySchedule,
  buildMetricWindow,
  getMetricState,
  getReturnCapacity,
} = require('../qualityReturnsLogic');

const router = express.Router();
const QUALITY_REASONS = [
  'Не как на фото или в описании',
  'Не работает или работает плохо',
  'Подделка',
  'IMEI не верифицирован',
];

function todayInKazakhstan() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

router.get('/', async (req, res) => {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.today || ''))
    ? String(req.query.today)
    : todayInKazakhstan();
  const period = buildMetricWindow(today);

  try {
    const [summaryResult, returnsResult, productsResult, latestResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT order_number)::int AS issued_orders
         FROM kaspi_pay_transactions
         WHERE operation_type = 'Покупка' AND operation_date BETWEEN $1 AND $2`,
        [period.start, period.end]
      ),
      pool.query(
        `SELECT r.order_number, r.return_date, r.product_name, r.amount,
                COALESCE(q.counts_as_quality, true) AS counts_as_quality,
                q.reason, q.decision_deadline, (q.order_number IS NOT NULL) AS reviewed
         FROM (
           SELECT order_number, MIN(operation_date)::text AS return_date,
                  STRING_AGG(DISTINCT NULLIF(product_name, ''), ', ') AS product_name,
                  ABS(SUM(amount)) AS amount
           FROM kaspi_pay_transactions
           WHERE operation_type = 'Возврат' AND operation_date BETWEEN $1 AND $2
           GROUP BY order_number
         ) r
         LEFT JOIN quality_return_overrides q ON q.order_number = r.order_number
         ORDER BY r.return_date DESC, r.order_number DESC`,
        [period.start, period.end]
      ),
      pool.query(
        `WITH purchases AS (
           SELECT order_number, COALESCE(NULLIF(product_name, ''), 'Товар не указан') AS product_name
           FROM kaspi_pay_transactions
           WHERE operation_type = 'Покупка' AND operation_date BETWEEN $1 AND $2
           GROUP BY order_number, COALESCE(NULLIF(product_name, ''), 'Товар не указан')
         ), returns AS (
           SELECT k.order_number, COALESCE(NULLIF(k.product_name, ''), 'Товар не указан') AS product_name
           FROM kaspi_pay_transactions k
           LEFT JOIN quality_return_overrides q ON q.order_number = k.order_number
           WHERE k.operation_type = 'Возврат' AND k.operation_date BETWEEN $1 AND $2
             AND COALESCE(q.counts_as_quality, true) = true
           GROUP BY k.order_number, COALESCE(NULLIF(k.product_name, ''), 'Товар не указан')
         )
         SELECT p.product_name, COUNT(DISTINCT p.order_number)::int AS issued_orders,
                COUNT(DISTINCT r.order_number)::int AS quality_returns
         FROM purchases p
         LEFT JOIN returns r ON r.order_number = p.order_number AND r.product_name = p.product_name
         GROUP BY p.product_name
         HAVING COUNT(DISTINCT r.order_number) > 0
         ORDER BY quality_returns DESC, issued_orders DESC, p.product_name`,
        [period.start, period.end]
      ),
      pool.query(`SELECT MAX(operation_date)::text AS data_through FROM kaspi_pay_transactions`),
    ]);

    const returns = returnsResult.rows.map((row) => ({
      ...row,
      amount: asNumber(row.amount),
      counts_as_quality: row.counts_as_quality === true,
      reviewed: row.reviewed === true,
    }));
    const countedReturns = returns.filter((item) => item.counts_as_quality);
    const issuedOrders = asNumber(summaryResult.rows[0]?.issued_orders);
    const metric = getMetricState(countedReturns.length, issuedOrders);

    res.json({
      period,
      rules: {
        limit_percent: 2,
        reasons: QUALITY_REASONS,
        decision_note: 'Решение принимайте сразу после проверки и обязательно до срока в заявке Kaspi.',
      },
      summary: {
        issued_orders: issuedOrders,
        quality_returns: countedReturns.length,
        rate: metric.rate,
        state: metric.key,
        state_label: metric.label,
        capacity: getReturnCapacity(countedReturns.length, issuedOrders),
        projected_rate_one_more: issuedOrders > 0 ? ((countedReturns.length + 1) / issuedOrders) * 100 : 0,
      },
      data_through: latestResult.rows[0]?.data_through || null,
      returns,
      expiry_schedule: buildExpirySchedule(countedReturns),
      products: productsResult.rows.map((row) => ({
        product_name: row.product_name,
        issued_orders: asNumber(row.issued_orders),
        quality_returns: asNumber(row.quality_returns),
        rate: asNumber(row.issued_orders) > 0
          ? (asNumber(row.quality_returns) / asNumber(row.issued_orders)) * 100
          : 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось рассчитать возвраты по качеству' });
  }
});

router.put('/:orderNumber', async (req, res) => {
  const orderNumber = String(req.params.orderNumber || '').trim();
  if (!orderNumber) return res.status(400).json({ error: 'Номер заказа не указан' });

  const countsAsQuality = req.body.counts_as_quality !== false;
  const reason = req.body.reason ? String(req.body.reason).trim() : null;
  const decisionDeadline = req.body.decision_deadline || null;
  if (reason && !QUALITY_REASONS.includes(reason)) {
    return res.status(400).json({ error: 'Неизвестная причина возврата' });
  }
  if (decisionDeadline && !/^\d{4}-\d{2}-\d{2}$/.test(String(decisionDeadline))) {
    return res.status(400).json({ error: 'Неверная дата срока решения' });
  }

  try {
    await pool.query(
      `INSERT INTO quality_return_overrides
         (order_number, counts_as_quality, reason, decision_deadline, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (order_number) DO UPDATE SET
         counts_as_quality = EXCLUDED.counts_as_quality,
         reason = EXCLUDED.reason,
         decision_deadline = EXCLUDED.decision_deadline,
         updated_at = now()`,
      [orderNumber, countsAsQuality, reason, decisionDeadline]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить проверку возврата' });
  }
});

module.exports = router;
