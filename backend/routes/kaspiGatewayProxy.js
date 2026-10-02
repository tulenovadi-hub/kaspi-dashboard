const express = require('express');
const { pool } = require('../db');
const { proxyKaspiRequest } = require('../kaspiClient');
const {
  hashGatewayToken,
  normalizeClientIp,
  canUseMethod,
  extractKaspiPath,
} = require('../kaspiGateway');

const router = express.Router();
const RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified', 'retry-after', 'location'];

async function writeLog({ token, method, path, statusCode, durationMs, clientIp }) {
  try {
    await pool.query(
      `INSERT INTO kaspi_gateway_logs
        (token_id, token_name, method, request_path, status_code, duration_ms, client_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token.id, token.name, method, path, statusCode, durationMs, clientIp || null]
    );
  } catch (err) {
    console.error('Не удалось записать журнал Kaspi API шлюза:', err);
  }
}

async function consumeRateLimit(tokenId) {
  return pool.query(
    `UPDATE kaspi_gateway_tokens
     SET request_window_start = CASE
           WHEN request_window_start <= now() - interval '1 minute' THEN now()
           ELSE request_window_start
         END,
         request_window_count = CASE
           WHEN request_window_start <= now() - interval '1 minute' THEN 1
           ELSE request_window_count + 1
         END,
         request_count = request_count + 1,
         last_used_at = now(),
         updated_at = now()
     WHERE id = $1
       AND (
         request_window_start <= now() - interval '1 minute'
         OR request_window_count < rate_limit_per_minute
       )
     RETURNING id`,
    [tokenId]
  );
}

router.all('/v2/*', async (req, res) => {
  const startedAt = Date.now();
  const suppliedToken = String(req.header('X-Auth-Token') || '').trim();
  if (!suppliedToken) return res.status(401).json({ error: 'Не передан X-Auth-Token шлюза' });

  let token;
  let kaspiPath;
  let clientIp;
  try {
    kaspiPath = extractKaspiPath(req.originalUrl);
    clientIp = normalizeClientIp(req.ip);

    const result = await pool.query(
      `SELECT id, name, access_level, enabled, expires_at,
              rate_limit_per_minute, allowed_ips
       FROM kaspi_gateway_tokens
       WHERE token_hash = $1`,
      [hashGatewayToken(suppliedToken)]
    );
    if (result.rowCount === 0) return res.status(401).json({ error: 'Недействительный токен шлюза' });
    token = result.rows[0];

    const rejectKnownToken = async (statusCode, message, extraHeaders = {}) => {
      Object.entries(extraHeaders).forEach(([name, value]) => res.set(name, value));
      await writeLog({
        token,
        method: req.method,
        path: kaspiPath,
        statusCode,
        durationMs: Date.now() - startedAt,
        clientIp,
      });
      return res.status(statusCode).json({ error: message });
    };

    if (!token.enabled) return rejectKnownToken(401, 'Токен шлюза отключён');
    if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) {
      return rejectKnownToken(401, 'Срок действия токена шлюза истёк');
    }
    if ((token.allowed_ips || []).length > 0 && !token.allowed_ips.includes(clientIp)) {
      return rejectKnownToken(403, 'IP-адрес не разрешён для этого токена');
    }
    if (!canUseMethod(token.access_level, req.method)) {
      return rejectKnownToken(403, 'Токен разрешает только чтение данных');
    }

    const consumed = await consumeRateLimit(token.id);
    if (consumed.rowCount === 0) {
      return rejectKnownToken(429, 'Превышен лимит запросов для токена', { 'Retry-After': '60' });
    }

    const upstream = await proxyKaspiRequest(req.method, kaspiPath, req.body);
    RESPONSE_HEADERS.forEach((header) => {
      if (upstream.headers && upstream.headers[header]) res.set(header, upstream.headers[header]);
    });
    await writeLog({
      token,
      method: req.method,
      path: kaspiPath,
      statusCode: upstream.status,
      durationMs: Date.now() - startedAt,
      clientIp,
    });
    return res.status(upstream.status).send(upstream.data);
  } catch (err) {
    const statusCode = err.statusCode || (err.code === 'ECONNABORTED' ? 504 : 502);
    if (token) {
      await writeLog({
        token,
        method: req.method,
        path: kaspiPath || req.originalUrl,
        statusCode,
        durationMs: Date.now() - startedAt,
        clientIp,
      });
    }
    console.error('Ошибка Kaspi API шлюза:', err.message);
    return res.status(statusCode).json({
      error: err.statusCode ? err.message : 'Kaspi API временно не ответил',
    });
  }
});

router.all('/v2', (req, res) => {
  res.status(400).json({ error: 'Добавьте путь Kaspi API, например /orders' });
});

module.exports = router;
