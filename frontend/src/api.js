// api.js — все обращения к backend сосредоточены здесь

// На хостинге адрес backend будет другим, чем у фронтенда — он задаётся через переменную
// окружения VITE_API_URL при сборке (см. инструкцию DEPLOY.md). Для локальной разработки
// используется адрес локального сервера по умолчанию.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function apiRequest(path, password, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      'X-Dashboard-Password': password,
    },
  });

  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Ошибка запроса к серверу');
  }
  return response.json();
}

export function fetchSummary(password, from, to, mode = 'main') {
  return apiRequest(`/api/stats/summary?from=${from}&to=${to}&mode=${mode}`, password);
}

export function fetchProducts(password, from, to, mode = 'main') {
  return apiRequest(`/api/stats/products?from=${from}&to=${to}&mode=${mode}`, password);
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

export function fetchWarehouse(password) {
  return apiRequest('/api/warehouse', password);
}
