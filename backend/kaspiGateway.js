const crypto = require('crypto');
const net = require('net');

const TOKEN_PREFIX = 'kgw_live_';
const PROXY_MOUNT_PATH = '/kaspi-proxy/v2';
const VALID_ACCESS_LEVELS = new Set(['read', 'full']);
const READ_METHODS = new Set(['GET', 'HEAD']);
const FULL_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

function hashGatewayToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function generateGatewayToken() {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenHash: hashGatewayToken(token),
    tokenHint: `${token.slice(0, 17)}…${token.slice(-4)}`,
  };
}

function normalizeAllowedIps(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const ips = [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  const invalid = ips.find((ip) => net.isIP(ip) === 0);
  if (invalid) {
    const err = new Error(`Некорректный IP-адрес: ${invalid}`);
    err.statusCode = 400;
    throw err;
  }
  return ips;
}

function normalizeClientIp(value) {
  const ip = String(value || '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function canUseMethod(accessLevel, method) {
  const allowed = accessLevel === 'full' ? FULL_METHODS : READ_METHODS;
  return VALID_ACCESS_LEVELS.has(accessLevel) && allowed.has(String(method || '').toUpperCase());
}

// Возвращает только относительную часть после /kaspi-proxy/v2. Никаких URL от клиента:
// назначение всегда фиксировано на https://kaspi.kz/shop/api/v2, что закрывает SSRF.
function extractKaspiPath(originalUrl) {
  const value = String(originalUrl || '');
  if (!value.startsWith(PROXY_MOUNT_PATH)) {
    const err = new Error('Некорректный путь шлюза');
    err.statusCode = 400;
    throw err;
  }

  const suffix = value.slice(PROXY_MOUNT_PATH.length) || '/';
  const rawPath = suffix.split('?')[0];
  if (
    suffix.length > 8192
    || !rawPath.startsWith('/')
    || rawPath.startsWith('//')
    || rawPath.includes('\\')
    || rawPath.includes('\0')
  ) {
    const err = new Error('Некорректный путь Kaspi API');
    err.statusCode = 400;
    throw err;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch (decodeError) {
    const err = new Error('Некорректная кодировка пути');
    err.statusCode = 400;
    throw err;
  }
  if (decodedPath.split('/').some((part) => part === '..') || decodedPath.includes('\\')) {
    const err = new Error('Переход за пределы Kaspi API запрещён');
    err.statusCode = 400;
    throw err;
  }
  return suffix;
}

module.exports = {
  TOKEN_PREFIX,
  PROXY_MOUNT_PATH,
  VALID_ACCESS_LEVELS,
  hashGatewayToken,
  generateGatewayToken,
  normalizeAllowedIps,
  normalizeClientIp,
  canUseMethod,
  extractKaspiPath,
};
