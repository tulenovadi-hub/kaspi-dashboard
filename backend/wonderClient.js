// wonderClient.js — интеграция с partner-платформой Wonder (fulfillment-центр, который
// принимает и хранит возвраты/отмены). Логинимся по email/паролю продавца (WONDER_EMAIL,
// WONDER_PASSWORD в переменных окружения) и получаем свежий access-токен на каждый вызов —
// сессионные токены Wonder живут всего около 10 часов, поэтому хранить один и тот же токен
// в конфиге смысла нет.
const axios = require('axios');

const BASE_URL = 'https://api.d.wonder-fulfillment.kz/api';
const STATUSES = ['REQUEST', 'WAITING', 'ACTIVE', 'ARCHIVE'];

async function login() {
  const username = process.env.WONDER_EMAIL;
  const password = process.env.WONDER_PASSWORD;
  if (!username || !password) return null;

  const response = await axios.post(
    `${BASE_URL}/auth/login/`,
    { username, password },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return response.data.access;
}

// Возвращает Set номеров заказов (order_code), которые есть у Wonder в любом из статусов —
// значит, склад партнёра их так или иначе зарегистрировал/принял.
async function fetchAllWonderOrderCodes() {
  const token = await login();
  if (!token) return null;

  const http = axios.create({
    baseURL: BASE_URL,
    headers: { authorization: `Bearer ${token}` },
    timeout: 30000,
  });

  const codes = new Set();
  for (const status of STATUSES) {
    const response = await http.get('/refund-order-groups/seller/', {
      params: { page: 0, size: 500, status },
    });
    for (const item of response.data.content || []) {
      codes.add(item.order_code);
    }
  }
  return codes;
}

module.exports = { fetchAllWonderOrderCodes };
