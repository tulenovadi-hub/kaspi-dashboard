import React, { useState } from 'react';
import { formatMoney, formatNumber } from './dateUtils.js';

// Мобильная версия "Закупа". На компьютере это самая широкая таблица в приложении — одиннадцать
// колонок, 997px при видимых 313 (замер 2026-09-07): вбок уезжает всё, кроме названия товара,
// включая саму цифру "К закупу". Плюс до первой строки приходилось листать 672px шапки — две
// плитки итогов в столбик, четыре вкладки и четыре кнопки одна под другой.
//
// Здесь: те же вкладки и тот же порядок, но строка стала карточкой, две плитки итогов ужаты в
// одну строку, а "Настройка параметров" и "Экспорт CSV" убраны под кнопку "⋯".
//
// Ни одна колонка не потеряна: то, чего нет в шапке карточки, лежит в развороте.

const STATUS = {
  critical: ['pm-pill-crit', 'Критично'],
  soon: ['pm-pill-soon', 'Скоро'],
  normal: ['pm-pill-ok', 'В норме'],
};

const TABS = [
  { key: 'all', label: 'Все' },
  { key: 'critical', label: 'Критично' },
  { key: 'soon', label: 'Скоро' },
  { key: 'normal', label: 'В норме' },
];

// Та же шкала, что и в колонке "Дней ост." на компьютере
const DAYS_BAR_MAX = 45;

