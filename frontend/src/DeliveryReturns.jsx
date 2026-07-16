import React, { useEffect, useState, useMemo } from 'react';
import { fetchDeliveryReturns, syncDeliveryReturns, deleteDeliveryReturn } from './api.js';
import { formatMoney } from './dateUtils.js';
import FilterHeader from './FilterHeader.jsx';

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

// Помимо формально "подозрительных" (застряли в реальном возврате) отдельно подсвечиваем
// заказы, ожидающие в пункте выдачи — их нужно физически забрать, легко забыть.
function isHighlighted(o) {
  return o.suspicious || o.tracking_status === 'WAITING_IN_PICKUP_POINT';
}

function createEmptyFilters() {
  return {
    orderNumber: '',
    dateFrom: '',
    dateTo: '',
    statusExcluded: new Set(),
    cityExcluded: new Set(),
    amountMin: '',
    amountMax: '',
  };
}

function OrdersTable({
  orders, onDelete, deletingId, showDaysColumn,
  filters, updateFilter, toggleSetValue, selectAll, selectNone, statusOptions, cityOptions,
}) {
  return (
    <div className="table-scroll">
      <table className="product-table orders-table">
        <thead>
          <tr>
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
              <FilterHeader label="Дата создания" active={!!(filters.dateFrom || filters.dateTo)}>
                <div className="filter-popover-row">
                  <label>С</label>
                  <input type="date" value={filters.dateFrom} onChange={(e) => updateFilter('dateFrom', e.target.value)} />
                </div>
                <div className="filter-popover-row">
                  <label>По</label>
                  <input type="date" value={filters.dateTo} onChange={(e) => updateFilter('dateTo', e.target.value)} />
                </div>
                <button className="filter-popover-clear" onClick={() => { updateFilter('dateFrom', ''); updateFilter('dateTo', ''); }}>Очистить</button>
              </FilterHeader>
            </th>
            {showDaysColumn && <th className="num">Дней без движения</th>}
            <th className="num">
              <FilterHeader label="Сумма" active={!!(filters.amountMin || filters.amountMax)} align="right">
                <div className="filter-popover-row">
                  <input type="number" placeholder="от" value={filters.amountMin} onChange={(e) => updateFilter('amountMin', e.target.value)} />
                  <input type="number" placeholder="до" value={filters.amountMax} onChange={(e) => updateFilter('amountMax', e.target.value)} />
                </div>
                <button className="filter-popover-clear" onClick={() => { updateFilter('amountMin', ''); updateFilter('amountMax', ''); }}>Очистить</button>
              </FilterHeader>
            </th>
            <th>
              <FilterHeader label="Статус трекинга" active={filters.statusExcluded.size > 0}>
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
            <th>Причина отмены</th>
            <th>
              <FilterHeader label="Город отгрузки" active={filters.cityExcluded.size > 0}>
                <div className="filter-popover-list">
                  {cityOptions.map((c) => (
                    <label key={c} className="filter-popover-checkbox">
                      <input
                        type="checkbox"
                        checked={!filters.cityExcluded.has(c)}
                        onChange={() => toggleSetValue('cityExcluded', c)}
                      />
                      <span>{c}</span>
                    </label>
                  ))}
                </div>
                <div className="filter-popover-actions">
                  <button onClick={() => selectAll('cityExcluded')}>Все</button>
                  <button onClick={() => selectNone('cityExcluded', cityOptions)}>Ничего</button>
                </div>
              </FilterHeader>
            </th>
            <th>Принят складом</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 ? (
            <tr>
              <td colSpan={showDaysColumn ? 9 : 8} className="empty-state">Ничего не найдено по заданным фильтрам</td>
            </tr>
          ) : (
            orders.map((o) => (
              <tr key={o.order_number} className={isHighlighted(o) ? 'orders-row-return' : ''}>
                <td className="num">{o.order_number}</td>
                <td>{formatDate(o.creation_date)}</td>
                {showDaysColumn && (
                  <td className="num">{o.days_since_last_track !== null ? o.days_since_last_track : o.days_since}</td>
                )}
                <td className="num">{formatMoney(o.total_price)}</td>
                <td style={{ color: isHighlighted(o) ? '#ff6b6b' : undefined, fontWeight: isHighlighted(o) ? 600 : undefined }}>
                  {statusLabel(o)}
                </td>
                <td>{CANCELLATION_REASON_LABELS[o.cancellation_reason] || o.cancellation_reason || '—'}</td>
                <td>{o.origin_city || '—'}</td>
                <td style={{ color: o.wonder_received === false ? '#ff6b6b' : undefined, fontWeight: o.wonder_received === false ? 600 : undefined }}>
                  {o.wonder_received === true ? 'Да' : o.wonder_received === false ? 'Нет' : '—'}
                </td>
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
            ))
          )}
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
  const [filters, setFilters] = useState(createEmptyFilters);

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

  const updateFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
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
  const hasActiveFilters = Object.entries(filters).some(([, v]) => (v instanceof Set ? v.size > 0 : v !== ''));
  const resetFilters = () => setFilters(createEmptyFilters());

  const statusOptions = useMemo(() => Array.from(new Set(orders.map(statusLabel))).sort(), [orders]);
  const cityOptions = useMemo(() => Array.from(new Set(orders.map((o) => o.origin_city).filter(Boolean))).sort(), [orders]);

  const filteredOrders = useMemo(() => {
    const min = filters.amountMin === '' ? null : Number(filters.amountMin);
    const max = filters.amountMax === '' ? null : Number(filters.amountMax);
    return orders.filter((o) => {
      const datePart = String(o.creation_date || '').slice(0, 10);
      if (filters.dateFrom && datePart < filters.dateFrom) return false;
      if (filters.dateTo && datePart > filters.dateTo) return false;
      if (filters.orderNumber && !String(o.order_number).includes(filters.orderNumber)) return false;
      if (filters.statusExcluded.has(statusLabel(o))) return false;
      if (filters.cityExcluded.has(o.origin_city)) return false;
      if (min !== null && Number(o.total_price) < min) return false;
      if (max !== null && Number(o.total_price) > max) return false;
      return true;
    });
  }, [orders, filters]);

  // Заказы, отменённые ДО передачи в доставку (tracking_status === 'CANCELLED') — товар никуда
  // не уезжал и возвращать было нечего, такие никогда не бывают подозрительными. Выносим их в
  // отдельную таблицу ниже, чтобы не засорять основной список, где важны реальные возвраты.
  const mainOrders = useMemo(() => filteredOrders.filter((o) => o.tracking_status !== 'CANCELLED'), [filteredOrders]);
  const cancelledBeforeDelivery = useMemo(() => filteredOrders.filter((o) => o.tracking_status === 'CANCELLED'), [filteredOrders]);

  const suspiciousCount = orders.filter((o) => o.suspicious).length;

  const tableProps = { filters, updateFilter, toggleSetValue, selectAll, selectNone, statusOptions, cityOptions, deletingId, onDelete: handleDelete };

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Проблемные возвраты</h1>
      </div>

      <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
        Заказы, отменённые при доставке (Kaspi Доставка). Статус берётся из настоящего трекинга Kaspi
        Delivery, а не из основного API заказов (там поле возврата на склад оказалось ненадёжным).
        Подозрительным заказ помечается только если он всё ещё «Едет обратно на склад», но без
        единого движения уже {thresholdDays}+ дней; заказы «Ожидает в пункте выдачи» подсвечены
        отдельно — их нужно забрать физически. «Принят складом» сверяется со списком возвратов у
        партнёра Wonder — «Нет» значит, что заказ не найден у Wonder ни в одном статусе. Список
        пополняется и перепроверяется каждую ночь — уберите строку кнопкой «✕», когда разобрались
        с заказом на Kaspi.
      </div>

      <div className="batches-toolbar">
        <button className="sync-button" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Проверяю...' : 'Проверить сейчас'}
        </button>
        {hasActiveFilters && (
          <button className="orders-toolbar-reset" onClick={resetFilters}>Сбросить фильтры</button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : orders.length === 0 ? (
          <div className="empty-state">Сейчас нет заказов, отменённых при доставке</div>
        ) : (
          <OrdersTable orders={mainOrders} showDaysColumn {...tableProps} />
        )}
      </div>

      {!loading && orders.length > 0 && (
        <div className="report-note">
          Всего отслеживается: {orders.length}. Подозрительных: {suspiciousCount}.
        </div>
      )}

      {!loading && orders.some((o) => o.tracking_status === 'CANCELLED') && (
        <>
          <div className="section-title">Отменены до передачи в доставку</div>
          <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
            Товар физически никуда не уезжал — возвращать было нечего. Показаны отдельно, чтобы не
            путать с реальными возвратами выше.
          </div>
          <div className="card">
            <OrdersTable orders={cancelledBeforeDelivery} {...tableProps} />
          </div>
        </>
      )}
    </div>
  );
}
