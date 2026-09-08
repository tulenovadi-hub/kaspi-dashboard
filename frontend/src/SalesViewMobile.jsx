import React, { useState } from 'react';
import MetricLineChart from './MetricLineChart.jsx';
import { formatMoney, formatNumber, percentChange } from './dateUtils.js';

// Мобильная "Главная". На компьютере это блок "вчера/сегодня", полоса периодов, пять карточек
// показателей в ряд, график и таблица товаров. На телефоне карточки встают в столбик, и
// страница вырастает до 1873px — 2,3 экрана, из которых первый почти целиком шапка, а график
// начинается только после ~900px прокрутки (замер 2026-09-07).
//
// Владелец выбрала вариант "один показатель крупно": сверху выбранный показатель большой цифрой
// и его график, остальные — маленькими плитками; тап переключает и цифру, и линию графика.
// Ничего из компьютерной версии не убрано: кнопка "Обновить сейчас", семь пресетов периода и
// свои даты, все пять показателей, обе сноски (свёрнуты) и карточка товара — на месте.

const PRESETS = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: '7days', label: '7 дней' },
  { key: '14days', label: '14 дней' },
  { key: '30days', label: '30 дней' },
  { key: '90days', label: '90 дней' },
  { key: 'month', label: 'С начала месяца' },
];

