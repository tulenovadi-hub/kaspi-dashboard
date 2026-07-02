const express = require('express');
const axios = require('axios');
const { pool } = require('../db');

const router = express.Router();

const CACHE_TTL_DAYS = 30; // картинки товаров меняются редко — обновляем раз в месяц

async function scrapeImageUrl(masterProductCode) {
  const url = `https://kaspi.kz/shop/p/-${masterProductCode}/`;
  const response = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KaspiDashboardBot/1.0)' },
  });
  const match = response.data.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// Принимает список product_id (ваши коды предложений), возвращает картинку для каждого —
// либо из кэша, либо свежую с публичной страницы kaspi.kz (и сразу кэширует на будущее).
router.post('/', async (req, res) => {
  const { product_ids } = req.body;
  if (!Array.isArray(product_ids) || product_ids.length === 0) {
    return res.status(400).json({ error: 'Нужен непустой список product_ids' });
  }

  try {
    // Узнаём master_product_code для каждого product_id — берём из любой уже синхронизированной позиции заказа
    const codesResult = await pool.query(
      `SELECT DISTINCT ON (product_id) product_id, master_product_code
       FROM order_items
       WHERE product_id = ANY($1::text[]) AND master_product_code IS NOT NULL
       ORDER BY product_id, creation_date DESC`,
      [product_ids]
    );
    const productToCode = new Map(codesResult.rows.map((r) => [r.product_id, r.master_product_code]));

    const cacheResult = await pool.query(
      `SELECT product_id, image_url, updated_at FROM product_images WHERE product_id = ANY($1::text[])`,
      [product_ids]
    );
    const cacheMap = new Map(cacheResult.rows.map((r) => [r.product_id, r]));

    const images = {};
    const toFetch = [];

    for (const productId of product_ids) {
      const cached = cacheMap.get(productId);
      const isFresh = cached && (Date.now() - new Date(cached.updated_at).getTime()) < CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
      if (isFresh) {
        images[productId] = cached.image_url;
      } else if (productToCode.has(productId)) {
        toFetch.push(productId);
      } else {
        images[productId] = cached ? cached.image_url : null;
      }
    }

    await Promise.all(
      toFetch.map(async (productId) => {
        const code = productToCode.get(productId);
        try {
          const imageUrl = await scrapeImageUrl(code);
          images[productId] = imageUrl;
          await pool.query(
            `INSERT INTO product_images (product_id, master_product_code, image_url, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (product_id) DO UPDATE SET
               master_product_code = EXCLUDED.master_product_code,
               image_url = EXCLUDED.image_url,
               updated_at = now()`,
            [productId, code, imageUrl]
          );
        } catch (err) {
          console.error(`Не удалось получить картинку для ${productId} (${code}):`, err.message);
          images[productId] = null;
        }
      })
    );

    res.json({ images });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить картинки товаров' });
  }
});

module.exports = router;
