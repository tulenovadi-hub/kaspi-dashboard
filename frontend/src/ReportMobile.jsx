import React, { useState } from 'react';
import { formatMoney, formatMonthLabel, formatPercent } from './dateUtils.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';

// Мобильная версия "Отчёта". На компьютере страница — четыре таблицы, у главной 14 колонок;
// на айфоне от неё видно две с половиной колонки из четырнадцати, а "Чистая прибыль" и "Маржа"
// стоят последними — до них таблицу нужно протянуть вбок на четыре экрана, и к этому моменту
// название месяца уже уехало из виду. Поэтому здесь другая раскладка, выбранная владельцем
// 2026-09-07 из двух макетов:
//
//   показатель (лента сверху) → месяцы столбиками → тап по месяцу → все статьи месяца
//   → тап по товару → все статьи этого товара
//
// ВАЖНО: набор показателей здесь ОБЯЗАН совпадать с MAIN_COLUMNS/PRODUCT_COLUMNS в Report.jsx.
// Это единственная причина, по которой мобильная версия — отдельный компонент, а не CSS: если
// в отчёт добавят колонку, её нужно дописать и сюда, иначе на телефоне цифра просто исчезнет.

// Показатели в ленте — это все 13 колонок MAIN_COLUMNS, кроме самого месяца. Порядок не как в
// таблице, а по частоте использования: прибыль и маржа первыми.
const METRICS = [
  { key: 'net_profit', label: 'Чистая прибыль', tone: 'up' },
  { key: 'margin', label: 'Маржа', tone: 'up', percent: true },
  { key: 'revenue', label: 'Выручка', tone: 'up' },
  { key: 'cost_of_goods', label: 'Себестоимость', tone: 'down' },
  { key: 'commission', label: 'Комиссия', tone: 'down' },
  { key: 'marketing', label: 'Маркетинг', tone: 'down' },
  { key: 'delivery', label: 'Доставка', tone: 'down' },
  { key: 'taxes', label: 'Налоги (3%)', tone: 'down' },
  { key: 'returns', label: 'Возвраты', tone: 'down' },
  { key: 'cost_of_returns', label: 'Себестоимость возвратов', tone: 'down' },
  { key: 'packaging', label: 'Упаковка', tone: 'down' },
  { key: 'other_expenses', label: 'Прочие расходы', tone: 'down' },
  { key: 'roi', label: 'ROI', tone: 'up', percent: true },
];

// Статьи месяца в том порядке, в котором они съедают выручку. Набор = MAIN_COLUMNS без
// выручки, прибыли, маржи и ROI — они показываются отдельно, в шапке и итоге.
const MONTH_LINES = [
  { key: 'cost_of_goods', label: 'Себестоимость' },
  { key: 'returns', label: 'Возвраты' },
  { key: 'cost_of_returns', label: 'Себестоимость возвратов', credit: true },
  { key: 'commission', label: 'Комиссия' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'taxes', label: 'Налоги (3%)' },
  { key: 'marketing', label: 'Маркетинг' },
  { key: 'packaging', label: 'Упаковка' },
  { key: 'other_expenses', label: 'Прочие расходы' },
];

// То же для товара = PRODUCT_COLUMNS: маркетинг раскрыт на три источника, упаковки нет вовсе,
// "Прочие расходы" сервер по товарам не считает — как и в таблице, показываем прочерк.
const PRODUCT_LINES = [
  { key: 'cost_of_goods', label: 'Себестоимость' },
  { key: 'returns', label: 'Возвраты' },
  { key: 'cost_of_returns', label: 'Себестоимость возвратов', credit: true },
  { key: 'commission', label: 'Комиссия' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'taxes', label: 'Налоги (3%)' },
  { key: 'marketing_ads', label: 'Реклама товаров' },
  { key: 'marketing_bonuses', label: 'Бонусы от продавца' },
  { key: 'marketing_reviews', label: 'Бонусы за отзыв' },
  { key: 'other_expenses', label: 'Прочие расходы', note: 'не разносятся по товарам' },
];

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

// Одна строка разбора: статья, сумма, её доля от выручки и та же доля полоской.
// Доля считается от выручки той строки, к которой относится: у месяца — от выручки месяца,
// у товара — от выручки товара (ровно как в таблице на компьютере).
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
  return (
    <div className="rm-line">
      <div className="rm-line-label">{line.label}</div>
      <div className={`rm-line-value ${line.credit ? 'report-cell-green' : 'report-cell-red'}`}>
        {line.credit ? '+' : '−'}{formatMoney(value)}
      </div>
      <div className="rm-line-share">{share.toFixed(1)}% от выручки</div>
      <div className="rm-line-bar">
        <i style={{ width: `${Math.min(100, Math.abs(share))}%`, background: line.credit ? 'var(--accent-up)' : 'var(--accent-down)' }} />
      </div>
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
  const [openProduct, setOpenProduct] = useState(null);
  useBodyScrollLock();

  return (
    <div className="rm-sheet-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rm-sheet" role="dialog" aria-label={formatMonthLabel(month.month)}>
        <div className="rm-sheet-grip" />
        <div className="rm-sheet-head">
          <div>
            <div className="rm-sheet-title">{formatMonthLabel(month.month)}</div>
            <div className="rm-sheet-scope">{SCOPES.find((s) => s.key === scope).label}</div>
          </div>
          <button className="rm-sheet-close" onClick={onClose} aria-label="Закрыть">×</button>
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
          const color = negative || metric.tone === 'down' ? 'var(--accent-down)' : 'var(--accent-up)';
          return (
            <button key={m.month} className="rm-bar-row" onClick={() => openMonth(m.month)}>
              <div className="rm-bar-month">{shortMonth(m.month)}</div>
              <div className="rm-bar-line">
                <div className="rm-bar-track"><i style={{ width: `${width}%`, background: color }} /></div>
                <div className={`rm-bar-value${negative ? ' report-cell-red' : ''}`}>
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
