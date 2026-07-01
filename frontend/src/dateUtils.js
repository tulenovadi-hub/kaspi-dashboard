// Алматы UTC+5 — все даты считаем в местном времени
const ALMATY_OFFSET = 5 * 60 * 60 * 1000;

export function toISODate(date) {
  const local = new Date(date.getTime() + ALMATY_OFFSET);
  return local.toISOString().slice(0, 10);
}

export function daysAgo(n) {
  const now = new Date();
  const almatyNow = new Date(now.getTime() + ALMATY_OFFSET);
  almatyNow.setUTCDate(almatyNow.getUTCDate() - n);
  almatyNow.setUTCHours(0, 0, 0, 0);
  return new Date(almatyNow.getTime() - ALMATY_OFFSET);
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

export function percentChange(current, previous) {
  if (!previous || previous === 0) {
    return current > 0 ? null : 0;
  }
  return ((current - previous) / previous) * 100;
}
