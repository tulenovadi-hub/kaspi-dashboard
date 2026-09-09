import React, { useEffect, useState, useMemo } from 'react';
import { fetchDeliveryReturns, syncDeliveryReturns, archiveDeliveryReturn, returnDeliveryOrderToStock, removeDeliveryOrderFromStock } from './api.js';
import { formatMoney } from './dateUtils.js';
import FilterHeader from './FilterHeader.jsx';
import DeliveryReturnsMobile from './DeliveryReturnsMobile.jsx';
import { useIsMobile } from './useIsMobile.js';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Причины отмены приходят кодами Kaspi. Раньше переведена была только первая, остальные
// показывались как MERCHANT_OUT_OF_STOCK — на телефоне такая строка занимает пол-экрана и
// ничего не объясняет, поэтому переведены все девять, что реально встречаются в данных.
const CANCELLATION_REASON_LABELS = {
  BUYER_CANCELLATION_HIMSELF: 'Отменил покупатель',
  BUYER_CANCELLATION_BY_COURIER: 'Отменил курьер',
  BUYER_CANCELLATION_BY_CSC: 'Отменила поддержка Kaspi',
  MERCHANT_OUT_OF_STOCK: 'Не было в наличии',
  TIMEOUT_BUYER_PICKUP: 'Не забрал из пункта выдачи',
  TIMEOUT_BUYER_SIGNATURE: 'Не подписал получение',
  TIMEOUT_KASPI_DELIVERY: 'Просрочка доставки Kaspi',
  RFO_REJECTED: 'Отказ при оформлении',
  TECHNICAL_PROBLEM_CANCELLATION: 'Технический сбой',
};

function reasonLabel(o) {
  if (!o.cancellation_reason) return '—';
  return CANCELLATION_REASON_LABELS[o.cancellation_reason] || humanizeTrackingCode(o.cancellation_reason);
}

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

// "Вернулся на склад" — единственный благополучный исход: Kaspi подтвердил приём, остаётся
// убедиться, что коробка действительно на месте, и нажать "Добавить в остаток". Красим в зелёный.
function isDone(o) {
  return o.tracking_status === 'RETURNED';
}

// Кнопка "+ / − в остаток" имеет смысл только у заказов, которые реально уехали в возврат.
// В основной таблице показываем её всегда, в архиве — только если заказ всё ещё вычтен из
// остатка: так убранная крестиком строка с невернувшимся товаром не остаётся без управления,
// но 390 архивных строк не покрываются красными кнопками "− из остатка".
function showStockButton(o, mode) {
  if (!o.in_return_flow) return false;
  return mode === 'archive' ? o.subtracted_from_stock : true;
}

function wonderLabel(o) {
  return o.wonder_received === true ? 'Да' : o.wonder_received === false ? 'Нет' : '—';
}

const WONDER_OPTIONS = ['Да', 'Нет', '—'];

