const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Принимает пачку данных по расходам на "Бонусы от продавца" сразу по нескольким кампаниям —
// присылает Tampermonkey-скрипт со страницы marketing.kaspi.kz/bonuses. Формат:
// { campaigns: [ { id, name, days: [{date, bonusAmount, views, clicks, favorites, carts,
//   transactions, gmv}], product_ids: [...] }, ... ] }
// product_ids — offerCode товаров (= ваш product_id), для привязки кампании к товару.
//
// Все поля дня, кроме даты, необязательны — старая версия скрипта присылала только bonusAmount,
// и она обязана продолжать работать. Отсюда COALESCE ниже: отсутствующее поле приходит как null
// и НЕ затирает уже сохранённое значение нулём. Без этого одна выгрузка старым скриптом стёрла
// бы всю воронку за те же дни.
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
        // undefined → null: значит "в этой выгрузке метрики не было", и старое значение уцелеет.
        const metric = (value) => (value === undefined || value === null ? null : Number(value) || 0);
        await client.query(
          `INSERT INTO bonus_expenses (
             expense_date, campaign_id, campaign_name, bonus_amount,
             views, clicks, favorites, carts, transactions, gmv, uploaded_at
           )
           VALUES ($1, $2, $3, $4,
             COALESCE($5, 0), COALESCE($6, 0), COALESCE($7, 0), COALESCE($8, 0), COALESCE($9, 0), COALESCE($10, 0),
             now())
           ON CONFLICT (expense_date, campaign_id) DO UPDATE SET
             campaign_name = EXCLUDED.campaign_name,
             bonus_amount = EXCLUDED.bonus_amount,
             views = COALESCE($5, bonus_expenses.views),
             clicks = COALESCE($6, bonus_expenses.clicks),
             favorites = COALESCE($7, bonus_expenses.favorites),
             carts = COALESCE($8, bonus_expenses.carts),
             transactions = COALESCE($9, bonus_expenses.transactions),
             gmv = COALESCE($10, bonus_expenses.gmv),
             uploaded_at = now()`,
          [
            day.date, campaignId, campaignName, Number(day.bonusAmount) || 0,
            metric(day.views), metric(day.clicks), metric(day.favorites),
            metric(day.carts), metric(day.transactions), metric(day.gmv),
          ]
        );
        rowsUpserted += 1;
      }

      // Привязку товаров к кампании держим свежей — стираем старую и записываем то, что
      // прислали сейчас (набор товаров в акции может со временем меняться).
      await client.query(`DELETE FROM bonus_campaign_products WHERE campaign_id = $1`, [campaignId]);
      for (const productId of productIds) {
        await client.query(
          `INSERT INTO bonus_campaign_products (campaign_id, product_id, updated_at)
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
    res.status(500).json({ error: 'Не удалось сохранить расходы на бонусы' });
  } finally {
    client.release();
  }
});

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// Данные для страницы "Бонусы от продавца" — сумма за период, разбивка по дням (для графика)
// и по кампаниям (для таблицы, вместе с привязанными товарами). Если передан campaign_id —
// всё считается только по этой одной кампании.
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
        `SELECT to_char(expense_date, 'YYYY-MM-DD') AS day, SUM(bonus_amount) AS cost
         FROM bonus_expenses
         WHERE expense_date BETWEEN $1 AND $2 ${campaignFilter}
         GROUP BY day
         ORDER BY day`,
        params
      ),
      pool.query(
        `SELECT campaign_id, campaign_name,
                SUM(bonus_amount) AS cost,
                SUM(views) AS views, SUM(clicks) AS clicks, SUM(favorites) AS favorites,
                SUM(carts) AS carts, SUM(transactions) AS transactions, SUM(gmv) AS gmv
         FROM bonus_expenses
         WHERE expense_date BETWEEN $1 AND $2 ${campaignFilter}
         GROUP BY campaign_id, campaign_name
         ORDER BY cost DESC`,
        params
      ),
      pool.query(`SELECT campaign_id, product_id FROM bonus_campaign_products`),
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
      views: Number(r.views),
      clicks: Number(r.clicks),
      favorites: Number(r.favorites),
      carts: Number(r.carts),
      transactions: Number(r.transactions),
      gmv: Number(r.gmv),
      product_ids: productIdsByCampaign.get(r.campaign_id) || [],
    }));
    const sum = (key) => byCampaign.reduce((acc, c) => acc + c[key], 0);
    const totalCost = sum('cost');

    // totals отдаём отдельно от byCampaign, чтобы фронтенду не пересчитывать. Для "Бонусов за
    // отзыв" (та же страница, другой источник) этих метрик нет — там всё придёт нулями, и
    // страница просто не покажет соответствующий блок.
    res.json({
      totalCost,
      totals: {
        views: sum('views'),
        clicks: sum('clicks'),
        favorites: sum('favorites'),
        carts: sum('carts'),
        transactions: sum('transactions'),
        gmv: sum('gmv'),
      },
      byDay,
      byCampaign,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить данные по бонусам' });
  }
});

module.exports = router;
