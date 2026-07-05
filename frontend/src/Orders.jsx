import React, { useEffect, useMemo, useState } from 'react';
import { fetchOrders } from './api.js';
import { formatMoney, formatNumber, formatDateDMY, formatPercent } from './dateUtils.js';

const STATUS_LABELS = {
  COMPLETED: 'Выполнено',
  ACCEPTED_BY_MERCHANT: 'В обработке',
  APPROVED_BY_BANK: 'В обработке',
  RETURNED: 'Возврат',
  CANCELLED: 'Отменён',
};

export default function Orders({ password }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchOrders(password)
      .then((res) => setOrders(res.orders))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password]);

  const warehouses = useMemo(() => {
    return Array.from(new Set(orders.map((o) => o.warehouse).filter(Boolean))).sort();
  }, [orders]);

  const filtered = useMemo(() => {
    return orders
      .filter((o) => !search || o.order_number.includes(search) || o.product_name.toLowerCase().includes(search.toLowerCase()))
      .filter((o) => !warehouseFilter || o.warehouse === warehouseFilter)
      .filter((o) => !statusFilter || o.operation_type === statusFilter);
  }, [orders, search, warehouseFilter, statusFilter]);

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Заказы</h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="batches-toolbar">
        <input
          className="toolbar-input"
          type="text"
          placeholder="Поиск по номеру заказа или товару..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="toolbar-select"
          value={warehouseFilter}
          onChange={(e) => setWarehouseFilter(e.target.value)}
        >
          <option value="">Все склады</option>
          {warehouses.map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
        <select
          className="toolbar-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">Покупки и возвраты</option>
          <option value="Покупка">Только покупки</option>
          <option value="Возврат">Только возвраты</option>
        </select>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Ничего не найдено — убедитесь, что загружен отчёт Kaspi Pay на странице «Отчёт»</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>№ заказа</th>
                  <th>Товар</th>
                  <th>Склад</th>
                  <th className="num">Кол-во</th>
                  <th className="num">Себестоимость</th>
                  <th className="num">Доставка</th>
                  <th className="num">Комиссия</th>
                  <th className="num">Сумма</th>
                  <th className="num">Маржа</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr key={`${o.order_number}_${o.operation_type}`} className={o.operation_type === 'Возврат' ? 'orders-row-return' : ''}>
                    <td>{formatDateDMY(o.date)}</td>
                    <td className="num">{o.order_number}</td>
                    <td>{o.product_name}</td>
                    <td>{o.warehouse || '—'}</td>
                    <td className="num">{formatNumber(o.quantity)}</td>
                    <td className="num">{formatMoney(o.cost)}</td>
                    <td className="num">{formatMoney(o.delivery)}</td>
                    <td className="num">{formatMoney(o.commission)}</td>
                    <td className="num">{formatMoney(o.amount)}</td>
                    <td className="num">{formatPercent(o.margin)}</td>
                    <td>
                      <span className={`orders-status orders-status-${o.operation_type === 'Возврат' ? 'return' : 'done'}`}>
                        {o.operation_type === 'Возврат' ? 'Возврат' : (STATUS_LABELS[o.status] || o.status || '—')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-note">
        Список строится из загруженного Excel-отчёта Kaspi Pay (страница «Отчёт») — если он давно не обновлялся, здесь тоже будут старые данные.
        Себестоимость считается по методу FIFO на основе партий на «Поставках».
      </div>
    </div>
  );
}
