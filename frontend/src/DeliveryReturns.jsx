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

function wonderLabel(o) {
  return o.wonder_received === true ? 'Да' : o.wonder_received === false ? 'Нет' : '—';
}

const WONDER_OPTIONS = ['Да', 'Нет', '—'];

function createEmptyFilters() {
  return {
    orderNumber: '',
    dateFrom: '',
    dateTo: '',
    statusExcluded: new Set(),
    cityExcluded: new Set(),
    wonderExcluded: new Set(),
    amountMin: '',
    amountMax: '',
  };
}

function OrdersTable({
  orders, onDelete, deletingId, showDaysColumn, emptyText,
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
            <th>
              <FilterHeader label="Принят складом" active={filters.wonderExcluded.size > 0}>
                <div className="filter-popover-list">
                  {WONDER_OPTIONS.map((w) => (
                    <label key={w} className="filter-popover-checkbox">
                      <input
                        type="checkbox"
                        checked={!filters.wonderExcluded.has(w)}
                        onChange={() => toggleSetValue('wonderExcluded', w)}
                      />
                      <span>{w}</span>
                    </label>
                  ))}
                </div>
                <div className="filter-popover-actions">
                  <button onClick={() => selectAll('wonderExcluded')}>Все</button>
                  <button onClick={() => selectNone('wonderExcluded', WONDER_OPTIONS)}>Ничего</button>
                </div>
              </FilterHeader>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 ? (
            <tr>
              <td colSpan={showDaysColumn ? 9 : 8} className="empty-state">{emptyText || 'Ничего не найдено по заданным фильтрам'}</td>
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
                  {wonderLabel(o)}
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

export default function DeliveryReturns({ password, active = true, isOnline = true }) {
  const [orders, setOrders] = useState([]);
  const [thresholdDays, setThresholdDays] = useState(45);
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  const [filters, setFilters] = useState(createEmptyFilters);
  const [showArchive, setShowArchive] = useState(false);

  function loadData() {
    setLoading(true);
    setError('');
    fetchDeliveryReturns(password)
      .then((res) => {
        setOrders(res.orders);
        setThresholdDays(res.threshold_days);
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        setLoading(false);
        setHasData(true);
      });
  }

  useEffect(() => {
    if (active) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, password]);

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
      if (filters.wonderExcluded.has(wonderLabel(o))) return false;
      if (min !== null && Number(o.total_price) < min) return false;
      if (max !== null && Number(o.total_price) > max) return false;
      return true;
    });
  }, [orders, filters]);

  // В основной таблице — ТОЛЬКО заказы, которые прямо сейчас едут обратно на склад
  // (tracking_active, то есть последнее событие трекинга — шаг возврата, и приём на складе ещё не
  // подтверждён). Это ровно те заказы, из-за которых остаток на "Складе" уменьшен, и единственные,
  // с которыми ещё можно что-то сделать. Всё остальное — сотни разрешившихся отмен за всю историю
  // — уезжает в свёрнутый архив внизу страницы (владелец попросила 2026-09-07: "не хочу видеть все
  // эти заказы здесь").
  const activeReturns = useMemo(() => filteredOrders.filter((o) => o.tracking_active === true), [filteredOrders]);
  const archivedOrders = useMemo(() => filteredOrders.filter((o) => o.tracking_active !== true), [filteredOrders]);

  const suspiciousCount = orders.filter((o) => o.suspicious).length;
  const activeCount = orders.filter((o) => o.tracking_active === true).length;
  // "Ожидает в пункте выдачи" — заказ надо забрать физически. Такие уехали в архив (возврат по ним
  // уже не идёт), но потерять их нельзя, поэтому считаем отдельно и пишем прямо над архивом.
  const waitingPickup = orders.filter((o) => o.tracking_status === 'WAITING_IN_PICKUP_POINT');

  const tableProps = { filters, updateFilter, toggleSetValue, selectAll, selectNone, statusOptions, cityOptions, deletingId, onDelete: handleDelete };

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Проблемные возвраты</h1>
      </div>

      <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
        В таблице — только заказы, которые прямо сейчас едут обратно на склад после отмены при
        доставке: приём по ним ещё не подтверждён, и на «Складе» этот товар уже вычтен из остатка
        колонкой «Возвращается». Всё разрешившееся — в архиве внизу страницы. Статус берётся из
        настоящего трекинга Kaspi Delivery; подозрительный — если движения нет {thresholdDays}+ дней.
        «Принят складом» — сверка со списком возвратов у партнёра Wonder. Список обновляется каждую
        ночь; кнопка «✕» убирает строку, когда разобрались с заказом на Kaspi.
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

      <div className="card" style={{ opacity: (loading && hasData) || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        {loading && !hasData ? (
          <div className="empty-state">Загрузка...</div>
        ) : orders.length === 0 ? (
          <div className="empty-state">Сейчас нет заказов, отменённых при доставке</div>
        ) : (
          <OrdersTable
            orders={activeReturns}
            showDaysColumn
            emptyText="Сейчас ни один заказ не едет обратно — все возвраты закрыты"
            {...tableProps}
          />
        )}
      </div>

      {!loading && orders.length > 0 && (
        <div className="report-note">
          Едут обратно сейчас: {activeCount}. Из них подозрительных (без движения {thresholdDays}+ дней): {suspiciousCount}.
          Всего отслеживается за всю историю: {orders.length}.
        </div>
      )}

      {!loading && waitingPickup.length > 0 && (
        <div className="report-note" style={{ color: '#ff6b6b' }}>
          Ожидают в пункте выдачи: {waitingPickup.length} ({waitingPickup.map((o) => o.order_number).join(', ')}) — их нужно забрать физически. Возврат по ним не идёт, поэтому они в архиве.
        </div>
      )}

      {!loading && archivedOrders.length > 0 && (
        <>
          <div className="section-title">Архив</div>
          <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
            Отмены, по которым возврат уже не идёт: товар вернулся на склад, или его вообще не
            отправляли (отменили до передачи в доставку). Остаток на «Складе» они не уменьшают.
          </div>
          <button className="orders-toolbar-reset" onClick={() => setShowArchive((v) => !v)}>
            {showArchive ? 'Свернуть архив' : `Показать архив (${archivedOrders.length})`}
          </button>
          {showArchive && (
            <div className="card" style={{ marginTop: 12 }}>
              <OrdersTable orders={archivedOrders} {...tableProps} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
