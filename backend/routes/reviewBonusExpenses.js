const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// "Бонусы за отзыв" — тот же принцип, что и bonus-expenses (только расход по дням/кампаниям,
// без выручки), просто другая программа Kaspi и без привязки к товару.
// Формат: { campaigns: [ { id, name, days: [{date, bonusAmount, notifications, reviews}] }, ... ] }
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
          `INSERT INTO review_bonus_expenses (expense_date, campaign_id, campaign_name, bonus_amount, notifications, reviews, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (expense_date, campaign_id) DO UPDATE SET
             campaign_name = EXCLUDED.campaign_name,
             bonus_amount = EXCLUDED.bonus_amount,
             notifications = EXCLUDED.notifications,
             reviews = EXCLUDED.reviews,
             uploaded_at = now()`,
          [day.date, campaignId, campaignName, Number(day.bonusAmount) || 0, Number(day.notifications) || 0, Number(day.reviews) || 0]
        );
        rowsUpserted += 1;
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, campaigns: campaigns.length, days: rowsUpserted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить расходы на бонусы за отзыв' });
  } finally {
    client.release();
  }
});

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

router.get('/', async (req, res) => {
  const { from, to, campaign_id: campaignId } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const params = campaignId ? [from, to, campaignId] : [from, to];
    const campaignFilter = campaignId ? 'AND campaign_id = $3' : '';

    const [byDayResult, byCampaignResult] = await Promise.all([
      pool.query(
        `SELECT to_char(expense_date, 'YYYY-MM-DD') AS day, SUM(bonus_amount) AS cost
         FROM review_bonus_expenses
         WHERE expense_date BETWEEN $1 AND $2 ${campaignFilter}
         GROUP BY day
         ORDER BY day`,
        params
      ),
      pool.query(
        `SELECT campaign_id, campaign_name, SUM(bonus_amount) AS cost
         FROM review_bonus_expenses
         WHERE expense_date BETWEEN $1 AND $2 ${campaignFilter}
         GROUP BY campaign_id, campaign_name
         ORDER BY cost DESC`,
        params
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
    res.status(500).json({ error: 'Не удалось получить данные по бонусам за отзыв' });
  }
});

module.exports = router;
