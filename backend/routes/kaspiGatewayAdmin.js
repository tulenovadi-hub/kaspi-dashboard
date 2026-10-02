const express = require('express');
const { pool } = require('../db');
const {
  VALID_ACCESS_LEVELS,
  generateGatewayToken,
  normalizeAllowedIps,
} = require('../kaspiGateway');

const router = express.Router();

function publicToken(row) {
  return {
    id: row.id,
    name: row.name,
    token_hint: row.token_hint,
    access_level: row.access_level,
    enabled: row.enabled,
    expires_at: row.expires_at,
    rate_limit_per_minute: row.rate_limit_per_minute,
    allowed_ips: row.allowed_ips || [],
    request_count: Number(row.request_count || 0),
    last_used_at: row.last_used_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function gatewayBaseUrl(req) {
  const configured = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  return `${configured || `${req.protocol}://${req.get('host')}`}/kaspi-proxy/v2`;
}

function parseExpiry(days) {
  if (days === null || days === '' || days === undefined) return null;
  const number = Number(days);
  if (!Number.isInteger(number) || number < 1 || number > 3650) {
    const err = new Error('Срок действия должен быть от 1 до 3650 дней');
    err.statusCode = 400;
    throw err;
  }
  return new Date(Date.now() + number * 24 * 60 * 60 * 1000);
}

function validateCreateBody(body) {
  const name = String(body.name || '').trim();
  const accessLevel = String(body.access_level || 'read');
  const rateLimit = Number(body.rate_limit_per_minute || 60);
  if (name.length < 2 || name.length > 80) {
    const err = new Error('Название должно содержать от 2 до 80 символов');
    err.statusCode = 400;
    throw err;
  }
  if (!VALID_ACCESS_LEVELS.has(accessLevel)) {
    const err = new Error('Некорректный уровень доступа');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 1000) {
    const err = new Error('Лимит должен быть от 1 до 1000 запросов в минуту');
    err.statusCode = 400;
    throw err;
  }
  return {
    name,
    accessLevel,
    rateLimit,
    expiresAt: parseExpiry(body.expires_in_days),
    allowedIps: normalizeAllowedIps(body.allowed_ips),
  };
}

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, token_hint, access_level, enabled, expires_at,
             rate_limit_per_minute, allowed_ips, request_count, last_used_at,
             created_by, created_at, updated_at
      FROM kaspi_gateway_tokens
      ORDER BY created_at DESC
    `);
    res.json({ base_url: gatewayBaseUrl(req), tokens: result.rows.map(publicToken) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить токены шлюза' });
  }
});

router.get('/logs', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  try {
    const result = await pool.query(
      `SELECT id, token_id, token_name, method, request_path, status_code,
              duration_ms, client_ip, created_at
       FROM kaspi_gateway_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ logs: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить журнал шлюза' });
  }
});

router.post('/', async (req, res) => {
  try {
    const values = validateCreateBody(req.body || {});
    const generated = generateGatewayToken();
    const result = await pool.query(
      `INSERT INTO kaspi_gateway_tokens
        (name, token_hash, token_hint, access_level, expires_at,
         rate_limit_per_minute, allowed_ips, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, token_hint, access_level, enabled, expires_at,
                 rate_limit_per_minute, allowed_ips, request_count, last_used_at,
                 created_by, created_at, updated_at`,
      [
        values.name,
        generated.tokenHash,
        generated.tokenHint,
        values.accessLevel,
        values.expiresAt,
        values.rateLimit,
        values.allowedIps,
        req.user && req.user.username,
      ]
    );
    res.status(201).json({ token: generated.token, gateway_token: publicToken(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Не удалось создать токен шлюза' });
  }
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Некорректный токен' });

  try {
    const current = await pool.query(`SELECT * FROM kaspi_gateway_tokens WHERE id = $1`, [id]);
    if (current.rowCount === 0) return res.status(404).json({ error: 'Токен не найден' });
    const previous = current.rows[0];

    const name = req.body.name === undefined ? previous.name : String(req.body.name || '').trim();
    const accessLevel = req.body.access_level === undefined ? previous.access_level : String(req.body.access_level);
    const enabled = req.body.enabled === undefined ? previous.enabled : Boolean(req.body.enabled);
    const rateLimit = req.body.rate_limit_per_minute === undefined
      ? Number(previous.rate_limit_per_minute)
      : Number(req.body.rate_limit_per_minute);
    const allowedIps = req.body.allowed_ips === undefined
      ? previous.allowed_ips
      : normalizeAllowedIps(req.body.allowed_ips);
    const expiresAt = req.body.expires_in_days === undefined
      ? previous.expires_at
      : parseExpiry(req.body.expires_in_days);

    validateCreateBody({
      name,
      access_level: accessLevel,
      rate_limit_per_minute: rateLimit,
      allowed_ips: allowedIps,
      expires_in_days: null,
    });

    const result = await pool.query(
      `UPDATE kaspi_gateway_tokens
       SET name = $1, access_level = $2, enabled = $3, expires_at = $4,
           rate_limit_per_minute = $5, allowed_ips = $6, updated_at = now()
       WHERE id = $7
       RETURNING id, name, token_hint, access_level, enabled, expires_at,
                 rate_limit_per_minute, allowed_ips, request_count, last_used_at,
                 created_by, created_at, updated_at`,
      [name, accessLevel, enabled, expiresAt, rateLimit, allowedIps, id]
    );
    res.json({ gateway_token: publicToken(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Не удалось изменить токен шлюза' });
  }
});

router.post('/:id/rotate', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Некорректный токен' });

  try {
    const generated = generateGatewayToken();
    const result = await pool.query(
      `UPDATE kaspi_gateway_tokens
       SET token_hash = $1, token_hint = $2, enabled = true,
           request_window_start = now(), request_window_count = 0, updated_at = now()
       WHERE id = $3
       RETURNING id, name, token_hint, access_level, enabled, expires_at,
                 rate_limit_per_minute, allowed_ips, request_count, last_used_at,
                 created_by, created_at, updated_at`,
      [generated.tokenHash, generated.tokenHint, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Токен не найден' });
    res.json({ token: generated.token, gateway_token: publicToken(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось перевыпустить токен шлюза' });
  }
});

module.exports = router;
