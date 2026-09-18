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
    let page = 0;
    while (true) {
      const response = await http.get('/refund-order-groups/seller/', {
        params: { page, size: 500, status },
      });
      const content = response.data.content || [];
      for (const item of content) {
        if (item.order_code !== null && item.order_code !== undefined) {
          codes.add(String(item.order_code));
        }
      }

      // API Wonder обычно отдаёт last/totalPages. Проверка длины остаётся запасным вариантом,
      // чтобы не потерять заказы, если формат пагинации изменится.
      const totalPages = Number(response.data.totalPages);
      const isLast = response.data.last === true ||
        (Number.isFinite(totalPages) && page + 1 >= totalPages) ||
        content.length < 500;
      if (isLast) break;
      page += 1;
    }
  }
  return codes;
}

module.exports = { fetchAllWonderOrderCodes };
