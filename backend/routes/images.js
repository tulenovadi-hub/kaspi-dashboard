const express = require('express');
const multer = require('multer');
const { pool } = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } }); // 4 МБ хватает с запасом на сжатую с фронтенда картинку

// Возвращает картинки товаров по списку product_id — только то, что загружено вручную
// на странице "Склад" (автоматического скрейпинга с kaspi.kz больше нет: он был медленным
// и не нужен, раз картинки всё равно загружают руками).
router.post('/', async (req, res) => {
  const { product_ids } = req.body;
  if (!Array.isArray(product_ids) || product_ids.length === 0) {
    return res.status(400).json({ error: 'Нужен непустой список product_ids' });
  }

  try {
    const cacheResult = await pool.query(
      `SELECT product_id, image_url FROM product_images WHERE product_id = ANY($1::text[])`,
      [product_ids]
    );
    const images = {};
    for (const productId of product_ids) {
      images[productId] = null;
    }
    for (const row of cacheResult.rows) {
      images[row.product_id] = row.image_url;
    }
    res.json({ images });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить картинки товаров' });
  }
});

// Ручная загрузка картинки товара (кнопка на странице "Склад") — сохраняем файл прямо
// в базу как data URL (в этом проекте нет отдельного файлового хранилища, а картинки
// небольшие — фронтенд сжимает их перед отправкой).
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

// Удалить вручную загруженную картинку товара.
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
