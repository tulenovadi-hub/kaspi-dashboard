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

// 1-е число текущего месяца (по алматинскому времени) — используется как дефолтное начало
// периода на Главной и Маркетинге: "с начала месяца по сегодня".
export function startOfMonth() {
  const now = new Date();
  const almatyNow = new Date(now.getTime() + ALMATY_OFFSET);
  almatyNow.setUTCDate(1);
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

const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

export function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// "1 запись", "3 записи", "41 запись". Русское числительное само по себе мелочь, но строка
// стоит под крупной цифрой и на телефоне, и в итоге таблицы на компьютере — "41 записей"
// там сразу заметно.
export function formatRecords(count) {
  const n = Number(count) || 0;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} запись`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} записи`;
  return `${n} записей`;
}

export function formatPercent(value) {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '' : ''}${value.toFixed(1)}%`;
}

// Превращает "2026-01-08" или "2026-01-08T00:00:00.000Z" в "08/01/2026".
// Работает со строкой напрямую (без new Date), чтобы не словить сдвиг из-за часового пояса.
export function formatDateDMY(value) {
  if (!value) return '—';
  const datePart = String(value).slice(0, 10);
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

// Сдвиг ISO-даты на N дней. Работает в UTC и со строкой, а не с локальным Date, чтобы
// не словить сдвиг на сутки из-за часового пояса (та же причина, что у formatDateDMY).
export function shiftDays(isoDate, days) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Сколько дней в периоде, включая обе границы: 01.09–08.09 = 8 дней.
export function daysInRange(from, to) {
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}
