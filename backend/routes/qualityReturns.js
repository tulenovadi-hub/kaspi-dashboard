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
    const [summaryResult, returnsResult, productsResult, latestResult, snapshotResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT order_number)::int AS issued_orders
         FROM kaspi_pay_transactions
         WHERE operation_type = 'Покупка' AND operation_date BETWEEN $1 AND $2`,
        [period.start, period.end]
      ),
      pool.query(
        `WITH financial AS (
           SELECT order_number, MIN(operation_date)::text AS return_date,
                  STRING_AGG(DISTINCT NULLIF(product_name, ''), ', ') AS product_name,
                  ABS(SUM(amount)) AS amount
           FROM kaspi_pay_transactions
           WHERE operation_type = 'Возврат' AND operation_date BETWEEN $1 AND $2
           GROUP BY order_number
         ), combined AS (
           SELECT f.order_number, COALESCE(q.return_date::text, f.return_date) AS return_date,
                  COALESCE(q.product_name, f.product_name) AS product_name,
                  COALESCE(q.amount, f.amount) AS amount,
                  COALESCE(q.counts_as_quality, false) AS counts_as_quality,
                  q.reason, q.decision_deadline, (q.order_number IS NOT NULL) AS reviewed,
                  COALESCE(q.is_manual, false) AS is_manual
           FROM financial f
           LEFT JOIN quality_return_overrides q ON q.order_number = f.order_number
           UNION ALL
           SELECT q.order_number, q.return_date::text, q.product_name, q.amount,
                  q.counts_as_quality, q.reason, q.decision_deadline, true, true
           FROM quality_return_overrides q
           WHERE q.is_manual = true AND q.return_date BETWEEN $1 AND $2
             AND NOT EXISTS (SELECT 1 FROM financial f WHERE f.order_number = q.order_number)
         )
         SELECT * FROM combined
         ORDER BY return_date DESC, order_number DESC`,
        [period.start, period.end]
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(product_name, ''), 'Товар не указан') AS product_name,
                COUNT(DISTINCT order_number)::int AS issued_orders
         FROM kaspi_pay_transactions
         WHERE operation_type = 'Покупка' AND operation_date BETWEEN $1 AND $2
         GROUP BY COALESCE(NULLIF(product_name, ''), 'Товар не указан')`,
        [period.start, period.end]
      ),
      pool.query(`SELECT MAX(operation_date)::text AS data_through FROM kaspi_pay_transactions`),
      pool.query(`SELECT period_end::text, issued_orders, updated_at FROM quality_metric_snapshot WHERE id = 1`),
    ]);

    const returns = returnsResult.rows.map((row) => ({
      ...row,
      amount: asNumber(row.amount),
      counts_as_quality: row.counts_as_quality === true,
      reviewed: row.reviewed === true,
      is_manual: row.is_manual === true,
    }));
    const countedReturns = returns.filter((item) => item.counts_as_quality);
    const snapshot = snapshotResult.rows[0] || null;
    const snapshotIsCurrent = snapshot && snapshot.period_end === period.end;
    const issuedOrders = snapshotIsCurrent
      ? asNumber(snapshot.issued_orders)
      : asNumber(summaryResult.rows[0]?.issued_orders);
    const metric = getMetricState(countedReturns.length, issuedOrders);

    const purchasesByProduct = new Map(productsResult.rows.map((row) => [row.product_name, asNumber(row.issued_orders)]));
    const returnsByProduct = new Map();
    for (const item of countedReturns) {
      const name = item.product_name || 'Товар не указан';
      returnsByProduct.set(name, (returnsByProduct.get(name) || 0) + 1);
    }
    const products = Array.from(returnsByProduct, ([productName, qualityReturns]) => {
      const issued = purchasesByProduct.get(productName) || 0;
      return {
        product_name: productName,
        issued_orders: issued,
        quality_returns: qualityReturns,
        rate: issued > 0 ? (qualityReturns / issued) * 100 : 0,
      };
    }).sort((a, b) => b.quality_returns - a.quality_returns || b.rate - a.rate);

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
      data_through: snapshotIsCurrent ? period.end : (latestResult.rows[0]?.data_through || null),
      data_source: snapshotIsCurrent ? 'kaspi_snapshot' : 'kaspi_pay_report',
      snapshot: snapshot ? { period_end: snapshot.period_end, issued_orders: asNumber(snapshot.issued_orders) } : null,
      needs_review: returns.filter((item) => !item.reviewed).length,
      returns,
      expiry_schedule: buildExpirySchedule(countedReturns),
      products,
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

router.post('/', async (req, res) => {
  const orderNumber = String(req.body.order_number || '').trim();
  const returnDate = String(req.body.return_date || '');
  const productName = String(req.body.product_name || '').trim();
  const reason = String(req.body.reason || '').trim();
  const amount = asNumber(req.body.amount);
  if (!/^\d+$/.test(orderNumber)) return res.status(400).json({ error: 'Укажите номер заказа' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) return res.status(400).json({ error: 'Укажите дату возврата' });
  if (!productName) return res.status(400).json({ error: 'Укажите товар' });
  if (!QUALITY_REASONS.includes(reason)) return res.status(400).json({ error: 'Выберите причину Kaspi' });

  try {
    await pool.query(
      `INSERT INTO quality_return_overrides
         (order_number, counts_as_quality, reason, return_date, product_name, amount, is_manual, updated_at)
       VALUES ($1, true, $2, $3, $4, $5, true, now())
       ON CONFLICT (order_number) DO UPDATE SET
         counts_as_quality = true, reason = EXCLUDED.reason, return_date = EXCLUDED.return_date,
         product_name = EXCLUDED.product_name, amount = EXCLUDED.amount,
         is_manual = true, updated_at = now()`,
      [orderNumber, reason, returnDate, productName, amount]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось добавить возврат' });
  }
});

router.put('/metric/snapshot', async (req, res) => {
  const periodEnd = String(req.body.period_end || '');
  const issuedOrders = Number(req.body.issued_orders);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return res.status(400).json({ error: 'Укажите конец периода' });
  if (!Number.isInteger(issuedOrders) || issuedOrders < 0) return res.status(400).json({ error: 'Укажите число выданных заказов' });
  try {
    await pool.query(
      `INSERT INTO quality_metric_snapshot (id, period_end, issued_orders, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET period_end = EXCLUDED.period_end,
         issued_orders = EXCLUDED.issued_orders, updated_at = now()`,
      [periodEnd, issuedOrders]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить показатель Kaspi' });
  }
});

module.exports = router;
