import React, { useEffect, useState } from 'react';
import { formatMoney, formatNumber, formatPercent } from './dateUtils.js';
import { getStatusLabel } from './orderStatus.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';

// Мобильные "Заказы". На компьютере это таблица на 11 колонок с фильтром в каждом заголовке;
// на айфоне от неё видно неполные три. Владелец выбрала из двух макетов (2026-09-09) вариант
// "лента по дням": заказы сгруппированы по датам, у каждого дня своя шапка с числом заказов и
// суммой за день. В карточке сразу видно товар, сумму, склад, количество, маржу и метку
// возврата; остальные колонки — № заказа, себестоимость, доставка, комиссия, статус —
// разворачиваются по тапу. Ни одна колонка таблицы не потеряна.
//
// Второй вариант (плоский плотный список с поиском сверху и полной карточкой заказа по тапу)
// отклонён: по дням видно, "что было вчера", а это главный вопрос к этой странице с телефона.
//
// ФИЛЬТРЫ ЖИВУТ В `Orders.jsx` — сюда приходят готовыми. Так мобильная лента и компьютерная
// таблица фильтруют ОДНИМ кодом: набор фильтров у них общий, разъехаться не может.

const DAYS_STEP = 4; // сколько дней показываем за раз, дальше — "Показать ещё"

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// Дата приходит как "2026-08-31T00:00:00.000Z". Режем строку, а не гоняем через new Date:
// иначе часовой пояс сдвинет день (тот же приём, что в formatDateDMY).
function dayKey(value) {
  return String(value || '').slice(0, 10);
}

function dayTitle(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { date: iso || '—', week: '' };
  const d = new Date(`${iso}T00:00:00`);
  return {
    date: `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`,
    week: WEEKDAYS[d.getDay()] || '',
  };
}

