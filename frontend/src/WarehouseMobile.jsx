import React from 'react';
import { formatMoney, formatNumber } from './dateUtils.js';

// Мобильная версия "Склада". На компьютере это таблица из восьми колонок; на айфоне от неё
// видно неполные три, и вбок уезжают как раз "Возвращается", "Себестоимость" и "Стоимость
// остатка" (замер 2026-09-07: таблица 799px при видимых 313). Поэтому здесь карточки:
// картинка, название и крупный остаток, а остальное — в развороте по тапу.
//
// Владелец выбрала этот вариант из двух макетов и попросила две вещи:
//   • не показывать в карточке "продано" — это история, а не состояние склада;
//   • сортировать товары по остатку, от большего к меньшему.
//
// Ни одна цифра из таблицы не потеряна: то, чего нет в шапке карточки, лежит в развороте.

const CARD_HIDDEN_HINT = 'Показано только то, что говорит о состоянии сейчас';

function shortMoney(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(1).replace('.', ',')} млн ₸`;
  return formatMoney(v);
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Сводка "Деньги в товаре": на компьютере это три карточки в ряд, на телефоне они встают
// в столбик и занимают весь первый экран. Здесь одна строка с итогом, разворачивается по тапу.
function InventoryBar({ inventory, open, onToggle }) {
  if (!inventory) return null;
  const {
    stock_value: stockValue, stock_by_warehouse: byWarehouse = [],
    in_transit_value: transitValue, in_transit_quantity: transitQty,
    in_transit_purchase: transitPurchase, in_transit_extra: transitExtra,
    deposits_value: depositsValue, total,
  } = inventory;

  return (
    <div className="wm-summary">
      <button className="wm-summary-bar" onClick={onToggle} aria-expanded={open}>
        <div className="wm-summary-main">
          <div className="wm-summary-label">Деньги в товаре</div>
          <div className="wm-summary-value">{formatMoney(total)}</div>
        </div>
        <div className="wm-summary-side">на складе<b>{shortMoney(stockValue)}</b></div>
        <div className="wm-summary-side">в пути<b>{shortMoney(transitValue)}</b></div>
      </button>
      <div className={`wm-collapsible${open ? ' is-open' : ''}`}>
        <div>
          <div className="wm-summary-details">
            <div>
              На складе по городам:{' '}
              {byWarehouse.length > 0
                ? byWarehouse.map((w) => `${w.warehouse} — ${formatMoney(w.value)}`).join(' · ')
                : 'остатков нет'}
            </div>
            <div>
              В пути: {formatNumber(transitQty)} шт · закупка {formatMoney(transitPurchase)} + логистика и прочее {formatMoney(transitExtra)}
              {depositsValue > 0 && <> · в том числе депозиты и авансы {formatMoney(depositsValue)}</>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WarehouseMobile({
  products, cities, images, imageBusy, expanded, onToggleExpand,
  onImageChange, onImageRemove, inventory, summaryOpen, onToggleSummary,
  activeCity, onSelectCity,
}) {
  const city = cities.includes(activeCity) ? activeCity : cities[0];
  // Сортировка по остатку: сверху то, чего много, внизу — то, что заканчивается.
  // При равных остатках порядок стабильный — по стоимости остатка.
  const cityProducts = products
    .filter((p) => (p.warehouse || 'Без склада') === city)
    .sort((a, b) => b.remaining - a.remaining || b.remaining_value - a.remaining_value);

  return (
    <div className="wm">
      <InventoryBar inventory={inventory} open={summaryOpen} onToggle={onToggleSummary} />

      {cities.length > 1 && (
        <div className="wm-cities">
          {cities.map((c) => {
            const total = products
              .filter((p) => (p.warehouse || 'Без склада') === c)
              .reduce((sum, p) => sum + p.remaining, 0);
            return (
              <button
                key={c}
                className="wm-city"
                aria-pressed={c === city}
                onClick={() => onSelectCity(c)}
              >
                {c} · {formatNumber(total)} шт
              </button>
            );
          })}
        </div>
      )}

      {cityProducts.length === 0 ? (
        <div className="card"><div className="empty-state">Ничего не найдено</div></div>
      ) : cityProducts.map((p) => {
        const rowKey = `${p.product_id}::${p.warehouse}`;
        const isOpen = expanded === rowKey;
        const busy = imageBusy === p.product_id;
        return (
          <article key={rowKey} className={`wm-card${isOpen ? ' is-open' : ''}`}>
            <div className="wm-card-head">
              {/* Картинку грузим тем же способом, что и на компьютере — иначе на телефоне
                  эта возможность просто исчезла бы. Клик по картинке не должен разворачивать
                  карточку, поэтому она вне кнопки-заголовка. */}
              <label className="wm-thumb-wrap" title="Нажмите, чтобы загрузить картинку">
                {images[p.product_id] ? (
                  <img className="wm-thumb" src={images[p.product_id]} alt={p.product_name} />
                ) : (
                  <div className="wm-thumb wm-thumb-empty" />
                )}
                <div className="wm-thumb-overlay">{busy ? '…' : '✎'}</div>
                {images[p.product_id] && !busy && (
                  <button
                    type="button"
                    className="wm-thumb-remove"
                    title="Удалить картинку"
                    onClick={(e) => onImageRemove(p.product_id, e)}
                  >
                    ×
                  </button>
                )}
                <input
                  type="file"
                  accept="image/*"
                  className="wm-thumb-input"
                  disabled={busy}
                  onChange={(e) => onImageChange(p.product_id, e)}
                />
              </label>

              <button className="wm-card-main" onClick={() => onToggleExpand(rowKey)} aria-expanded={isOpen}>
                <div className="wm-name">
                  <span className="wm-chevron">▶</span> {p.product_name}
                </div>
                <div className="wm-stock">
                  {formatNumber(p.remaining)}
                  <small>остаток</small>
                </div>
                <div className="wm-sub" title={CARD_HIDDEN_HINT}>
                  {p.in_progress > 0 && <span>в работе <b>{formatNumber(p.in_progress)}</b></span>}
                  {p.returning > 0 && <span className="wm-returning">возвращается <b>{formatNumber(p.returning)}</b></span>}
                  <span>в остатке <b>{shortMoney(p.remaining_value)}</b></span>
                </div>
                {p.oversold_qty > 0 && (
                  <div className="wm-warning">⚠ продано на {formatNumber(p.oversold_qty)} шт больше поставок</div>
                )}
              </button>
            </div>

            <div className={`wm-collapsible${isOpen ? ' is-open' : ''}`}>
              <div>
                <div className="wm-card-body">
                  <dl className="wm-kv">
                    <dt>Поставлено всего</dt><dd>{formatNumber(p.total_supplied)} шт</dd>
                    <dt>Продано</dt><dd>{formatNumber(p.total_sold)} шт</dd>
                    <dt>Себестоимость (FIFO)</dt><dd>{p.current_cost_price !== null ? formatMoney(p.current_cost_price) : '—'}</dd>
                    <dt>Стоимость остатка</dt><dd>{formatMoney(p.remaining_value)}</dd>
                  </dl>

                  <div className="wm-sub-title">Партии</div>
                  {p.batches.length === 0 ? (
                    <div className="wm-batch-meta">Партий нет — продажи есть, поставок не заведено</div>
                  ) : p.batches.map((b) => (
                    <div className="wm-batch" key={b.id}>
                      <div>Партия от {formatDate(b.received_date)}</div>
                      <div className="wm-batch-right">{formatNumber(b.remaining)} из {formatNumber(b.quantity)} шт</div>
                      <div className="wm-batch-meta">себестоимость {formatMoney(b.cost_price)}</div>
                      <div className="wm-batch-meta wm-batch-right">{b.remaining === 0 ? 'израсходована' : 'в остатке'}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