function shortMoney(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(2).replace('.', ',')} млн ₸`;
  return formatMoney(v);
}

function Chevron() {
  return (
    <svg className="pm-chevron" viewBox="0 0 8 12" width="7" height="10" aria-hidden="true" focusable="false">
      <path d="M1.6 1.4 6 6l-4.4 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Шкала запаса из двух частей: густая — то, что реально лежит на складе, полупрозрачная —
// сколько дней добавит товар в пути. Одной полосой (как в таблице) было не видно, что запас
// держится на ещё не приехавшей партии: у T15 PRO это 14 дней на полке против 35 "всего".
function DaysBar({ product, leadTimeDays }) {
  const { days_left: daysTotal, in_transit: inTransit, status } = product;
  // days_stock присылает сервер. Фолбэк нужен для ответа из офлайн-кэша, сохранённого до
  // появления этого поля (sw.js кэширует ответы API): считаем из округлённых продаж в день —
  // на день-два от серверного значения это не отличается, зато шкала не ломается.
  const daysStock = product.days_stock !== undefined && product.days_stock !== null
    ? product.days_stock
    : (product.daily_sales > 0 ? product.remaining / product.daily_sales : null);

  if (daysTotal === null) {
    return (
      <>
        <div className="pm-days-row">
          <div className="pm-days-track" />
          <div className="pm-days-value">—</div>
        </div>
        <div className="pm-days-caption">продаж нет — срок не посчитать</div>
      </>
    );
  }

  const stockPct = Math.min(100, ((daysStock || 0) / DAYS_BAR_MAX) * 100);
  const transitPct = Math.max(0, Math.min(100 - stockPct, ((daysTotal - (daysStock || 0)) / DAYS_BAR_MAX) * 100));
  const hasTransit = inTransit > 0 && transitPct > 0;

  return (
    <>
      <div className="pm-days-row">
        <div className="pm-days-track">
          <i className={`pm-seg-stock ${status}`} style={{ width: `${stockPct}%` }} />
          {hasTransit && <i className={`pm-seg-transit ${status}`} style={{ width: `${transitPct}%` }} />}
        </div>
        <div className="pm-days-value">
          {Math.round(daysStock)} дн.
          {hasTransit && <span className="pm-days-total"> ({Math.round(daysTotal)})</span>}
        </div>
      </div>
      <div className="pm-days-caption">
        {hasTransit
          ? `на складе хватит на ${Math.round(daysStock)} дн., с тем что в пути — на ${Math.round(daysTotal)} · минимум ${leadTimeDays}`
          : `хватит на столько дней · минимум ${leadTimeDays}`}
      </div>
    </>
  );
}

export default function PurchasingMobile({
  products, totals, settings, images, search, onSearch,
  activeTab, onTab, onOpenSettings, onExportCsv, onGoToBatches, totalCount,
  onHide, changingProductId,
}) {
  const [openId, setOpenId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="pm">
      <div className="pm-totals">
        <div className="pm-tile pm-tile-buy">
          <div className="pm-tile-label">К закупу</div>
          <div className="pm-tile-value">{formatNumber(totals.to_purchase_qty)} шт</div>
          <div className="pm-tile-sub">{formatMoney(totals.to_purchase_value)}</div>
        </div>
        <div className="pm-tile">
          <div className="pm-tile-label">Лишний остаток</div>
          <div className="pm-tile-value">{formatNumber(totals.excess_qty)} шт</div>
          <div className="pm-tile-sub">{shortMoney(totals.excess_value)}</div>
        </div>
      </div>

      <div className="pm-toolbar">
        <input
          className="toolbar-input pm-search"
          type="text"
          placeholder="Поиск по товару..."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        <button className="pm-more" aria-pressed={menuOpen} onClick={() => setMenuOpen((v) => !v)}>⋯</button>
      </div>

      {menuOpen && (
        <div className="pm-menu">
          <button onClick={() => { setMenuOpen(false); onOpenSettings(); }}>Настройка параметров</button>
          <button onClick={() => { setMenuOpen(false); onExportCsv(); }}>Экспорт CSV</button>
        </div>
      )}

      <button className="primary-button pm-create" onClick={onGoToBatches}>+ Создать поставку</button>

      <div className="pm-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className="pm-tab"
            aria-pressed={t.key === activeTab}
            onClick={() => { onTab(t.key); setOpenId(null); }}
          >
            {t.label} ({t.key === 'all' ? totalCount : totals[t.key]})
          </button>
        ))}
      </div>

      {products.length === 0 ? (
        <div className="card"><div className="empty-state">Ничего не найдено по заданным фильтрам</div></div>
      ) : products.map((p) => {
        const [pillClass, pillLabel] = STATUS[p.status];
        const isOpen = openId === p.product_id;
        return (
          <article key={p.product_id} className={`pm-card${isOpen ? ' is-open' : ''}${p.status === 'critical' ? ' pm-card-crit' : ''}`}>
            <button
              className="pm-card-head"
              onClick={() => setOpenId(isOpen ? null : p.product_id)}
              aria-expanded={isOpen}
            >
              {images[p.product_id] ? (
                <img className="pm-thumb" src={images[p.product_id]} alt={p.product_name} />
              ) : (
                <div className="pm-thumb pm-thumb-empty" />
              )}
              <div className="pm-card-main">
                <div className="pm-title-row">
                  <div className="pm-name"><Chevron /> {p.product_name}</div>
                  <span className={`pm-pill ${pillClass}`}>{pillLabel}</span>
                </div>
                <DaysBar product={p} leadTimeDays={settings.lead_time_days} />
                <div className="pm-sub">
                  <span>остаток <b>{formatNumber(p.remaining)}</b></span>
                  {p.in_transit > 0 && <span>в пути <b>{formatNumber(p.in_transit)}</b></span>}
                  {p.to_purchase > 0 && <span className="pm-c-crit">к закупу <b>{formatNumber(p.to_purchase)}</b></span>}
                  {p.excess_qty > 0 && <span className="pm-c-warn">лишнее <b>{formatNumber(p.excess_qty)}</b></span>}
                </div>
              </div>
            </button>

            <div className={`wm-collapsible${isOpen ? ' is-open' : ''}`}>
              <div>
                <div className="pm-card-body">
                  <dl className="wm-kv">
                    <dt>Остаток на складах</dt><dd>{formatNumber(p.remaining)} шт</dd>
                    <dt>В пути</dt><dd>{p.in_transit > 0 ? `${formatNumber(p.in_transit)} шт` : '—'}</dd>
                    <dt>Остаток + в пути</dt><dd>{formatNumber(p.stock_plus_transit)} шт</dd>
                    <dt>Продаж в день</dt><dd>{p.daily_sales}</dd>
                    <dt>Точка заказа</dt><dd>{formatNumber(p.reorder_point)} шт</dd>
                    <dt>Лишний остаток</dt>
                    <dd className={p.excess_qty > 0 ? 'pm-c-warn' : ''}>
                      {p.excess_qty > 0 ? `${formatNumber(p.excess_qty)} шт · ${formatMoney(p.excess_value)}` : '—'}
                    </dd>
                    <dt>К закупу</dt>
                    <dd className={p.to_purchase > 0 ? 'pm-c-crit' : ''}>
                      {p.to_purchase > 0 ? `${formatNumber(p.to_purchase)} шт · ${formatMoney(p.to_purchase_value)}` : '—'}
                    </dd>
                    <dt>Себестоимость</dt><dd>{p.cost_price ? formatMoney(p.cost_price) : '—'}</dd>
                  </dl>
                  <div className="pm-formula">
                    точка заказа = {p.daily_sales} × {settings.lead_time_days} д. + {settings.buffer_pct}%
                  </div>
                  <div className="wm-sub-title">Доступно по складам</div>
                  {p.available_by_city.length === 0 ? (
                    <div className="pm-formula">на складах пусто</div>
                  ) : (
                    <div className="pm-cities">
                      {p.available_by_city.map((c) => (
                        <span key={c.city} className="pm-city">{c.city} — {formatNumber(c.qty)}</span>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="pm-hide-product"
                    disabled={changingProductId === p.product_id}
                    onClick={() => onHide(p.product_id)}
                  >
                    {changingProductId === p.product_id ? 'Скрываем…' : 'Скрыть товар'}
                  </button>
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
