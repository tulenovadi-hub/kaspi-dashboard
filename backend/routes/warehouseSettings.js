const express = require('express');
const { pool } = require('../db');
const { PICKUP_POINT_PREFIX, WAREHOUSES, loadWarehouses } = require('../warehouseMapping');

const router = express.Router();

const VALID_ROLES = ['main', 'selfbuy'];

// На сайте точка показывается коротко (PP9), в заказах Kaspi она полная (18619047_PP9).
const shortCode = (pickupPointId) => String(pickupPointId).replace(PICKUP_POINT_PREFIX, '');

// Принимает и "PP9", и "pp9", и полный код из заказа. Всё остальное — опечатка: такая точка
// никогда не совпала бы с заказами.
function normalizeCode(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(?:18619047_)?(PP\d+)$/);
  return match ? `${PICKUP_POINT_PREFIX}${match[1]}` : null;
}

router.get('/', async (req, res) => {
  try {
    const counts = await pool.query(
      `SELECT pickup_point_id, COUNT(*)::int AS orders_count
       FROM orders
       WHERE pickup_point_id IS NOT NULL
       GROUP BY pickup_point_id`
    );
    const countByPoint = new Map(counts.rows.map((row) => [row.pickup_point_id, row.orders_count]));
    const known = new Set(WAREHOUSES.map((w) => w.pickupPointId));

    res.json({
      warehouses: WAREHOUSES.map((w) => ({
        code: shortCode(w.pickupPointId),
        city: w.city,
        role: w.role,
        orders_count: countByPoint.get(w.pickupPointId) || 0,
      })),
      // Точки, которые уже встречаются в заказах, но ещё не заведены как склад.
      unknownPoints: counts.rows
        .filter((row) => !known.has(row.pickup_point_id))
        .map((row) => ({ code: shortCode(row.pickup_point_id), orders_count: row.orders_count })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список складов' });
  }
});

router.post('/', async (req, res) => {
  const pickupPointId = normalizeCode(req.body.code);
  const city = String(req.body.city || '').trim();
  if (!pickupPointId) {
    return res.status(400).json({ error: 'Код точки указан неверно, нужен вид PP10' });
  }
  if (!city || city.length > 40) {
    return res.status(400).json({ error: 'Укажите город склада' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO warehouses (pickup_point_id, city, sort_order)
       VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM warehouses))
       ON CONFLICT DO NOTHING`,
      [pickupPointId, city]
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Склад с таким кодом или городом уже есть' });
    }
    // Заказы этой точки могли прийти раньше, чем склад завели: привязываем и их.
    await client.query(`UPDATE orders SET origin_city = $1 WHERE pickup_point_id = $2`, [city, pickupPointId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    return res.status(500).json({ error: 'Не удалось добавить склад' });
  } finally {
    client.release();
  }

  try {
    await loadWarehouses(pool);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Склад добавлен, но не применился — обновите страницу' });
  }
});

router.put('/:code/role', async (req, res) => {
  const pickupPointId = normalizeCode(req.params.code);
  const { role } = req.body;
  if (!pickupPointId || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Некорректный склад или тип' });
  }

  try {
    const updated = await pool.query(`UPDATE warehouses SET role = $1 WHERE pickup_point_id = $2`, [role, pickupPointId]);
    if (updated.rowCount === 0) {
      return res.status(404).json({ error: 'Склад не найден' });
    }
    await loadWarehouses(pool);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сменить тип склада' });
  }
});

module.exports = router;
