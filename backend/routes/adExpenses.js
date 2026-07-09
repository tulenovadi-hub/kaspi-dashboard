const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Принимает пачку данных по расходам на рекламу сразу по нескольким кампаниям —
// именно так их и присылает Tampermonkey-скрипт (обходит все кампании за раз).
// Формат: { campaigns: [ { id, name, days: [{ date, cost }, ...], product_ids: [...] }, ... ] }
// product_ids — это merchantSku товаров в этой кампании (= ваш собственный product_id,
// тот же самый, что используется везде в дашборде) — нужен для точной привязки кампании
// к товару вместо угадывания по названию.
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
      const productIds = Array.isArray(campaign.product_ids)
        ? campaign.product_ids.map((id) => String(id).trim()).filter(Boolean)
        : [];
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

      // Привязку товаров к кампании держим свежей — стираем старую и записываем то, что
      // прислали сейчас (список товаров в кампании может со временем меняться в Kaspi).
      await client.query(`DELETE FROM ad_campaign_products WHERE campaign_id = $1`, [campaignId]);
      for (const productId of productIds) {
        await client.query(
          `INSERT INTO ad_campaign_products (campaign_id, product_id, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (campaign_id, product_id) DO UPDATE SET updated_at = now()`,
          [campaignId, productId]
        );
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
// (для графика) и по кампаниям (для таблицы, вместе с привязанными к ним товарами).
// Если передан campaign_id — всё считается только по этой одной кампании (для дашборда
// конкретного товара).
router.get('/', async (req, res) => {
  const { from, to, campaign_id: campaignId } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ error: 'Параметры from и to обязательны, формат: YYYY-MM-DD' });
  }

  try {
    const params = campaignId ? [from, to, campaignId] : [from, to];
    const campaignFilter = campaignId ? 'AND campaign_id = $3' : '';

    const [byDayResult, byCampaignResult, productsResult] = await Promise.all([
      pool.query(
        `SELECT to_char(expense_date, 'YYYY-MM-DD') AS day, SUM(cost) AS cost
         FROM ad_expenses
         WHERE expense_date BETWEEN $1 AND $2 ${campaignFilter}
         GROUP BY day
         ORDER BY day`,
        params
      ),
      pool.query(
        `SELECT campaign_id, campaign_name, SUM(cost) AS cost
         FROM ad_expenses
         WHERE expense_date BETWEEN $1 AND $2 ${campaignFilter}
         GROUP BY campaign_id, campaign_name
         ORDER BY cost DESC`,
        params
      ),
      pool.query(`SELECT campaign_id, product_id FROM ad_campaign_products`),
    ]);

    const productIdsByCampaign = new Map();
    for (const row of productsResult.rows) {
      if (!productIdsByCampaign.has(row.campaign_id)) productIdsByCampaign.set(row.campaign_id, []);
      productIdsByCampaign.get(row.campaign_id).push(row.product_id);
    }

    const byDay = byDayResult.rows.map((r) => ({ day: r.day, cost: Number(r.cost) }));
    const byCampaign = byCampaignResult.rows.map((r) => ({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      cost: Number(r.cost),
      product_ids: productIdsByCampaign.get(r.campaign_id) || [],
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
