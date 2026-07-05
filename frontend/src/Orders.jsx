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

function getStatusLabel(o) {
  return o.operation_type === 'Возврат' ? 'Возврат' : (STATUS_LABELS[o.status] || o.status || '—');
}

const EMPTY_FILTERS = {
  dateFrom: '',
  dateTo: '',
  orderNumber: '',
  productName: '',
  warehouse: '',
  qtyMin: '',
  qtyMax: '',
  costMin: '',
  costMax: '',
  deliveryMin: '',
  deliveryMax: '',
  commissionMin: '',
  commissionMax: '',
  amountMin: '',
  amountMax: '',
  marginMin: '',
  marginMax: '',
  status: '',
};

export default function Orders({ password }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchOrders(password)
      .then((res) => setOrders(res.orders))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password]);

  const updateFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const resetFilters = () => setFilters(EMPTY_FILTERS);

  const warehouses = useMemo(() => {
    return Array.from(new Set(orders.map((o) => o.warehouse).filter(Boolean))).sort();
  }, [orders]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(orders.map((o) => getStatusLabel(o)))).sort();
  }, [orders]);

  const filtered = useMemo(() => {
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    return orders.filter((o) => {
      const datePart = String(o.date || '').slice(0, 10);
      if (filters.dateFrom && datePart < filters.dateFrom) return false;
      if (filters.dateTo && datePart > filters.dateTo) return false;
      if (filters.orderNumber && !String(o.order_number || '').includes(filters.orderNumber)) return false;
      if (filters.productName && !String(o.product_name || '').toLowerCase().includes(filters.productName.toLowerCase())) return false;
      if (filters.warehouse && o.warehouse !== filters.warehouse) return false;

      const qtyMin = num(filters.qtyMin), qtyMax = num(filters.qtyMax);
      if (qtyMin !== null && Number(o.quantity) < qtyMin) return false;
      if (qtyMax !== null && Number(o.quantity) > qtyMax) return false;

      const costMin = num(filters.costMin), costMax = num(filters.costMax);
      if (costMin !== null && Number(o.cost) < costMin) return false;
      if (costMax !== null && Number(o.cost) > costMax) return false;

      const deliveryMin = num(filters.deliveryMin), deliveryMax = num(filters.deliveryMax);
      if (deliveryMin !== null && Number(o.delivery) < deliveryMin) return false;
      if (deliveryMax !== null && Number(o.delivery) > deliveryMax) return false;

      const commissionMin = num(filters.commissionMin), commissionMax = num(filters.commissionMax);
      if (commissionMin !== null && Number(o.commission) < commissionMin) return false;
      if (commissionMax !== null && Number(o.commission) > commissionMax) return false;

      const amountMin = num(filters.amountMin), amountMax = num(filters.amountMax);
      if (amountMin !== null && Number(o.amount) < amountMin) return false;
      if (amountMax !== null && Number(o.amount) > amountMax) return false;

      const marginMin = num(filters.marginMin), marginMax = num(filters.marginMax);
      if (marginMin !== null && Number(o.margin) < marginMin) return false;
      if (marginMax !== null && Number(o.margin) > marginMax) return false;

      if (filters.status && getStatusLabel(o) !== filters.status) return false;

      return true;
    });
  }, [orders, filters]);

  const hasActiveFilters = Object.values(filters).some((v) => v !== '');

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Заказы</h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="orders-toolbar">
        <div className="orders-toolbar-count">
          Показано {formatNumber(filtered.length)} из {formatNumber(orders.length)}
        </div>
        {hasActiveFilters && (
          <button className="orders-toolbar-reset" onClick={resetFilters}>Сбросить фильтры</button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : orders.length === 0 ? (
          <div className="empty-state">Ничего не найдено — убедитесь, что загружен отчёт Kaspi Pay на странице «Отчёт»</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>
                    <div className="th-label">Дата</div>
                    <div className="th-filter th-filter-range">
                      <input type="date" value={filters.dateFrom} onChange={(e) => updateFilter('dateFrom', e.target.value)} title="С" />
                      <input type="date" value={filters.dateTo} onChange={(e) => updateFilter('dateTo', e.target.value)} title="По" />
                    </div>
                  </th>
                  <th>
                    <div className="th-label">№ заказа</div>
                    <input
                      className="th-filter-input"
                      type="text"
                      placeholder="Поиск..."
                      value={filters.orderNumber}
                      onChange={(e) => updateFilter('orderNumber', e.target.value)}
                    />
                  </th>
                  <th>
                    <div className="th-label">Товар</div>
                    <input
                      className="th-filter-input"
                      type="text"
                      placeholder="Поиск..."
                      value={filters.productName}
                      onChange={(e) => updateFilter('productName', e.target.value)}
                    />
                  </th>
                  <th>
                    <div className="th-label">Склад</div>
                    <select
                      className="th-filter-input"
                      value={filters.warehouse}
                      onChange={(e) => updateFilter('warehouse', e.target.value)}
                    >
                      <option value="">Все</option>
                      {warehouses.map((w) => (
                        <option key={w} value={w}>{w}</option>
                      ))}
                    </select>
                  </th>
                  <th className="num">
                    <div className="th-label">Кол-во</div>
                    <div className="th-filter th-filter-range">
                      <input type="number" placeholder="от" value={filters.qtyMin} onChange={(e) => updateFilter('qtyMin', e.target.value)} />
                      <input type="number" placeholder="до" value={filters.qtyMax} onChange={(e) => updateFilter('qtyMax', e.target.value)} />
                    </div>
                  </th>
                  <th className="num">
                    <div className="th-label">Себестоимость</div>
                    <div className="th-filter th-filter-range">
                      <input type="number" placeholder="от" value={filters.costMin} onChange={(e) => updateFilter('costMin', e.target.value)} />
                      <input type="number" placeholder="до" value={filters.costMax} onChange={(e) => updateFilter('costMax', e.target.value)} />
                    </div>
                  </th>
                  <th className="num">
                    <div className="th-label">Доставка</div>
                    <div className="th-filter th-filter-range">
                      <input type="number" placeholder="от" value={filters.deliveryMin} onChange={(e) => updateFilter('deliveryMin', e.target.value)} />
                      <input type="number" placeholder="до" value={filters.deliveryMax} onChange={(e) => updateFilter('deliveryMax', e.target.value)} />
                    </div>
                  </th>
                  <th className="num">
                    <div className="th-label">Комиссия</div>
                    <div className="th-filter th-filter-range">
                      <input type="number" placeholder="от" value={filters.commissionMin} onChange={(e) => updateFilter('commissionMin', e.target.value)} />
                      <input type="number" placeholder="до" value={filters.commissionMax} onChange={(e) => updateFilter('commissionMax', e.target.value)} />
                    </div>
                  </th>
                  <th className="num">
                    <div className="th-label">Сумма</div>
                    <div className="th-filter th-filter-range">
                      <input type="number" placeholder="от" value={filters.amountMin} onChange={(e) => updateFilter('amountMin', e.target.value)} />
                      <input type="number" placeholder="до" value={filters.amountMax} onChange={(e) => updateFilter('amountMax', e.target.value)} />
                    </div>
                  </th>
                  <th className="num">
                    <div className="th-label">Маржа</div>
                    <div className="th-filter th-filter-range">
                      <input type="number" placeholder="от" value={filters.marginMin} onChange={(e) => updateFilter('marginMin', e.target.value)} />
                      <input type="number" placeholder="до" value={filters.marginMax} onChange={(e) => updateFilter('marginMax', e.target.value)} />
                    </div>
                  </th>
                  <th>
                    <div className="th-label">Статус</div>
                    <select
                      className="th-filter-input"
                      value={filters.status}
                      onChange={(e) => updateFilter('status', e.target.value)}
                    >
                      <option value="">Все</option>
                      {statusOptions.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="empty-state">Ничего не найдено по заданным фильтрам</td>
                  </tr>
                ) : (
                  filtered.map((o) => (
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
                          {getStatusLabel(o)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
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