function shortMoney(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(2).replace('.', ',')} млн ₸`;
  return formatMoney(v);
}

function orderKey(o) {
  return `${o.order_number}_${o.operation_type}`;
}

// Диапазон "от — до" в листе фильтров. Пять числовых колонок таблицы фильтруются одинаково,
// поэтому и поле одно на всех.
function Range({ label, minKey, maxKey, filters, onChange, onClear }) {
  const active = filters[minKey] !== '' || filters[maxKey] !== '';
  return (
    <div className="om-range">
      <div className="om-range-head">
        <span>{label}</span>
        {active && <button className="om-range-clear" onClick={onClear}>очистить</button>}
      </div>
      <div className="om-range-row">
        <input
          type="number"
          inputMode="numeric"
          placeholder="от"
          value={filters[minKey]}
          onChange={(e) => onChange(minKey, e.target.value)}
        />
        <input
          type="number"
          inputMode="numeric"
          placeholder="до"
          value={filters[maxKey]}
          onChange={(e) => onChange(maxKey, e.target.value)}
        />
      </div>
    </div>
  );
}

// Группа чипсов с исключающим набором: в фильтре хранится то, что ВЫКЛЮЧЕНО (как в таблице
// на компьютере), поэтому нажатый чипс = значение показывается.
function ChipGroup({ label, values, excluded, onToggle, onAll, onNone }) {
  if (values.length === 0) return null;
  return (
    <div className="om-group">
      <div className="om-group-head">
        <span>{label}</span>
        <span className="om-group-actions">
          <button onClick={onAll}>все</button>
          <button onClick={onNone}>ничего</button>
        </span>
      </div>
      <div className="om-chips">
        {values.map((v) => (
          <button
            key={v}
            className="om-chip"
            aria-pressed={!excluded.has(v)}
            onClick={() => onToggle(v)}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

function FilterSheet({
  filters, count, warehouses, statusOptions,
  onChange, onToggleSet, onSelectAll, onSelectNone, onReset, onClose,
}) {
  // Фон под шторкой не должен прокручиваться: на айфоне без position: fixed страница едет
  // под открытым окном (подробности — в useBodyScrollLock.js).
  useBodyScrollLock();

  return (
    <div className="om-sheet-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="om-sheet" role="dialog" aria-label="Фильтры заказов">
        <div className="om-sheet-grip" />
        <div className="om-sheet-head">
          <div className="om-sheet-title">Фильтры</div>
          <button className="om-sheet-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="om-group">
          <div className="om-group-head"><span>Период</span></div>
          <div className="om-range-row">
            <input
              type="date"
              value={filters.dateFrom}
              max={filters.dateTo || undefined}
              onChange={(e) => onChange('dateFrom', e.target.value)}
            />
            <input
              type="date"
              value={filters.dateTo}
              min={filters.dateFrom || undefined}
              onChange={(e) => onChange('dateTo', e.target.value)}
            />
          </div>
        </div>

        <ChipGroup
          label="Склад"
          values={warehouses}
          excluded={filters.warehouseExcluded}
          onToggle={(v) => onToggleSet('warehouseExcluded', v)}
          onAll={() => onSelectAll('warehouseExcluded')}
          onNone={() => onSelectNone('warehouseExcluded', warehouses)}
        />

        <ChipGroup
          label="Статус"
          values={statusOptions}
          excluded={filters.statusExcluded}
          onToggle={(v) => onToggleSet('statusExcluded', v)}
          onAll={() => onSelectAll('statusExcluded')}
          onNone={() => onSelectNone('statusExcluded', statusOptions)}
        />

        <Range label="Количество, шт" minKey="qtyMin" maxKey="qtyMax" filters={filters} onChange={onChange} onClear={() => { onChange('qtyMin', ''); onChange('qtyMax', ''); }} />
        <Range label="Сумма, ₸" minKey="amountMin" maxKey="amountMax" filters={filters} onChange={onChange} onClear={() => { onChange('amountMin', ''); onChange('amountMax', ''); }} />
        <Range label="Себестоимость, ₸" minKey="costMin" maxKey="costMax" filters={filters} onChange={onChange} onClear={() => { onChange('costMin', ''); onChange('costMax', ''); }} />
        <Range label="Доставка, ₸" minKey="deliveryMin" maxKey="deliveryMax" filters={filters} onChange={onChange} onClear={() => { onChange('deliveryMin', ''); onChange('deliveryMax', ''); }} />
        <Range label="Комиссия, ₸" minKey="commissionMin" maxKey="commissionMax" filters={filters} onChange={onChange} onClear={() => { onChange('commissionMin', ''); onChange('commissionMax', ''); }} />
        <Range label="Маржа, %" minKey="marginMin" maxKey="marginMax" filters={filters} onChange={onChange} onClear={() => { onChange('marginMin', ''); onChange('marginMax', ''); }} />

        <div className="om-sheet-actions">
          <button className="om-btn" onClick={onReset}>Сбросить</button>
          <button className="om-btn om-btn-main" onClick={onClose}>
            Показать {formatNumber(count)}
          </button>
        </div>
      </div>
    </div>
  );
}

// Подозрительные начисления за доставку. На компьютере это таблица на 7 колонок; здесь —
// строки, где главное (во сколько раз дороже обычного) стоит справа крупно.
function DeliveryAnomalies({ data, onClose }) {
  return (
    <div className="card om-anomalies">
      <div className="om-anom-head">
        <div>
          <div className="om-anom-title">Подозрительная доставка</div>
          <div className="om-anom-sub">
            {formatNumber(data.checked_orders)} заказов с одним товаром · отличие от обычной цены минимум в 1,5 раза
          </div>
        </div>
        <button className="om-sheet-close" onClick={onClose} aria-label="Скрыть">×</button>
      </div>
      {data.anomalies.length === 0 ? (
        <div className="empty-state">Подозрительных начислений не найдено</div>
      ) : data.anomalies.map((a) => (
        <div key={`${a.order_number}_${a.product_id}`} className="om-anom-row">
          <div className="om-anom-name">{a.product_name}</div>
          {/* Красным — только то, что ДОРОЖЕ обычного (ratio > 1), как в таблице на компьютере:
              0,59× значит, что за доставку списали меньше медианы, и тревожиться не о чем. */}
          <div className={`om-anom-ratio${a.ratio > 1 ? ' om-negative' : ' om-anom-cheap'}`}>{a.ratio.toFixed(2)}×</div>
          <div className="om-anom-meta">
            {dayTitle(dayKey(a.date)).date} · №&nbsp;{a.order_number} · {formatNumber(a.quantity)} шт
          </div>
          <div className="om-anom-meta om-right">
            {formatMoney(a.delivery_cost)} вместо {formatMoney(a.median_per_unit)}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function OrdersMobile({
  orders, filtered, filters, warehouses, statusOptions, hasActiveFilters,
  onChange, onToggleSet, onSelectAll, onSelectNone, onReset,
  unknownPoints, loading, isOnline,
  checkingDelivery, deliveryAnomalies, deliveryCheckError, onCheckDelivery, onCloseDelivery,
}) {
  const [visibleDays, setVisibleDays] = useState(DAYS_STEP);
  const [openOrder, setOpenOrder] = useState(null);
  const [sheet, setSheet] = useState(false);

  // Сменили фильтр или поиск — снова показываем первые дни: иначе после сужения списка
  // человек остаётся с "показать ещё" на пустом месте.
  useEffect(() => { setVisibleDays(DAYS_STEP); }, [filters]);

  // Заказы приходят от сервера уже отсортированными по дате вниз, поэтому дни складываются
  // в правильном порядке простым проходом.
  const days = [];
  const byDay = new Map();
  filtered.forEach((o) => {
    const key = dayKey(o.date);
    if (!byDay.has(key)) { byDay.set(key, []); days.push(key); }
    byDay.get(key).push(o);
  });
  const shownDays = days.slice(0, visibleDays);

  return (
    <div className="om">
      <div className="om-head">
        <span className="om-count">
          {formatNumber(filtered.length)} из {formatNumber(orders.length)}
        </span>
      </div>

      {unknownPoints.length > 0 && (
        <div className="orders-unknown-point">
          <b>Появилась новая точка продаж — её нет в справочнике складов</b>
          {unknownPoints.map((p) => (
            <div key={p.pickup_point_id} className="orders-unknown-point-row">
              <code>{p.pickup_point_id}</code> — заказов: {p.orders_count}
            </div>
          ))}
          <span>
            Такие заказы не попадают в «Отчёт» и на «Склад», и себестоимость по ним не считается.
          </span>
        </div>
      )}

      <div className="om-bar">
        <input
          className="om-search"
          type="search"
          placeholder="Товар или номер заказа"
          value={filters.search}
          onChange={(e) => onChange('search', e.target.value)}
        />
        <button
          className="om-filter"
          aria-pressed={hasActiveFilters}
          onClick={() => setSheet(true)}
        >
          Фильтры
        </button>
      </div>

      <div className="om-tools">
        <button className="om-link" onClick={onCheckDelivery} disabled={checkingDelivery}>
          {checkingDelivery ? 'Проверяю доставку…' : 'Проверить доставку'}
        </button>
        {hasActiveFilters && (
          <button className="om-link" onClick={onReset}>Сбросить фильтры</button>
        )}
      </div>

      {deliveryCheckError && <div className="error-banner">{deliveryCheckError}</div>}
      {deliveryAnomalies && <DeliveryAnomalies data={deliveryAnomalies} onClose={onCloseDelivery} />}

      <div style={{
        opacity: loading || !isOnline ? 0.55 : 1,
        transition: 'opacity 0.25s ease',
      }}>
        {orders.length === 0 ? (
          <div className="empty-state">
            Ничего не найдено — убедитесь, что загружен отчёт Kaspi Pay на странице «Отчёт»
          </div>
        ) : shownDays.length === 0 ? (
          <div className="empty-state">Ничего не найдено по заданным фильтрам</div>
        ) : shownDays.map((day) => {
          const rows = byDay.get(day);
          const daySum = rows.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
          const title = dayTitle(day);
          return (
            <div className="om-day" key={day}>
              <div className="om-day-head">
                <div className="om-day-date">{title.date}<span>{title.week}</span></div>
                <div className="om-day-sum">{rows.length} <i>зак.</i> · {shortMoney(daySum)}</div>
              </div>
              {rows.map((o) => {
                const key = orderKey(o);
                const isReturn = o.operation_type === 'Возврат';
                const isOpen = openOrder === key;
                return (
                  <button
                    key={key}
                    className={`om-card${isReturn ? ' om-card-return' : ''}`}
                    aria-expanded={isOpen}
                    onClick={() => setOpenOrder((prev) => (prev === key ? null : key))}
                  >
                    <div className="om-card-top">
                      <span className="om-card-name">{o.product_name}</span>
                      <span className={`om-card-sum${isReturn ? ' om-negative' : ''}`}>
                        {formatMoney(o.amount)}
                      </span>
                    </div>
                    <div className="om-card-meta">
                      {isReturn && <><span className="om-return-tag">Возврат</span><span className="om-dot">·</span></>}
                      <span>{o.warehouse || '—'}</span>
                      <span className="om-dot">·</span>
                      <span>{formatNumber(o.quantity)} шт</span>
                      <span className="om-dot">·</span>
                      <span className={o.margin === null || o.margin === undefined ? 'om-margin' : `om-margin${o.margin < 0 ? ' om-negative' : ' om-positive'}`}>
                        маржа {formatPercent(o.margin)}
                      </span>
                    </div>
                    {isOpen && (
                      <div className="om-card-detail">
                        <div className="om-line"><span>№ заказа</span><span>{o.order_number}</span></div>
                        {/* Ноль в себестоимости — не "бесплатно", а "партия на «Поставках» не найдена",
                            и маржа по такому заказу завышена. Поэтому он подсвечен, а не спрятан. */}
                        <div className="om-line">
                          <span>Себестоимость</span>
                          <span className={Number(o.cost) ? '' : 'om-warn'}>{formatMoney(o.cost)}</span>
                        </div>
                        <div className="om-line"><span>Доставка</span><span>{formatMoney(o.delivery)}</span></div>
                        <div className="om-line"><span>Комиссия</span><span>{formatMoney(o.commission)}</span></div>
                        <div className="om-line"><span>Статус</span><span>{getStatusLabel(o)}</span></div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}

        {shownDays.length < days.length && (
          <button className="om-more" onClick={() => setVisibleDays((v) => v + DAYS_STEP)}>
            Показать ещё {Math.min(DAYS_STEP, days.length - shownDays.length)} дн. · осталось {days.length - shownDays.length}
          </button>
        )}
      </div>

      <div className="report-note">
        Список строится из загруженного Excel-отчёта Kaspi Pay (страница «Отчёт») — если он давно
        не обновлялся, здесь тоже будут старые данные. Себестоимость считается по методу FIFO на
        основе партий на «Поставках».
      </div>

      {sheet && (
        <FilterSheet
          filters={filters}
          count={filtered.length}
          warehouses={warehouses}
          statusOptions={statusOptions}
          onChange={onChange}
          onToggleSet={onToggleSet}
          onSelectAll={onSelectAll}
          onSelectNone={onSelectNone}
          onReset={onReset}
          onClose={() => setSheet(false)}
        />
      )}
    </div>
  );
}
