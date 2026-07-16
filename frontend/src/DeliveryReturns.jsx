import React, { useEffect, useState, useMemo } from 'react';
import { fetchDeliveryReturns, syncDeliveryReturns, deleteDeliveryReturn } from './api.js';
import { formatMoney } from './dateUtils.js';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const CANCELLATION_REASON_LABELS = {
  BUYER_CANCELLATION_HIMSELF: 'Отменил покупатель',
};

// tracking_status у большинства заказов — это код ПОСЛЕДНЕГО события трекинга Kaspi Delivery
// (см. backend/deliveryReturnsSync.js), а не фиксированный набор значений — кодов у Kaspi
// много, поэтому переводим только самые частые, а для остальных просто делаем код читаемым.
const TRACKING_STATUS_LABELS = {
  RETURNED: 'Вернулся на склад',
  CANCELLED: 'Отменён без доставки',
  WAITING_IN_PICKUP_POINT: 'Ожидает в пункте выдачи',
};

function humanizeTrackingCode(code) {
  return code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
}

function statusLabel(o) {
  if (o.tracking_status) {
    if (TRACKING_STATUS_LABELS[o.tracking_status]) return TRACKING_STATUS_LABELS[o.tracking_status];
    if (o.tracking_active) return 'Едет обратно на склад';
    return humanizeTrackingCode(o.tracking_status);
  }
  if (o.status === 'CANCELLING') return 'Отменяется';
  if (o.status === 'CANCELLED') return 'В архиве';
  return o.status || '—';
}

function OrdersTable({ orders, onDelete, deletingId, showDaysColumn }) {
  return (
    <div className="table-scroll">
      <table className="product-table orders-table">
        <thead>
          <tr>
            <th>№ заказа</th>
            <th>Дата создания</th>
            {showDaysColumn && <th className="num">Дней без движения</th>}
            <th className="num">Сумма</th>
            <th>Статус трекинга</th>
            <th>Причина отмены</th>
            <th>Город отгрузки</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.order_number} className={o.suspicious ? 'orders-row-return' : ''}>
              <td className="num">{o.order_number}</td>
              <td>{formatDate(o.creation_date)}</td>
              {showDaysColumn && (
                <td className="num">{o.days_since_last_track !== null ? o.days_since_last_track : o.days_since}</td>
              )}
              <td className="num">{formatMoney(o.total_price)}</td>
              <td style={{ color: o.suspicious ? '#ff6b6b' : undefined, fontWeight: o.suspicious ? 600 : undefined }}>
                {statusLabel(o)}
              </td>
              <td>{CANCELLATION_REASON_LABELS[o.cancellation_reason] || o.cancellation_reason || '—'}</td>
              <td>{o.origin_city || '—'}</td>
              <td className="num">
                <button
                  className="batch-delete"
                  onClick={() => onDelete(o.order_number)}
                  disabled={deletingId === o.order_number}
                  title="Убрать из списка"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DeliveryReturns({ password }) {
  const [orders, setOrders] = useState([]);
  const [thresholdDays, setThresholdDays] = useState(45);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  function loadData() {
    setLoading(true);
    setError('');
    fetchDeliveryReturns(password)
      .then((res) => {
        setOrders(res.orders);
        setThresholdDays(res.threshold_days);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(loadData, [password]);

  function handleSync() {
    setSyncing(true);
    setError('');
    syncDeliveryReturns(password)
      .then(() => loadData())
      .catch((err) => setError(err.message))
      .finally(() => setSyncing(false));
  }

  function handleDelete(orderNumber) {
    setDeletingId(orderNumber);
    deleteDeliveryReturn(password, orderNumber)
      .then(() => setOrders((prev) => prev.filter((o) => o.order_number !== orderNumber)))
      .catch((err) => setError(err.message))
      .finally(() => setDeletingId(null));
  }

  // Заказы, отменённые ДО передачи в доставку (tracking_status === 'CANCELLED') — товар никуда
  // не уезжал и возвращать было нечего, такие никогда не бывают подозрительными. Выносим их в
  // отдельную таблицу ниже, чтобы не засорять основной список, где важны реальные возвраты.
  const mainOrders = useMemo(() => orders.filter((o) => o.tracking_status !== 'CANCELLED'), [orders]);
  const cancelledBeforeDelivery = useMemo(() => orders.filter((o) => o.tracking_status === 'CANCELLED'), [orders]);

  const suspiciousCount = orders.filter((o) => o.suspicious).length;

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Проблемные возвраты</h1>
      </div>

      <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
        Заказы, отменённые при доставке (Kaspi Доставка). Статус берётся из настоящего трекинга Kaspi
        Delivery, а не из основного API заказов (там поле возврата на склад оказалось ненадёжным).
        Подозрительным заказ помечается только если он всё ещё «Едет обратно на склад», но без
        единого движения уже {thresholdDays}+ дней. Список пополняется и перепроверяется каждую
        ночь — уберите строку кнопкой «✕», когда разобрались с заказом на Kaspi.
      </div>

      <div className="batches-toolbar">
        <button className="sync-button" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Проверяю...' : 'Проверить сейчас'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : mainOrders.length === 0 ? (
          <div className="empty-state">Сейчас нет заказов, отменённых при доставке</div>
        ) : (
          <OrdersTable orders={mainOrders} onDelete={handleDelete} deletingId={deletingId} showDaysColumn />
        )}
      </div>

      {!loading && orders.length > 0 && (
        <div className="report-note">
          Всего отслеживается: {orders.length}. Подозрительных: {suspiciousCount}.
        </div>
      )}

      {!loading && cancelledBeforeDelivery.length > 0 && (
        <>
          <div className="section-title">Отменены до передачи в доставку</div>
          <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
            Товар физически никуда не уезжал — возвращать было нечего. Показаны отдельно, чтобы не
            путать с реальными возвратами выше.
          </div>
          <div className="card">
            <OrdersTable orders={cancelledBeforeDelivery} onDelete={handleDelete} deletingId={deletingId} />
          </div>
        </>
      )}
    </div>
  );
}