function createEmptyFilters() {
  return {
    // Общий поиск по номеру И названию товара — только для телефона: на компьютере номер
    // фильтруется из заголовка таблицы, а второй строки поиска на маленьком экране негде взять.
    search: '',
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
  orders, onArchive, archivingId, showDaysColumn, emptyText, onToggleStock, togglingId, stockButtonMode,
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
            <th>Наименование</th>
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
              <td colSpan={showDaysColumn ? 10 : 9} className="empty-state">{emptyText || 'Ничего не найдено по заданным фильтрам'}</td>
            </tr>
          ) : (
            orders.map((o) => (
              <tr key={o.order_number} className={isHighlighted(o) ? 'orders-row-return' : ''}>
                <td className="num">{o.order_number}</td>
                <td>{formatDate(o.creation_date)}</td>
                <td>
                  {o.product_names || '—'}
                  {o.quantity > 1 && <span className="orders-item-qty"> × {o.quantity}</span>}
                </td>
                {showDaysColumn && (
                  <td className="num">{o.days_since_last_track !== null ? o.days_since_last_track : o.days_since}</td>
                )}
                <td className="num">{formatMoney(o.total_price)}</td>
                <td className={isDone(o) ? 'report-cell-green' : undefined} style={{ color: isHighlighted(o) ? '#ff6b6b' : undefined, fontWeight: isHighlighted(o) || isDone(o) ? 600 : undefined }}>
                  {statusLabel(o)}
                </td>
                <td>{reasonLabel(o)}</td>
                <td>{o.origin_city || '—'}</td>
                <td style={{ color: o.wonder_received === false ? '#ff6b6b' : undefined, fontWeight: o.wonder_received === false ? 600 : undefined }}>
                  {wonderLabel(o)}
                </td>
                <td className="num">
                  <div className="batch-row-actions">
                    {showStockButton(o, stockButtonMode) && (
                      <button
                        className={`return-to-stock-button${o.subtracted_from_stock ? '' : ' is-undo'}`}
                        onClick={() => onToggleStock(o)}
                        disabled={togglingId === o.order_number}
                        title={o.subtracted_from_stock
                          ? 'Товар физически доехал до склада — вернуть эти штуки в остаток на «Складе»'
                          : 'Отменить: снова вычесть эти штуки из остатка на «Складе»'}
                      >
                        {togglingId === o.order_number ? '…' : (o.subtracted_from_stock ? '+ в остаток' : '− из остатка')}
                      </button>
                    )}
                    <button
                      className="batch-delete"
                      onClick={() => onArchive(o.order_number)}
                      disabled={archivingId === o.order_number}
                      title="Убрать строку в архив внизу страницы"
                    >
                      ✕
                    </button>
                  </div>
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
  const [archivingId, setArchivingId] = useState(null);
  const [filters, setFilters] = useState(createEmptyFilters);
  const [showArchive, setShowArchive] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const isMobile = useIsMobile();

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

  // Подтверждение руками ("+ в остаток") и его отмена ("− из остатка"). Строка остаётся на месте,
  // меняется только кнопка, поэтому список перечитываем целиком — цифры на "Складе" уже другие.
  function handleToggleStock(order) {
    const request = order.subtracted_from_stock ? returnDeliveryOrderToStock : removeDeliveryOrderFromStock;
    setTogglingId(order.order_number);
    setError('');
    request(password, order.order_number)
      .then(() => loadData())
      .catch((err) => setError(err.message))
      .finally(() => setTogglingId(null));
  }

  // Крестик: убрать строку из основной таблицы в архив (запись не удаляется).
  function handleArchive(orderNumber) {
    setArchivingId(orderNumber);
    setError('');
    archiveDeliveryReturn(password, orderNumber)
      .then(() => loadData())
      .catch((err) => setError(err.message))
      .finally(() => setArchivingId(null));
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
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const inNumber = String(o.order_number).includes(filters.search);
        const inProduct = String(o.product_names || '').toLowerCase().includes(q);
        if (!inNumber && !inProduct) return false;
      }
      if (filters.orderNumber && !String(o.order_number).includes(filters.orderNumber)) return false;
      if (filters.statusExcluded.has(statusLabel(o))) return false;
      if (filters.cityExcluded.has(o.origin_city)) return false;
      if (filters.wonderExcluded.has(wonderLabel(o))) return false;
      if (min !== null && Number(o.total_price) < min) return false;
      if (max !== null && Number(o.total_price) > max) return false;
      return true;
    });
  }, [orders, filters]);

  // В основной таблице — заказы, реально уехавшие в возврат и не убранные крестиком. Добавление
  // в остаток строку отсюда НЕ убирает (владелец попросила 2026-09-07: "не нужно отправлять из
  // этой таблицы ничего в архив после добавления в остаток") — уводит её только крестик. Всё
  // остальное, включая сотни разрешившихся отмен за всю историю, — в свёрнутом архиве внизу.
  const activeReturns = useMemo(() => filteredOrders.filter((o) => !o.archived_at && o.in_return_flow), [filteredOrders]);
  const archivedOrders = useMemo(() => filteredOrders.filter((o) => o.archived_at || !o.in_return_flow), [filteredOrders]);

  const suspiciousCount = orders.filter((o) => o.suspicious).length;

  // Цифры для телефона считаются ТОЛЬКО по активным заказам: архив в них не входит
  // (правило владельца 2026-09-09 — в макете плитка "ждут в пункте выдачи" показывала 2,
  // а это были две архивные записи от декабря 2025, по которым возврат давно закрыт).
  // Список активных берётся из orders, а не из filteredOrders: поиск на телефоне относится
  // к архиву, и сужать им карточки "в возврате" нельзя.
  const activeUnfiltered = useMemo(
    () => orders.filter((o) => !o.archived_at && o.in_return_flow),
    [orders],
  );
  const mobileSubtracted = activeUnfiltered.filter((o) => o.subtracted_from_stock);
  const mobileSubtractedUnits = mobileSubtracted.reduce((sum, o) => sum + Number(o.quantity || 0), 0);
  const mobileSuspicious = activeUnfiltered.filter((o) => o.suspicious).length;
  const mobileWaiting = activeUnfiltered.filter((o) => o.tracking_status === 'WAITING_IN_PICKUP_POINT').length;
  // Считаем по ВСЕМ заказам, а не только по видимым в основной таблице: если строку убрали
  // крестиком, не добавив товар в остаток (например, посылка потерялась), штуки всё равно
  // вычтены со "Склада", и это должно быть видно.
  const subtractedOrders = orders.filter((o) => o.subtracted_from_stock);
  const subtractedUnits = subtractedOrders.reduce((sum, o) => sum + Number(o.quantity || 0), 0);
  const subtractedInArchive = subtractedOrders.filter((o) => o.archived_at).length;

  const tableProps = {
    filters, updateFilter, toggleSetValue, selectAll, selectNone, statusOptions, cityOptions,
    archivingId, onArchive: handleArchive, onToggleStock: handleToggleStock, togglingId,
  };

  // Телефон — отдельный компонент, но данные, действия ("+ в остаток", "в архив",
  // "Проверить сейчас") и подписи статусов у него общие с таблицей.
  if (isMobile) {
    return (
      <>
        {error && <div className="error-banner">{error}</div>}
        {loading && !hasData ? (
          <div className="empty-state">Загрузка...</div>
        ) : (
          <DeliveryReturnsMobile
            activeReturns={activeUnfiltered}
            archivedOrders={archivedOrders}
            totalCount={orders.length}
            thresholdDays={thresholdDays}
            subtractedUnits={mobileSubtractedUnits}
            subtractedInArchive={subtractedInArchive}
            suspiciousCount={mobileSuspicious}
            waitingCount={mobileWaiting}
            search={filters.search}
            onSearch={(v) => updateFilter('search', v)}
            statusLabel={statusLabel}
            reasonLabel={reasonLabel}
            wonderLabel={wonderLabel}
            isHighlighted={isHighlighted}
            isDone={isDone}
            showStockButton={showStockButton}
            onToggleStock={handleToggleStock}
            togglingId={togglingId}
            onArchive={handleArchive}
            archivingId={archivingId}
            onSync={handleSync}
            syncing={syncing}
            loading={loading}
            isOnline={isOnline}
          />
        )}
      </>
    );
  }

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Отмены при доставке</h1>
      </div>

      <div style={{ color: '#6b7690', fontSize: 13, marginBottom: 16 }}>
        В таблице — заказы, отменённые при доставке. Пока товар по ним не принят обратно, на
        «Складе» эти штуки вычтены из остатка колонкой «Возвращается». Убедились, что коробка
        физически доехала, — нажмите «+ в остаток», только тогда штуки вернутся в остаток.
        Промахнулись — та же кнопка станет красной «− из остатка» и вернёт всё назад. Само по себе «Вернулся на склад» в трекинге Kaspi остаток не меняет. Статус берётся
        из настоящего трекинга Kaspi Delivery; подозрительный — если движения нет {thresholdDays}+
        дней. «Принят складом» — сверка со списком возвратов у партнёра Wonder. Список обновляется
        каждую ночь; крестик убирает строку в архив внизу страницы.
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
            emptyText="Сейчас нет заказов в возврате"
            {...tableProps}
          />
        )}
      </div>

      {!loading && orders.length > 0 && (
        <div className="report-note">
          Вычтено из остатка на «Складе»: {subtractedOrders.length} заказ(ов), {subtractedUnits} шт
          {subtractedInArchive > 0 && ` (из них ${subtractedInArchive} уже убрано в архив)`}.
          Подозрительных (без движения {thresholdDays}+ дней): {suspiciousCount}.
          Всего отслеживается за всю историю: {orders.length}.
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
              <OrdersTable orders={archivedOrders} stockButtonMode="archive" {...tableProps} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
