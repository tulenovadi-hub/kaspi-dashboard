// api.js — все обращения к backend сосредоточены здесь

// На хостинге адрес backend будет другим, чем у фронтенда — он задаётся через переменную
// окружения VITE_API_URL при сборке (см. инструкцию DEPLOY.md). Для локальной разработки
// используется адрес локального сервера по умолчанию.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Таймаут на КАЖДЫЙ запрос. Без него подвисший мобильный запрос (сеть переключилась с Wi-Fi
// на мобильную, соединение оборвалось без явной ошибки) висит бесконечно: промис не резолвится
// и не реджектится, поэтому `.finally()` в форме никогда не выполняется — кнопка навсегда
// остаётся заблокированной в состоянии "Сохраняем...", и выйти из этого можно только полным
// перезапуском приложения. Лучше честно упасть с понятной ошибкой и дать повторить.
const DEFAULT_TIMEOUT_MS = 45000; // с запасом на "просыпание" Render после простоя (~30 с)
const LONG_TIMEOUT_MS = 5 * 60 * 1000; // синхронизации, загрузка Excel, генерация AI-отчёта

async function apiRequest(path, token, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  // Таймер снимаем только после того, как тело ответа полностью прочитано (см. finally) —
  // зависнуть можно не только в ожидании заголовков, но и на середине чтения ответа.
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        ...fetchOptions.headers,
        'X-Session-Token': token,
      },
    });

    if (response.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    if (response.status === 403) {
      throw new Error('Недостаточно прав для этого действия');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Ошибка запроса к серверу');
    }

    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Сервер не ответил вовремя — проверьте интернет и попробуйте ещё раз');
    }
    // fetch отклоняется с TypeError на любых сетевых сбоях (нет соединения, DNS, CORS) —
    // сообщение у него техническое ("Load failed"), заменяем на понятное человеку.
    if (err instanceof TypeError) {
      throw new Error('Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function login(username, password) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || 'Не удалось войти');
    }
    return body; // { token, username, role }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Сервер не ответил вовремя — проверьте интернет и попробуйте ещё раз');
    }
    if (err instanceof TypeError) {
      throw new Error('Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function logout(token) {
  return apiRequest('/api/auth/logout', token, { method: 'POST' });
}

export function fetchMe(token) {
  return apiRequest('/api/auth/me', token);
}

export function fetchUsers(token) {
  return apiRequest('/api/users', token);
}

export function createUser(token, user) {
  return apiRequest('/api/users', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  });
}

