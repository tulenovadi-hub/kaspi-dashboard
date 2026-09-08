import React, { useState } from 'react';
import { formatMoney, formatNumber, formatDateDMY } from './dateUtils.js';

// Мобильная версия "Поставок". На компьютере это таблица из восьми колонок шириной 916px при
// видимых 313 — до кнопки "Прибыло" нужно протянуть почти три экрана вбок, — плюс шесть
// фильтров подряд высотой в треть экрана до первой строки.
//
// Владелец выбрала вариант "сначала то, что едет": экран начинается с блока "Ждём прибытия"
// (только поставки в пути, с суммой вложенного), история прибывших свёрнута внизу. Порядок в
// обеих лентах — по дате создания записи, новые сверху (см. byCreated ниже).
// Регулярное действие на этой странице ровно одно — отметить пришедшую поставку, — и оно
// должно быть первым, до чего дотягивается палец.
//
// Форма создания и редактирования тут СВОЯ НЕ ДЕЛАЕТСЯ: карточка открывает ту же BatchModal,
// что и на компьютере (её в Batches.jsx открывает родитель). Иначе форма из 14 полей и
// произвольного списка статей расходов разъехалась бы между версиями при первой же правке.

function daysUntil(iso) {
  const target = new Date(String(iso).slice(0, 10));
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

function EtaLabel({ date }) {
  const days = daysUntil(date);
  if (days < 0) return <span className="bm-eta bm-eta-soon">просрочена на {-days} дн.</span>;
  if (days === 0) return <span className="bm-eta bm-eta-soon">сегодня</span>;
  return <span className={`bm-eta${days <= 7 ? ' bm-eta-soon' : ''}`}>через {days} дн.</span>;
}

// Крестика "удалить" в списке нет намеренно: владелец попросила убрать его с обзорного экрана,
// чтобы не задеть случайно при прокрутке. Удаление живёт внутри открытой карточки.
function BatchCard({ batch, onOpen, onAskReceive }) {
  const inTransit = batch.status === 'in_transit';
  const noLogistics = !batch.logistics_cost || Number(batch.logistics_cost) === 0;

  return (
    <div className={`bm-card${inTransit ? ' bm-card-transit' : ''}`}>
      <button className="bm-card-main" onClick={() => onOpen(batch)}>
        <div className="bm-card-top">
          <div>
            <div className="bm-name">{batch.product_name}</div>
            <div className="bm-id">#{batch.id} · {batch.warehouse}</div>
          </div>
          <div className={`bm-status${inTransit ? ' in-transit' : ''}`}>{inTransit ? 'В пути' : 'Прибыло'}</div>
        </div>
        <div className="bm-grid">
          <div>
            <div className="bm-cell-label">{inTransit ? 'Ожидается' : 'Поступила'}</div>
            <div className="bm-cell-value">{formatDateDMY(batch.received_date)}</div>
          </div>
          <div>
            <div className="bm-cell-label">Себестоимость</div>
            <div className="bm-cell-value">
              {formatMoney(batch.cost_price)}
              {noLogistics && <span className="bm-missing">⚠ логистика не внесена</span>}
            </div>
          </div>
          <div>
            <div className="bm-cell-label">Заявлено</div>
            <div className="bm-cell-value">{formatNumber(batch.quantity)} шт</div>
          </div>
        </div>
        {batch.note && <div className="bm-note">{batch.note}</div>}
      </button>
      {inTransit && (
        <button className="bm-receive" onClick={() => onAskReceive(batch)}>
          Отметить прибывшей
        </button>
      )}
    </div>
  );
}

// Подтверждение прибытия отдельным окном: без него кнопка стоит прямо в ленте, и случайный
// тап молча переводил бы товар в остаток склада (владелец попросила спросить).
export function ReceiveConfirm({ batch, onConfirm, onCancel, busy }) {
  return (
    <div className="bm-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bm-dialog" role="dialog" aria-modal="true">
        <div className="bm-dialog-title">Поставка прибыла?</div>
        <div className="bm-dialog-text">
          Товар встанет в остаток склада и начнёт списываться продажами по FIFO.
          Дату поступления поставим сегодняшнюю.
        </div>
        <div className="bm-dialog-facts">
          <div><b>#{batch.id}</b> · {batch.product_name}</div>
          <div className="bm-id">
            {batch.warehouse} · {formatNumber(batch.quantity)} шт · {formatMoney(batch.cost_price)} за штуку
          </div>
        </div>
        <div className="bm-dialog-actions">
          <button className="bm-btn bm-btn-ok" onClick={onConfirm} disabled={busy}>
            {busy ? 'Отмечаем…' : 'Да, прибыла'}
          </button>
          <button className="bm-btn bm-btn-quiet" onClick={onCancel} disabled={busy}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

export default function BatchesMobile({
  batches, products, warehouses, search, onSearch,
  productFilter, onProductFilter, warehouseFilter, onWarehouseFilter,
  onCreate, onOpen, onAskReceive,
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // Обе ленты — по дате СОЗДАНИЯ записи, новые сверху: владелец попросила 2026-09-08, чтобы
  // только что заведённая поставка оказывалась первой, а не терялась среди прочих по дате
  // прибытия. Дата прибытия осталась в самой карточке и в подписи "через N дней".
  const byCreated = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  const transit = batches.filter((b) => b.status === 'in_transit').sort(byCreated);
  const received = batches.filter((b) => b.status !== 'in_transit').slice().sort(byCreated);

  const transitQty = transit.reduce((sum, b) => sum + Number(b.quantity || 0), 0);
  const transitValue = transit.reduce((sum, b) => sum + Number(b.cost_price || 0) * Number(b.quantity || 0), 0);

  return (
    <div className="bm">
      <div className="bm-summary">
        <div className="bm-summary-main">
          <div className="bm-summary-label">Ждём прибытия</div>
          <div className="bm-summary-value">
            {transit.length} {plural(transit.length, 'поставка', 'поставки', 'поставок')} · {formatNumber(transitQty)} шт
          </div>
        </div>
        <div className="bm-summary-side">вложено<b>{formatMoney(transitValue)}</b></div>
      </div>

      <button className="primary-button bm-create" onClick={onCreate}>+ Создать новую поставку</button>

      {transit.length === 0 ? (
        <div className="bm-empty">В пути ничего нет — всё приехало</div>
      ) : transit.map((b) => (
        <React.Fragment key={b.id}>
          <div className="bm-eta-row">
            <EtaLabel date={b.received_date} />
            <span className="bm-id">{formatDateDMY(b.received_date)}</span>
          </div>
          <BatchCard batch={b} onOpen={onOpen} onAskReceive={onAskReceive} />
        </React.Fragment>
      ))}

      <div className="bm-group-title">
        Прибывшие<span>{received.length}</span>
      </div>

      <div className="bm-toolbar">
        <input
          className="toolbar-input bm-search"
          type="text"
          placeholder="Поиск по товару..."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        <button
          className="bm-filter-btn"
          aria-pressed={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          Фильтры
        </button>
      </div>

      <div className={`wm-collapsible${showFilters ? ' is-open' : ''}`}>
        <div>
          <div className="bm-filters">
            <select className="toolbar-select" value={productFilter} onChange={(e) => onProductFilter(e.target.value)}>
              <option value="">Все товары</option>
              {products.map((p) => <option key={p.product_id} value={p.product_id}>{p.product_name}</option>)}
            </select>
            <select className="toolbar-select" value={warehouseFilter} onChange={(e) => onWarehouseFilter(e.target.value)}>
              <option value="">Все склады</option>
              {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
        </div>
      </div>

      <button className="bm-collapse" onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? 'Свернуть историю' : `Показать историю (${received.length})`}
      </button>

      <div className={`wm-collapsible${showHistory ? ' is-open' : ''}`}>
        <div>
          <div className="bm-history">
            {received.length === 0
              ? <div className="bm-empty">Прибывших поставок пока нет</div>
              : received.map((b) => <BatchCard key={b.id} batch={b} onOpen={onOpen} onAskReceive={onAskReceive} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

// 1 поставка, 2 поставки, 5 поставок — цифра меняется на глазах после подтверждения прибытия,
// поэтому "4 поставок" в шапке было бы сразу заметно.
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
