// dateUtils.js — небольшие помощники, чтобы не повторять логику дат в компонентах

export function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

export function formatMoney(value) {
  const num = Number(value || 0);
  return new Intl.NumberFormat('ru-RU').format(Math.round(num)) + ' ₸';
}

export function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
}

export function formatDayLabel(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

// Считает изменение в процентах между двумя значениями. Возвращает null, если сравнение невозможно (нет базы).
export function percentChange(current, previous) {
  if (!previous || previous === 0) {
    return current > 0 ? null : 0;
  }
  return ((current - previous) / previous) * 100;
}
