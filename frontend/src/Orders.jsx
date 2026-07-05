import React, { useEffect, useMemo, useRef, useState } from 'react';
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

// Кнопка-заголовок столбца с иконкой воронки + выпадающая панель фильтра.
// Открывается по клику, закрывается по клику снаружи — как автофильтр в Google Sheets/Excel.
function FilterHeader({ label, active, align, children }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="th-filter-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`th-filter-btn${active ? ' th-filter-btn-active' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <svg viewBox="0 0 20 20" width="11" height="11" fill="none">
          <path d="M3 4h14l-5.5 6.5V16l-3 1.5v-7L3 4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          className={`th-filter-popover${align === 'right' ? ' th-filter-popover-right' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default function Orders({ password }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(createEmptyFilters);

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
