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

export function fetchSummary(password, from, to) {
  return apiRequest(`/api/stats/summary?from=${from}&to=${to}`, password);
}

export function fetchProducts(password, from, to) {
  return apiRequest(`/api/stats/products?from=${from}&to=${to}`, password);
}

export function fetchProductStats(password, productId, from, to) {
  return apiRequest(`/api/stats/product/${encodeURIComponent(productId)}?from=${from}&to=${to}`, password);
}

export function triggerSync(password) {
  return apiRequest('/api/sync', password, { method: 'POST' });
}
