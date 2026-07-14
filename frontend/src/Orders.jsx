import React, { useEffect, useMemo, useState } from 'react';
import { fetchOrders, fetchDeliveryAnomalies } from './api.js';
import { formatMoney, formatNumber, formatDateDMY, formatPercent } from './dateUtils.js';
import FilterHeader from './FilterHeader.jsx';

// С какой даты проверяем доставку — раньше этой даты данных недостаточно для сравнения.
const DELIVERY_CHECK_FROM = '2026-01-01';

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

function createEmptyFilters() {
  return {
    dateFrom: '',
    dateTo: '',
    orderNumber: '',
    productName: '',
    warehouseExcluded: new Set(),
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
    statusExcluded: new Set(),
  };
}

export default function Orders({ password }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(createEmptyFilters);

  const [checkingDelivery, setCheckingDelivery] = useState(false);
  const [deliveryCheckError, setDeliveryCheckError] = useState('');
  const [deliveryAnomalies, setDeliveryAnomalies] = useState(null);

  function handleCheckDelivery() {
    setCheckingDelivery(true);
    setDeliveryCheckError('');
    fetchDeliveryAnomalies(password, DELIVERY_CHECK_FROM)
      .then((res) => setDeliveryAnomalies(res))
      .catch((err) => setDeliveryCheckError(err.message))
      .finally(() => setCheckingDelivery(false));
  }

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchOrders(password)
      .then((res) => setOrders(res.orders))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password]);

  const updateFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const resetFilters = () => setFilters(createEmptyFilters());

  const warehouses = useMemo(() => {
    return Array.from(new Set(orders.map((o) => o.warehouse).filter(Boolean))).sort();
  }, [orders]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(orders.map((o) => getStatusLabel(o)))).sort();
  }, [orders]);

  const toggleSetValue = (key, value) => {
    setFilters((f) => {
      const next = new Set(f[key]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...f, [key]: next };
    });
  };
  const selectAll = (key) => setFilters((f) => ({ ...f, [key]: new Set() }));
  const selectNone = (key, allValues) => setFilters((f) => ({ ...f, [key]: new Set(allValues) }));

  const filtered = useMemo(() => {
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    return orders.filter((o) => {
      const datePart = String(o.date || '').slice(0, 10);
      if (filters.dateFrom && datePart < filters.dateFrom) return false;
      if (filters.dateTo && datePart > filters.dateTo) return false;
      if (filters.orderNumber && !String(o.order_number || '').includes(filters.orderNumber)) return false;
      if (filters.productName && !String(o.product_name || '').toLowerCase().includes(filters.productName.toLowerCase())) return false;
      if (filters.warehouseExcluded.has(o.warehouse)) return false;

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

      if (filters.statusExcluded.has(getStatusLabel(o))) return false;

      return true;
    });
  }, [orders, filters]);

  const hasActiveFilters = Object.entries(filters).some(([, v]) => (v instanceof Set ? v.size > 0 : v !== ''));

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
        <button className="sync-button" onClick={handleCheckDelivery} disabled={checkingDelivery} style={{ marginLeft: 'auto' }}>
          {checkingDelivery ? 'Проверяю...' : 'Проверить доставку'}
        </button>
      </div>

      {deliveryCheckError && <div className="error-banner">{deliveryCheckError}</div>}

      {deliveryAnomalies && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ padding: '14px 16px 0', fontWeight: 600 }}>
            Подозрительные начисления за доставку ({formatDateDMY(deliveryAnomalies.from)} – {formatDateDMY(deliveryAnomalies.to)})
          </div>
          <div style={{ padding: '4px 16px 14px', color: 'var(--text-secondary)', fontSize: 13 }}>
            Сравнивали заказы с одним товаром ({formatNumber(deliveryAnomalies.checked_orders)} шт.) — стоимость доставки за единицу товара
            против обычной (медианной) для этого же товара. Показаны случаи, где отличие минимум в 1.5 раза и минимум на 200 тг.
          </div>
          {deliveryAnomalies.anomalies.length === 0 ? (
            <div className="empty-state">Подозрительных начислений не найдено</div>
          ) : (
            <div className="table-scroll">
              <table className="product-table orders-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>№ заказа</th>
                    <th>Товар</th>
                    <th className="num">Кол-во</th>
                    <th className="num">Списано за доставку</th>
                    <th className="num">Обычно для товара</th>
                    <th className="num">Во сколько раз</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveryAnomalies.anomalies.map((a) => (
                    <tr key={`${a.order_number}_${a.product_id}`}>
                      <td>{formatDateDMY(a.date)}</td>
                      <td className="num">{a.order_number}</td>
                      <td>{a.product_name}</td>
                      <td className="num">{formatNumber(a.quantity)}</td>
                      <td className="num">{formatMoney(a.delivery_cost)}</td>
                      <td className="num">{formatMoney(a.median_per_unit)}</td>
                      <td className="num" style={{ color: a.ratio > 1 ? '#ff6b6b' : '#6b7690' }}>
                        {a.ratio.toFixed(2)}×
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : orders.length === 0 ? (
          <div className="empty-state">Ничего не найдено — убедитесь, что загружен отчёт Kaspi Pay на странице «Отчёт»</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table orders-table">
              <thead>
                <tr>
                  <th>
                    <FilterHeader label="Дата" active={!!(filters.dateFrom || filters.dateTo)}>
                      <div className="filter-popover-row">
                        <label>С</label>
                        <input type="date" value={filters.dateFrom} onChange={(e) => updateFilter('dateFrom', e.target.value)} />
                      </div>
                      <div className="filter-popover-row">
                        <label>По</label>
                        <input type="date" value={filters.dateTo} onChange={(e) => updateFilter('dateTo', e.target.value)} />
                      </div>
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, dateFrom: '', dateTo: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th>
                    <FilterHeader label="№ заказа" active={!!filters.orderNumber}>
                      <input
                        className="filter-popover-input"
                        type="text"
                        placeholder="Поиск..."
                        value={filters.orderNumber}
                        onChange={(e) => updateFilter('orderNumber', e.target.value)}
                        autoFocus
                      />
                      <button className="filter-popover-clear" onClick={() => updateFilter('orderNumber', '')}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th>
                    <FilterHeader label="Товар" active={!!filters.productName}>
                      <input
                        className="filter-popover-input"
                        type="text"
                        placeholder="Поиск..."
                        value={filters.productName}
                        onChange={(e) => updateFilter('productName', e.target.value)}
                        autoFocus
                      />
                      <button className="filter-popover-clear" onClick={() => updateFilter('productName', '')}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th>
                    <FilterHeader label="Склад" active={filters.warehouseExcluded.size > 0}>
                      <div className="filter-popover-list">
                        {warehouses.map((w) => (
                          <label key={w} className="filter-popover-checkbox">
                            <input
                              type="checkbox"
                              checked={!filters.warehouseExcluded.has(w)}
                              onChange={() => toggleSetValue('warehouseExcluded', w)}
                            />
                            <span>{w}</span>
                          </label>
                        ))}
                      </div>
                      <div className="filter-popover-actions">
                        <button onClick={() => selectAll('warehouseExcluded')}>Все</button>
                        <button onClick={() => selectNone('warehouseExcluded', warehouses)}>Ничего</button>
                      </div>
                    </FilterHeader>
                  </th>
                  <th className="num">
                    <FilterHeader label="Кол-во" active={!!(filters.qtyMin || filters.qtyMax)} align="right">
                      <div className="filter-popover-row">
                        <input type="number" placeholder="от" value={filters.qtyMin} onChange={(e) => updateFilter('qtyMin', e.target.value)} />
                        <input type="number" placeholder="до" value={filters.qtyMax} onChange={(e) => updateFilter('qtyMax', e.target.value)} />
                      </div>
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, qtyMin: '', qtyMax: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th className="num">
                    <FilterHeader label="Себестоимость" active={!!(filters.costMin || filters.costMax)} align="right">
                      <div className="filter-popover-row">
                        <input type="number" placeholder="от" value={filters.costMin} onChange={(e) => updateFilter('costMin', e.target.value)} />
                        <input type="number" placeholder="до" value={filters.costMax} onChange={(e) => updateFilter('costMax', e.target.value)} />
                      </div>
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, costMin: '', costMax: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th className="num">
                    <FilterHeader label="Доставка" active={!!(filters.deliveryMin || filters.deliveryMax)} align="right">
                      <div className="filter-popover-row">
                        <input type="number" placeholder="от" value={filters.deliveryMin} onChange={(e) => updateFilter('deliveryMin', e.target.value)} />
                        <input type="number" placeholder="до" value={filters.deliveryMax} onChange={(e) => updateFilter('deliveryMax', e.target.value)} />
                      </div>
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, deliveryMin: '', deliveryMax: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th className="num">
                    <FilterHeader label="Комиссия" active={!!(filters.commissionMin || filters.commissionMax)} align="right">
                      <div className="filter-popover-row">
                        <input type="number" placeholder="от" value={filters.commissionMin} onChange={(e) => updateFilter('commissionMin', e.target.value)} />
                        <input type="number" placeholder="до" value={filters.commissionMax} onChange={(e) => updateFilter('commissionMax', e.target.value)} />
                      </div>
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, commissionMin: '', commissionMax: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th className="num">
                    <FilterHeader label="Сумма" active={!!(filters.amountMin || filters.amountMax)} align="right">
                      <div className="filter-popover-row">
                        <input type="number" placeholder="от" value={filters.amountMin} onChange={(e) => updateFilter('amountMin', e.target.value)} />
                        <input type="number" placeholder="до" value={filters.amountMax} onChange={(e) => updateFilter('amountMax', e.target.value)} />
                      </div>
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, amountMin: '', amountMax: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th className="num">
                    <FilterHeader label="Маржа" active={!!(filters.marginMin || filters.marginMax)} align="right">
                      <div className="filter-popover-row">
                        <input type="number" placeholder="от" value={filters.marginMin} onChange={(e) => updateFilter('marginMin', e.target.value)} />
                        <input type="number" placeholder="до" value={filters.marginMax} onChange={(e) => updateFilter('marginMax', e.target.value)} />
                      </div>
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, marginMin: '', marginMax: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th>
                    <FilterHeader label="Статус" active={filters.statusExcluded.size > 0} align="right">
                      <div className="filter-popover-list">
                        {statusOptions.map((s) => (
                          <label key={s} className="filter-popover-checkbox">
                            <input
                              type="checkbox"
                              checked={!filters.statusExcluded.has(s)}
                              onChange={() => toggleSetValue('statusExcluded', s)}
                            />
                            <span>{s}</span>
                          </label>
                        ))}
                      </div>
                      <div className="filter-popover-actions">
                        <button onClick={() => selectAll('statusExcluded')}>Все</button>
                        <button onClick={() => selectNone('statusExcluded', statusOptions)}>Ничего</button>
                      </div>
                    </FilterHeader>
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
