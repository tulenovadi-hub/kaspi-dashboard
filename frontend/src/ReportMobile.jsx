import React, { useState } from 'react';
import { formatMoney, formatMonthLabel, formatPercent } from './dateUtils.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';
// Наборы показателей НЕ дублируются здесь: они выводятся из колонок таблиц в reportColumns.js,
// поэтому мобильная версия не может отстать от компьютерной — новая колонка появляется в обеих
// сама. Всё, что относится к показателям (порядок ленты, знак, пояснения), правится там же.
import { METRICS, MONTH_LINES, PRODUCT_LINES } from './reportColumns.js';
import { useClosing } from './useClosing.js';

// Мобильная версия "Отчёта". На компьютере страница — четыре таблицы, у главной 14 колонок;
// на айфоне от неё видно две с половиной колонки из четырнадцати, а "Чистая прибыль" и "Маржа"
// стоят последними — до них таблицу нужно протянуть вбок на четыре экрана, и к этому моменту
// название месяца уже уехало из виду. Поэтому здесь другая раскладка, выбранная владельцем
// 2026-09-07 из двух макетов:
//
//   показатель (лента сверху) → месяцы столбиками → тап по месяцу → все статьи месяца
//   → тап по товару → все статьи этого товара
//
// Мобильная версия — отдельный компонент, а не CSS: рисовать оба дерева и прятать одно значило бы
// грузить разбивки по товарам дважды. Показатели при этом общие с таблицей (см. reportColumns.js).

const SCOPES = [
  { key: 'main', label: 'Алматы + Астана' },
  { key: 'all', label: 'Все склады' },
];

// "Авг. 26", но "Май 26" — у коротких названий месяцев сокращать нечего, и точка после них
// выглядит опечаткой.
function shortMonth(monthKey) {
  const [year] = monthKey.split('-');
  const name = formatMonthLabel(monthKey).split(' ')[0];
  const short = name.length <= 4 ? name : `${name.slice(0, 3)}.`;
  return `${short} ${year.slice(2)}`;
}

// Одна строка разбора: статья, сумма, её доля от полной выручки и та же доля полоской.
// Справочная себестоимость возвратов выделяется жёлтым и не получает процент: она не участвует
// в расчёте чистой прибыли.
function Line({ line, row }) {
  const value = row[line.key];

  // Показателя нет в данных вообще — рисуем прочерк и почему. Пропустить строку нельзя:
  // отсутствие строки читается как "такого расхода не было", а это неправда.
  if (value === undefined || value === null) {
    return (
      <div className="rm-line">
        <div className="rm-line-label">{line.label}</div>
        <div className="rm-line-value rm-line-empty">—</div>
        {line.note && <div className="rm-line-share">{line.note}</div>}
      </div>
    );
  }

  const share = row.revenue ? (value / row.revenue) * 100 : 0;
  const valueClass = line.informational
    ? 'report-cell-yellow'
    : (line.credit ? 'report-cell-green' : 'report-cell-red');
  const prefix = line.informational ? '' : (line.credit ? '+' : '−');
  return (
    <div className="rm-line">
      <div className="rm-line-label">{line.label}</div>
      <div className={`rm-line-value ${valueClass}`}>
        {prefix}{formatMoney(value)}
      </div>
      {line.informational ? (
        <div className="rm-line-share">{line.note}</div>
      ) : (
        <>
          <div className="rm-line-share">{share.toFixed(1)}% от выручки</div>
          <div className="rm-line-bar">
            <i style={{ width: `${Math.min(100, Math.abs(share))}%`, background: line.credit ? 'var(--accent-up)' : 'var(--accent-down)' }} />
          </div>
        </>
      )}
    </div>
  );
}

function Breakdown({ row, lines }) {
  return (
    <div className="rm-breakdown">
      <div className="rm-line rm-line-strong">
        <div className="rm-line-label">Выручка</div>
        <div className="rm-line-value report-cell-green">{formatMoney(row.revenue)}</div>
      </div>
      {lines.map((line) => <Line key={line.key} line={line} row={row} />)}
      <div className="rm-line rm-line-total">
        <div className="rm-line-label">Чистая прибыль</div>
        <div className={`rm-line-value ${row.net_profit >= 0 ? 'report-cell-green' : 'report-cell-red'}`}>
          {formatMoney(row.net_profit)}
        </div>
        <div className="rm-line-share">
          Маржа {formatPercent(row.margin)} · ROI {formatPercent(row.roi)}
        </div>
      </div>
    </div>
  );
}

// Список товаров месяца. Свёрнутая строка показывает три главных числа, тап разворачивает
// все остальные — те же колонки, что в разбивке по товарам на компьютере.
function ProductList({ products, loading, error, openProduct, onToggleProduct }) {
  if (loading) return <div className="rm-products-state">Загрузка разбивки по товарам...</div>;
  if (error) return <div className="rm-products-state rm-products-error">{error}</div>;
  if (!products || products.length === 0) return <div className="rm-products-state">Продаж по товарам за этот месяц нет</div>;

  return products.map((p) => {
    const isOpen = openProduct === p.product_id;
    return (
      <div key={p.product_id} className={`rm-product${isOpen ? ' is-open' : ''}`}>
        <button className="rm-product-head" onClick={() => onToggleProduct(p.product_id)} aria-expanded={isOpen}>
          <div className="rm-product-name">{isOpen ? '▾' : '▸'} {p.product_name}</div>
          <div className={`rm-product-profit ${p.net_profit >= 0 ? 'report-cell-green' : 'report-cell-red'}`}>
            {formatMoney(p.net_profit)}
          </div>
          <div className="rm-product-meta">выручка {formatMoney(p.revenue)}</div>
          <div className="rm-product-meta rm-right">маржа {formatPercent(p.margin)}</div>
        </button>
        {isOpen && <div className="rm-product-body"><Breakdown row={p} lines={PRODUCT_LINES} /></div>}
      </div>
    );
  });
}

