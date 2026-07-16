import React, { useEffect, useState } from 'react';
import { fetchDeliveryReturns } from './api.js';
import { formatMoney } from './dateUtils.js';

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const CANCELLATION_REASON_LABELS = {
  BUYER_CANCELLATION_HIMSELF: 'Отменил покупатель',
};

export default function DeliveryReturns({ password }) {
  const [orders, setOrders] = useState([]);
  const [thresholdDays, setThresholdDays] = useState(45);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchDeliveryReturns(password)
      .then((res) => {
        setOrders(res.orders);
        setThresholdDays(res.threshold_days);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password]);

  const suspiciousCount = orders.filter((o) => o.suspicious).length;

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Проблемные возвраты</h1>
      </div>

      <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
        Заказы, отменённые при доставке (Kaspi Доставка), которые Kaspi ещё не вернул на склад продавца.
        Заказы, зависшие в этом статусе {thresholdDays}+ дней, помечены как подозрительные — возможно,
        Kaspi потерял их при возврате, стоит написать в поддержку.
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка... (запрос к Kaspi может занять до минуты)</div>
        ) : orders.length === 0 ? (
          <div className="empty-state">Сейчас нет заказов, отменённых при доставке</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table orders-table">
              <thead>
                <tr>
                  <th>№ заказа</th>
                  <th>Дата создания</th>
                  <th className="num">Дней в статусе</th>
                  <th className="num">Сумма</th>
                  <th>Причина отмены</th>
                  <th>Город отгрузки</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.order_number} className={o.suspicious ? 'orders-row-return' : ''}>
                    <td className="num">{o.order_number}</td>
                    <td>{formatDate(o.creation_date)}</td>
                    <td className="num" style={{ color: o.suspicious ? '#ff6b6b' : undefined, fontWeight: o.suspicious ? 600 : undefined }}>
                      {o.days_since}
                    </td>
                    <td className="num">{formatMoney(o.total_price)}</td>
                    <td>{CANCELLATION_REASON_LABELS[o.cancellation_reason] || o.cancellation_reason || '—'}</td>
                    <td>{o.origin_city || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && orders.length > 0 && (
        <div className="report-note">
          Всего в статусе «Отменяется»: {orders.length}. Подозрительных (от {thresholdDays} дней): {suspiciousCount}.
          Список запрашивается напрямую у Kaspi при каждом открытии страницы — актуален на момент загрузки.
        </div>
      )}
    </div>
  );
}