export function updateUser(token, id, updates) {
  return apiRequest(`/api/users/${id}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export function deleteUser(token, id) {
  return apiRequest(`/api/users/${id}`, token, { method: 'DELETE' });
}

export function fetchSummary(password, from, to, mode = 'main') {
  return apiRequest(`/api/stats/summary?from=${from}&to=${to}&mode=${mode}`, password);
}

export function fetchProducts(password, from, to, mode = 'main') {
  return apiRequest(`/api/stats/products?from=${from}&to=${to}&mode=${mode}`, password);
}

export function fetchSummaryProfit(password, from, to, mode = 'main') {
  return apiRequest(`/api/stats/summary-profit?from=${from}&to=${to}&mode=${mode}`, password);
}

export function fetchAdExpenses(password, from, to, campaignId) {
  const campaignParam = campaignId ? `&campaign_id=${encodeURIComponent(campaignId)}` : '';
  return apiRequest(`/api/ad-expenses?from=${from}&to=${to}${campaignParam}`, password);
}

export function fetchBonusExpenses(password, from, to, campaignId) {
  const campaignParam = campaignId ? `&campaign_id=${encodeURIComponent(campaignId)}` : '';
  return apiRequest(`/api/bonus-expenses?from=${from}&to=${to}${campaignParam}`, password);
}

export function fetchReviewBonusExpenses(password, from, to, campaignId) {
  const campaignParam = campaignId ? `&campaign_id=${encodeURIComponent(campaignId)}` : '';
  return apiRequest(`/api/review-bonus-expenses?from=${from}&to=${to}${campaignParam}`, password);
}

export function fetchAnalystReport(password, from, to) {
  return apiRequest(`/api/analyst/report?from=${from}&to=${to}`, password, { timeoutMs: LONG_TIMEOUT_MS });
}

export function fetchAnalystReportsList(password) {
  return apiRequest('/api/analyst/reports', password);
}

export function fetchAnalystReportById(password, id) {
  return apiRequest(`/api/analyst/reports/${id}`, password);
}

export function deleteAnalystReport(password, id) {
  return apiRequest(`/api/analyst/reports/${id}`, password, { method: 'DELETE' });
}

export function fetchProductStats(password, productId, from, to, mode = 'main') {
  return apiRequest(`/api/stats/product/${encodeURIComponent(productId)}?from=${from}&to=${to}&mode=${mode}`, password);
}

export function triggerSync(password) {
  return apiRequest('/api/sync', password, { method: 'POST', timeoutMs: LONG_TIMEOUT_MS });
}

export function fetchBatchProducts(password) {
  return apiRequest('/api/batches/products', password);
}

export function fetchBatches(password) {
  return apiRequest('/api/batches', password);
}

export function addBatch(password, batch) {
  return apiRequest('/api/batches', password, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
}

export function updateBatch(password, id, batch) {
  return apiRequest(`/api/batches/${id}`, password, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
}

export function deleteBatch(password, id) {
  return apiRequest(`/api/batches/${id}`, password, { method: 'DELETE' });
}

export function markBatchReceived(password, id) {
  return apiRequest(`/api/batches/${id}/receive`, password, { method: 'POST' });
}

export function fetchPurchasing(password) {
  return apiRequest('/api/purchasing', password);
}

export function updatePurchasingSettings(password, settings) {
  return apiRequest('/api/purchasing/settings', password, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

export function uploadKaspiPayReport(password, file) {
  const formData = new FormData();
  formData.append('file', file);
  return apiRequest('/api/reports/upload', password, { method: 'POST', body: formData, timeoutMs: LONG_TIMEOUT_MS });
}

export function fetchMonthlyReport(password) {
  return apiRequest('/api/reports/monthly', password);
}

export function fetchMonthProductBreakdown(password, month) {
  return apiRequest(`/api/reports/monthly/${month}/products`, password);
}

export function fetchDeliveryAnomalies(password, from) {
  const query = from ? `?from=${encodeURIComponent(from)}` : '';
  return apiRequest(`/api/reports/delivery-anomalies${query}`, password, { timeoutMs: LONG_TIMEOUT_MS });
}

export function fetchDeliveryReturns(password) {
  return apiRequest('/api/delivery-returns', password);
}

export function syncDeliveryReturns(password) {
  return apiRequest('/api/delivery-returns/sync', password, { method: 'POST', timeoutMs: LONG_TIMEOUT_MS });
}

export function deleteDeliveryReturn(password, orderNumber) {
  return apiRequest(`/api/delivery-returns/${orderNumber}`, password, { method: 'DELETE' });
}

export function fetchWarehouse(password) {
  return apiRequest('/api/warehouse', password);
}

export function fetchProductImages(password, productIds) {
  return apiRequest('/api/product-images', password, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_ids: productIds }),
  });
}

export function uploadProductImage(password, productId, file) {
  const formData = new FormData();
  formData.append('product_id', productId);
  formData.append('image', file);
  return apiRequest('/api/product-images/upload', password, { method: 'POST', body: formData, timeoutMs: LONG_TIMEOUT_MS });
}

export function deleteProductImage(password, productId) {
  return apiRequest(`/api/product-images/${encodeURIComponent(productId)}`, password, { method: 'DELETE' });
}

export function fetchExpenses(password) {
  return apiRequest('/api/expenses', password);
}

export function fetchExpensesMonthly(password) {
  return apiRequest('/api/expenses/monthly', password);
}

export function fetchOrders(password) {
  return apiRequest('/api/orders', password);
}

export function syncExpenses(password) {
  return apiRequest('/api/expenses/sync', password, { method: 'POST', timeoutMs: LONG_TIMEOUT_MS });
}
