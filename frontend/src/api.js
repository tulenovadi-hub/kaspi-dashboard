// api.js — все обращения к backend сосредоточены здесь

// На хостинге адрес backend будет другим, чем у фронтенда — он задаётся через переменную
// окружения VITE_API_URL при сборке (см. инструкцию DEPLOY.md). Для локальной разработки
// используется адрес локального сервера по умолчанию.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function apiRequest(path, token, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
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
  return response.json();
}

export async function login(username, password) {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || 'Не удалось войти');
  }
  return body; // { token, username, role }
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
  return apiRequest(`/api/analyst/report?from=${from}&to=${to}`, password);
}

export function fetchProductStats(password, productId, from, to, mode = 'main') {
  return apiRequest(`/api/stats/product/${encodeURIComponent(productId)}?from=${from}&to=${to}&mode=${mode}`, password);
}

export function triggerSync(password) {
  return apiRequest('/api/sync', password, { method: 'POST' });
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

export function uploadKaspiPayReport(password, file) {
  const formData = new FormData();
  formData.append('file', file);
  return apiRequest('/api/reports/upload', password, { method: 'POST', body: formData });
}

export function fetchMonthlyReport(password) {
  return apiRequest('/api/reports/monthly', password);
}

export function fetchMonthProductBreakdown(password, month) {
  return apiRequest(`/api/reports/monthly/${month}/products`, password);
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
  return apiRequest('/api/product-images/upload', password, { method: 'POST', body: formData });
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
  return apiRequest('/api/expenses/sync', password, { method: 'POST' });
}
