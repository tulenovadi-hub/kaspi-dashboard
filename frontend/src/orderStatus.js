// Подписи статусов заказа — общие для компьютерной таблицы (`Orders.jsx`) и мобильной
// ленты (`OrdersMobile.jsx`). Лежат отдельно от вёрстки по той же причине, что и
// `reportColumns.js`: набор, продублированный в двух компонентах, разъедется при первой правке.

export const STATUS_LABELS = {
  COMPLETED: 'Выполнено',
  ACCEPTED_BY_MERCHANT: 'В обработке',
  APPROVED_BY_BANK: 'В обработке',
  RETURNED: 'Возврат',
  CANCELLED: 'Отменён',
};

// У возврата свой статус: строка "Возврат" в отчёте Kaspi Pay приходит со статусом заказа
// RETURNED, но показывать надо именно событие, а не состояние заказа.
export function getStatusLabel(order) {
  return order.operation_type === 'Возврат'
    ? 'Возврат'
    : (STATUS_LABELS[order.status] || order.status || '—');
}
