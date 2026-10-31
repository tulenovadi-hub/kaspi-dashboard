import React, { useEffect, useState } from 'react';
import { fetchSelfBuyOrders, markSelfBuyOrder, unmarkSelfBuyOrder } from './api.js';
import { formatMoney } from './dateUtils.js';
import { useAppRefresh } from './useAppRefresh.js';

// Блок "Самовыкупы вручную" на странице "Настройки": заказ с реального склада, который на самом
// деле самовыкуп. Вид тот же, что у соседнего блока "Исключить ошибочный заказ". Метка снимается
// одной кнопкой и ничего не теряет, поэтому отдельного подтверждения нет.

export default function SelfBuyOrders({ password, active = true }) {
  const [orders, setOrders] = useState([]);
  const [orderNumber, setOrderNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refreshTick = useAppRefresh(active);

  function load() {
    return fetchSelfBuyOrders(password)
      .then((res) => setOrders(res.orders))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshTick]);

  function run(action) {
    setSaving(true);
    setError('');
    return action()
      .then(load)
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  function handleMark(e) {
    e.preventDefault();
    run(() => markSelfBuyOrder(password, orderNumber.trim()).then(() => setOrderNumber('')));
  }

  return (
    <>
      <div className="section-title">Самовыкупы вручную</div>
      <div className="card">
        <div className="order-exclusion-intro">
          Заказ с реального склада, который на самом деле самовыкуп. Он не уменьшит остаток, не возьмёт себестоимость
          и перейдёт из основной статистики на страницу «Самовыкупы».
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form className="self-buy-form" onSubmit={handleMark}>
          <input
            className="toolbar-input"
            inputMode="numeric"
            placeholder="Номер заказа"
            aria-label="Номер заказа"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            required
          />
          <button className="primary-button" type="submit" disabled={saving}>Отметить самовыкупом</button>
        </form>
        {orders.length > 0 && (
          <div className="order-exclusion-list">
            {orders.map((order) => (
              <div className="order-exclusion-row" key={order.order_number}>
                <div className="order-exclusion-main">
                  <strong>№ {order.order_number}</strong>
                  <span>Склад: {order.warehouse || '—'}</span>
                  <small>
                    Отмечен {new Date(order.self_buy_marked_at).toLocaleString('ru-RU')}
                    {order.self_buy_marked_by ? ` · ${order.self_buy_marked_by}` : ''}
                  </small>
                </div>
                <div className="order-exclusion-impact">
                  <span>{order.item_quantity} шт.</span>
                  <span>{formatMoney(order.total_price)}</span>
                </div>
                <button
                  className="sync-button"
                  type="button"
                  disabled={saving}
                  onClick={() => run(() => unmarkSelfBuyOrder(password, order.order_number))}
                >
                  Снять отметку
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
