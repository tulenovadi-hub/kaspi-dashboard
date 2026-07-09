const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Принимает пачку данных по расходам на рекламу сразу по нескольким кампаниям —
// именно так их и присылает Tampermonkey-скрипт (обходит все кампании за раз).
// Формат: { campaigns: [ { id, name, days: [{ date, cost }, ...] }, ... ] }
router.post('/upload', async (req, res) => {
  const { campaigns } = req.body;
  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    return res.status(400).json({ error: 'Нужен непустой список campaigns' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let rowsUpserted = 0;

    for (const campaign of campaigns) {
      const campaignId = String(campaign.id || '').trim();
      const campaignName = campaign.name || null;
      const days = Array.isArray(campaign.days) ? campaign.days : [];
      if (!campaignId) continue;

      for (const day of days) {
        if (!day || !day.date) continue;
        await client.query(
          `INSERT INTO ad_expenses (expense_date, campaign_id, campaign_name, cost, uploaded_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (expense_date, campaign_id) DO UPDATE SET
             campaign_name = EXCLUDED.campaign_name,
             cost = EXCLUDED.cost,
             uploaded_at = now()`,
          [day.date, campaignId, campaignName, Number(day.cost) || 0]
        );
        rowsUpserted += 1;
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, campaigns: campaigns.length, days: rowsUpserted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить расходы на рекламу' });
  } finally {
    client.release();
  }
});

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// Данные для дашборда на странице "Маркетинг" — общая сумма за период, разбивка по дням
// (для графика) и по кампаниям (для таблицы).
router.get('/', async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const [byDayResult, byCampaignResult] = await Promise.all([
      pool.query(
        `SELECT to_char(expense_date, 'YYYY-MM-DD') AS day, SUM(cost) AS cost
         FROM ad_expenses
         WHERE expense_date BETWEEN $1 AND $2
         GROUP BY day
         ORDER BY day`,
        [from, to]
      ),
      pool.query(
        `SELECT campaign_id, campaign_name, SUM(cost) AS cost
         FROM ad_expenses
         WHERE expense_date BETWEEN $1 AND $2
         GROUP BY campaign_id, campaign_name
         ORDER BY cost DESC`,
        [from, to]
      ),
    ]);

    const byDay = byDayResult.rows.map((r) => ({ day: r.day, cost: Number(r.cost) }));
    const byCampaign = byCampaignResult.rows.map((r) => ({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      cost: Number(r.cost),
    }));
    const totalCost = byCampaign.reduce((sum, c) => sum + c.cost, 0);

    res.json({ totalCost, byDay, byCampaign });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить данные по рекламным расходам' });
  }
});

// Список кампаний и суммарные расходы по каждой — для отладки/проверки, что данные дошли.
router.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT campaign_id, campaign_name, MIN(expense_date) AS from_date, MAX(expense_date) AS to_date,
              SUM(cost) AS total_cost, COUNT(*) AS days_count
       FROM ad_expenses
       GROUP BY campaign_id, campaign_name
       ORDER BY campaign_name`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить сводку по рекламным расходам' });
  }
});

module.exports = router;