function MonthSheet({ month, scope, products, loading, error, onClose }) {
  const { closing, close } = useClosing(onClose);
  const [openProduct, setOpenProduct] = useState(null);
  useBodyScrollLock();

  return (
    <div className={`rm-sheet-overlay${closing ? ' is-closing' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="rm-sheet" role="dialog" aria-label={formatMonthLabel(month.month)}>
        <div className="rm-sheet-grip" />
        <div className="rm-sheet-head">
          <div>
            <div className="rm-sheet-title">{formatMonthLabel(month.month)}</div>
            <div className="rm-sheet-scope">{SCOPES.find((s) => s.key === scope).label}</div>
          </div>
          <button className="rm-sheet-close" onClick={close} aria-label="Закрыть">×</button>
        </div>
        <Breakdown row={month} lines={MONTH_LINES} />
        <div className="rm-sheet-section">По товарам</div>
        <ProductList
          products={products}
          loading={loading}
          error={error}
          openProduct={openProduct}
          onToggleProduct={(id) => setOpenProduct((prev) => (prev === id ? null : id))}
        />
      </div>
    </div>
  );
}

export default function ReportMobile({
  monthsAll, monthsMainCities, onLoadProducts, productBreakdowns, productLoading, productError,
}) {
  const [scope, setScope] = useState('main');
  const [metricKey, setMetricKey] = useState('net_profit');
  const [sheetMonth, setSheetMonth] = useState(null);

  const months = scope === 'all' ? monthsAll : monthsMainCities;
  const metric = METRICS.find((m) => m.key === metricKey) || METRICS[0];

  // Масштаб полосок — по самому большому значению среди месяцев, поэтому длина полоски
  // сравнима только внутри одного показателя. Значение подписано у каждой полоски.
  const maxValue = months.reduce((max, m) => Math.max(max, Math.abs(Number(m[metric.key]) || 0)), 0);
  const total = months.reduce((sum, m) => sum + (Number(m[metric.key]) || 0), 0);

  function openMonth(monthKey) {
    setSheetMonth(monthKey);
    onLoadProducts(scope, monthKey);
  }

  const sheetRow = sheetMonth ? months.find((m) => m.month === sheetMonth) : null;
  const cacheKey = `${scope}:${sheetMonth}`;

  return (
    <div className="rm">
      <div className="rm-scope">
        {SCOPES.map((s) => (
          <button
            key={s.key}
            className="rm-scope-pill"
            aria-pressed={s.key === scope}
            onClick={() => setScope(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="rm-scope-hint">
        {scope === 'main'
          ? 'Только склады основного магазина — без самовыкупов'
          : 'Все заказы, включая самовыкупы и заказы с нераспознанной точкой продаж'}
      </div>

      <div className="rm-metrics">
        {METRICS.map((m) => (
          <button
            key={m.key}
            className="rm-metric"
            aria-pressed={m.key === metricKey}
            onClick={() => setMetricKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="rm-caption">
        <span>{metric.label} по месяцам</span>
        <span>
          {metric.percent
            ? <>в среднем <b>{formatPercent(months.length ? total / months.length : 0)}</b></>
            : <>всего <b>{formatMoney(total)}</b></>}
        </span>
      </div>

      <div className="card rm-card">
        {months.length === 0 ? (
          <div className="empty-state">Нет данных за загруженный период</div>
        ) : months.map((m) => {
          const value = Number(m[metric.key]) || 0;
          const width = maxValue === 0 ? 0 : (Math.abs(value) / maxValue) * 100;
          const negative = value < 0;
          const color = negative || metric.tone === 'down'
            ? 'var(--accent-down)'
            : (metric.tone === 'warn' ? 'var(--accent-warn)' : 'var(--accent-up)');
          const valueToneClass = negative
            ? ' report-cell-red'
            : (metric.tone === 'warn' ? ' report-cell-yellow' : '');
          return (
            <button key={m.month} className="rm-bar-row" onClick={() => openMonth(m.month)}>
              <div className="rm-bar-month">{shortMonth(m.month)}</div>
              <div className="rm-bar-line">
                <div className="rm-bar-track"><i style={{ width: `${width}%`, background: color }} /></div>
                <div className={`rm-bar-value${valueToneClass}`}>
                  {metric.percent ? formatPercent(value) : formatMoney(value)}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rm-hint">Тап по месяцу — все статьи и разбивка по товарам</div>

      {sheetRow && (
        <MonthSheet
          month={sheetRow}
          scope={scope}
          products={productBreakdowns[cacheKey]}
          loading={!!productLoading[cacheKey]}
          error={productError[cacheKey]}
          onClose={() => setSheetMonth(null)}
        />
      )}
    </div>
  );
}