function shortMoney(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(2).replace('.', ',')} млн ₸`;
  return formatMoney(v);
}

function dayLabel(iso) {
  const d = String(iso).slice(0, 10);
  return `${d.slice(8, 10)}.${d.slice(5, 7)}`;
}

export default function SalesViewMobile({
  days, profitDays, products, todayRevenue, yesterdayRevenue,
  totalRevenue, totalOrders, avgOrder, avgOrdersPerDay, periodNetProfit,
  inventoryTotal, usedEstimate, showMarketingNote,
  from, to, presetKey, onPeriodChange, onCustomDates,
  showSync, syncing, onSync, onSelectProduct,
}) {
  const [metric, setMetric] = useState('revenue');
  const [showDates, setShowDates] = useState(presetKey === 'custom');
  const [showNotes, setShowNotes] = useState(false);

  const delta = percentChange(todayRevenue, yesterdayRevenue);
  const labels = days.map((d) => dayLabel(d.day));

  // Показатели — те же пять карточек, что на компьютере. series есть у тех, кого сервер
  // отдаёт по дням; у "Денег в товаре" его нет и быть не может — это снимок на сейчас.
  const METRICS = [
    {
      key: 'revenue', label: 'Сумма продаж', value: formatMoney(totalRevenue),
      series: days.map((d) => Number(d.total_revenue) || 0),
    },
    {
      key: 'orders', label: 'Количество заказов', value: formatNumber(totalOrders),
      hint: `⌀ ${avgOrdersPerDay}/день`,
      series: days.map((d) => Number(d.orders_count) || 0),
    },
    {
      key: 'avg', label: 'Средний чек', value: formatMoney(avgOrder),
      series: days.map((d) => (Number(d.orders_count) ? Number(d.total_revenue) / Number(d.orders_count) : 0)),
    },
    {
      key: 'profit', label: 'Чистая прибыль', value: formatMoney(periodNetProfit),
      tone: periodNetProfit < 0 ? 'down' : 'up',
      series: profitDays.length ? profitDays.map((d) => Number(d.net_profit) || 0) : null,
    },
    ...(inventoryTotal !== null ? [{
      key: 'inventory', label: 'Деньги в товаре сейчас', value: formatMoney(inventoryTotal),
      short: shortMoney(inventoryTotal), snapshot: true,
      note: 'Остаток складов плюс оплаченное в пути — подробности на «Складе»',
    }] : []),
  ];

  const current = METRICS.find((m) => m.key === metric) || METRICS[0];
  const color = current.key === 'profit'
    ? (periodNetProfit < 0 ? 'var(--accent-down)' : 'var(--accent-up)')
    : 'var(--accent-brand)';

  function applyPreset(key) {
    setShowDates(false);
    onPeriodChange(key);
  }

  return (
    <div className="svm">
      <div className="svm-head">
        <h1 className="app-title">Главная</h1>
        {showSync && (
          <button className="sync-button" onClick={onSync} disabled={syncing}>
            {syncing ? 'Обновляем...' : 'Обновить сейчас'}
          </button>
        )}
      </div>

      <div className="svm-chips">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className="svm-chip"
            aria-pressed={presetKey === p.key}
            onClick={() => applyPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          className="svm-chip"
          aria-pressed={presetKey === 'custom' || showDates}
          onClick={() => setShowDates((v) => !v)}
        >
          Свой период
        </button>
      </div>

      <div className={`wm-collapsible${showDates ? ' is-open' : ''}`}>
        <div>
          <div className="svm-dates">
            <input type="date" value={from} max={to} onChange={(e) => onCustomDates(e.target.value, to)} />
            <span>—</span>
            <input type="date" value={to} min={from} onChange={(e) => onCustomDates(from, e.target.value)} />
          </div>
        </div>
      </div>

      <div className="svm-big">
        <div className="svm-big-row">
          <div>
            <div className="svm-big-label">
              {current.label}{current.snapshot ? ' · на сейчас' : ' · за период'}
            </div>
            <div className={`svm-big-value${current.tone === 'up' ? ' svm-up' : current.tone === 'down' ? ' svm-down' : ''}`}>
              {current.value}
            </div>
          </div>
          <div className={`svm-delta ${delta === null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
            {delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`}
          </div>
        </div>
        <div className="svm-big-sub">
          сегодня {formatMoney(todayRevenue)} · вчера {formatMoney(yesterdayRevenue)}
          {current.hint ? ` · ${current.hint}` : ''}
        </div>

        {current.series ? (
          <MetricLineChart values={current.series} labels={labels} color={color} />
        ) : (
          <div className="svm-no-chart">
            {current.snapshot
              ? 'Снимок на сейчас — по дням периода не разбивается'
              : 'За этот период дневных данных нет'}
          </div>
        )}
        {current.note && <div className="svm-metric-note">{current.note}</div>}

        <div className="svm-minis">
          {METRICS.map((m) => (
            <button
              key={m.key}
              className="svm-mini"
              aria-pressed={m.key === metric}
              onClick={() => setMetric(m.key)}
            >
              <div className="svm-mini-label">{m.label}</div>
              <div className={`svm-mini-value${m.tone === 'up' ? ' svm-up' : m.tone === 'down' ? ' svm-down' : ''}`}>
                {m.short || m.value}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Обе сноски с компьютера — текста на треть экрана, поэтому свёрнуты. */}
      {(usedEstimate || showMarketingNote) && (
        <>
          <button className="svm-notes-toggle" onClick={() => setShowNotes((v) => !v)} aria-expanded={showNotes}>
            {showNotes ? 'Скрыть примечания' : 'Как считается прибыль'}
          </button>
          <div className={`wm-collapsible${showNotes ? ' is-open' : ''}`}>
            <div>
              <div className="svm-notes">
                {usedEstimate && (
                  <p>
                    По части заказов ещё не загружен свежий Excel-отчёт Kaspi Pay — их чистая прибыль
                    оценена примерно, по среднему проценту прибыли уже посчитанных заказов с тем же товаром.
                  </p>
                )}
                {showMarketingNote && (
                  <p>
                    Из чистой прибыли также вычтены расходы на маркетинг (реклама, бонусы от продавца,
                    бонусы за отзыв) за выбранный период — только то, что фактически загружено, без
                    прогноза за недостающие дни.
                  </p>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="svm-sec-title">Продажи по товарам</div>
      <div className="card svm-products">
        {products.length === 0 ? (
          <div className="empty-state">За выбранный период продаж по товарам не было</div>
        ) : products.map((p) => {
          const maxRevenue = Math.max(...products.map((x) => Number(x.total_revenue) || 0), 1);
          const revenue = Number(p.total_revenue) || 0;
          return (
            <button
              key={p.product_id || p.product_name}
              className="svm-prod"
              onClick={() => onSelectProduct(p)}
            >
              <div className="svm-prod-name">{p.product_name}</div>
              <div className="svm-prod-sum">{formatMoney(revenue)}</div>
              <div className="svm-prod-meta">{formatNumber(p.total_quantity)} шт</div>
              <div className="svm-prod-meta svm-right">
                {totalRevenue > 0 ? `${Math.round((revenue / totalRevenue) * 100)}% выручки` : ''}
              </div>
              <div className="svm-prod-bar"><i style={{ width: `${(revenue / maxRevenue) * 100}%` }} /></div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
