const express = require('express');
const axios = require('axios');
const multer = require('multer');
const { pool } = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } }); // 4 МБ хватает с запасом на сжатую с фронтенда картинку

const CACHE_TTL_DAYS = 30; // картинки товаров меняются редко — обновляем раз в месяц
const REQUEST_DELAY_MS = 600; // пауза между запросами к kaspi.kz, чтобы не словить 429
const MAX_RETRIES = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeImageUrl(masterProductCode) {
  const url = `https://kaspi.kz/shop/p/-${masterProductCode}/`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KaspiDashboardBot/1.0)' },
      });
      const match = response.data.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      return match ? match[1] : null;
    } catch (err) {
      const status = err.response ? err.response.status : null;
      if (status === 429 && attempt < MAX_RETRIES) {
        // Слишком много запросов — ждём подольше и пробуем ещё раз
        await sleep(REQUEST_DELAY_MS * (attempt + 3));
        continue;
      }
      throw err;
    }
  }
  return null;
}

// Принимает список product_id (ваши коды предложений), возвращает картинку для каждого —
// сразу из кэша (даже если он "подсох" дольше CACHE_TTL_DAYS — лучше показать старую картинку
// сразу, чем ничего не показывать 20 секунд). Устаревшие картинки обновляются в фоне отдельным
// запросом к kaspi.kz — это не блокирует ответ странице "Склад".
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
      `SELECT product_id, image_url, is_manual, updated_at FROM product_images WHERE product_id = ANY($1::text[])`,
      [product_ids]
    );
    const cacheMap = new Map(cacheResult.rows.map((r) => [r.product_id, r]));

    const images = {};
    const toRefresh = [];

    for (const productId of product_ids) {
      const cached = cacheMap.get(productId);
      // Картинку, загруженную вручную, никогда не трогаем автоскрейпингом — она "вечно свежая",
      // пока пользователь сам её не заменит или не удалит.
      const isStale = !cached || (!cached.is_manual && (Date.now() - new Date(cached.updated_at).getTime()) >= CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

      // Отдаём то, что есть прямо сейчас (даже подсохшее) — не ждём похода на kaspi.kz
      images[productId] = cached ? cached.image_url : null;

      if (isStale && productToCode.has(productId)) {
        toRefresh.push(productId);
      }
    }

    res.json({ images });

    // Дальше — уже после ответа пользователю: обновляем устаревшие/отсутствующие картинки
    // в фоне. Следующая загрузка страницы "Склад" их подхватит из кэша.
    if (toRefresh.length > 0) {
      refreshImagesInBackground(toRefresh, productToCode).catch((err) => {
        console.error('Фоновое обновление картинок товаров упало:', err);
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить картинки товаров' });
  }
});

async function refreshImagesInBackground(productIds, productToCode) {
  for (const productId of productIds) {
    const code = productToCode.get(productId);
    try {
      const imageUrl = await scrapeImageUrl(code);
      await pool.query(
        `INSERT INTO product_images (product_id, master_product_code, image_url, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (product_id) DO UPDATE SET
           master_product_code = EXCLUDED.master_product_code,
           image_url = EXCLUDED.image_url,
           updated_at = now()
         WHERE product_images.is_manual = false`,
        [productId, code, imageUrl]
      );
    } catch (err) {
      console.error(`Не удалось получить картинку для ${productId} (${code}):`, err.message);
    }
    await sleep(REQUEST_DELAY_MS);
  }
}

// Ручная загрузка картинки товара (кнопка на странице "Склад") — сохраняем файл прямо
// в базу как data URL (в этом проекте нет отдельного файлового хранилища, а картинки
// небольшие — фронтенд сжимает их перед отправкой). is_manual = true защищает картинку
// от перезаписи автоскрейпингом с kaspi.kz.
router.post('/upload', upload.single('image'), async (req, res) => {
  const productId = req.body && req.body.product_id;
  if (!productId) {
    return res.status(400).json({ error: 'Не передан product_id' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Файл картинки не найден' });
  }
  if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Можно загружать только изображения' });
  }

  try {
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await pool.query(
      `INSERT INTO product_images (product_id, image_url, is_manual, updated_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (product_id) DO UPDATE SET
         image_url = EXCLUDED.image_url,
         is_manual = true,
         updated_at = now()`,
      [productId, dataUrl]
    );
    res.json({ ok: true, image_url: dataUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить картинку' });
  }
});

// Удалить вручную загруженную картинку — товар вернётся к автоматической картинке с kaspi.kz
// при следующей загрузке страницы "Склад".
router.delete('/:productId', async (req, res) => {
  try {
    await pool.query(`DELETE FROM product_images WHERE product_id = $1`, [req.params.productId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить картинку' });
  }
});

module.exports = router;
