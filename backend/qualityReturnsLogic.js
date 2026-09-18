const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = parseISODate(value);
  if (!date) return null;
  return toISODate(new Date(date.getTime() + days * MS_PER_DAY));
}

// Kaspi показывает закончившийся день: 18 сентября в кабинете был период 19.08–17.09.
// Возврат входит в 30 календарных дат, затем исчезает из показателя на следующем обновлении.
function buildMetricWindow(todayISO) {
  const end = addDays(todayISO, -1);
  return { start: addDays(end, -29), end };
}

function getMetricState(returnsCount, issuedCount) {
  const rate = issuedCount > 0 ? (returnsCount / issuedCount) * 100 : 0;
  if (rate >= 2) return { key: 'risk', label: 'Выше нормы', rate };
  if (rate >= 1) return { key: 'normal', label: 'Нормально', rate };
  return { key: 'good', label: 'Хороший запас', rate };
}

function getReturnCapacity(returnsCount, issuedCount) {
  if (issuedCount <= 0) return 0;
  // Требование строгое: доля должна быть МЕНЬШЕ 2%, поэтому ровно 2% уже не подходит.
  const maxBelowLimit = Math.ceil(issuedCount * 0.02) - 1;
  return Math.max(0, maxBelowLimit - returnsCount);
}

function buildExpirySchedule(returns) {
  const byDate = new Map();
  for (const item of returns) {
    if (!item.return_date) continue;
    // +30 — день, когда событие уже вне окна; +1 — утреннее обновление кабинета Kaspi.
    const visibleDate = addDays(item.return_date, 31);
    const current = byDate.get(visibleDate) || { date: visibleDate, count: 0, orders: [] };
    current.count += 1;
    current.orders.push(String(item.order_number));
    byDate.set(visibleDate, current);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  addDays,
  buildExpirySchedule,
  buildMetricWindow,
  getMetricState,
  getReturnCapacity,
};
