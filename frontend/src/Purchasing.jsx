import React, { useEffect, useState } from 'react';
import { fetchPurchasing, updatePurchasingSettings, fetchProductImages } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';
import { useLiveRefresh } from './useLiveRefresh.js';

const STATUS_LABELS = { critical: 'Критично', soon: 'Скоро', normal: 'В норме' };
const TABS = [
  { key: 'all', label: 'Все' },
  { key: 'critical', label: 'Критично' },
  { key: 'soon', label: 'Скоро' },
  { key: 'normal', label: 'В норме' },
];

// Максимум дней остатка, который рисуем как полностью заполненный прогресс-бар —
// дальше просто "с запасом", разница уже не так важна визуально.
const DAYS_BAR_MAX = 45;

function SettingsModal({ password, settings, onClose, onSaved }) {
  const [leadTimeDays, setLeadTimeDays] = useState(String(settings.lead_time_days));
  const [bufferPct, setBufferPct] = useState(String(settings.buffer_pct));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    updatePurchasingSettings(password, { lead_time_days: leadTimeDays, buffer_pct: bufferPct })
      .then(() => onSaved())
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Настройка параметров закупа</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="batch-form-row-2">
            <div className="batch-form-field">
              <label>Срок поставки, дней</label>
              <input
                type="number"
                min="1"
                step="1"
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(e.target.value)}
                required
              />
            </div>
            <div className="batch-form-field">
              <label>Запас, %</label>
              <input
                type="number"
                min="0"
                step="1"
                value={bufferPct}
                onChange={(e) => setBufferPct(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="purchasing-settings-note">
            Точка заказа = Прод./день × срок поставки × (1 + запас%) — порог, ниже которого статус
            становится «Критично»/«Скоро». «К закупу» считается до уровня «точка заказа + ещё один
            срок поставки», чтобы не заказывать слишком часто мелкими партиями.
          </div>

          <button className="primary-button batch-submit" type="submit" disabled={saving}>
            {saving ? 'Сохраняем...' : 'Сохранить'}
          </button>
        </form>
      </div>
    </div>
  );
}

function exportCsv(products) {
  const headers = [
    'Товар', 'ID товара', 'Доступно (по городам)', 'Остаток', 'Прод./день', 'Точка заказа',
    'В пути', 'Ост. + В пути', 'Дней остатка', 'Лишнее кол-во', 'Статус', 'К закупу',
  ];
  const rows = products.map((p) => [
    p.product_name,
    p.product_id,
    p.available_by_city.map((c) => `${c.city}: ${c.qty}`).join('; '),
    p.remaining,
    p.daily_sales,
    p.reorder_point,
    p.in_transit,
    p.stock_plus_transit,
    p.days_left === null ? '' : p.days_left,
    p.excess_qty,
    STATUS_LABELS[p.status],
    p.to_purchase,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zakup_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Purchasing({ password, onGoToBatches }) {
  const [data, setData] = useState(null);
  const [images, setImages] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [showSettings, setShowSettings] = useState(false);

  function loadAll(silent) {
    if (!silent) setLoading(true);
    setError('');
    fetchPurchasing(password)
      .then((res) => {
        setData(res);
        const ids = Array.from(new Set(res.products.map((p) => p.product_id)));
        if (ids.length > 0) {
          fetchProductImages(password, ids)
            .then((imgRes) => setImages(imgRes.images || {}))
            .catch(() => {});
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveRefreshing = useLiveRefresh(['/api/purchasing', '/api/product-images'], () => loadAll(true));

  const products = data ? data.products : [];
  const filtered = products
    .filter((p) => !search || p.product_name.toLowerCase().includes(search.toLowerCase()))
    .filter((p) => activeTab === 'all' || p.status === activeTab);

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Закуп</h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!loading && data && (
        <>
          <div className="stats-row-2">
            <div className="stat-card">
              <div className="stat-label">К закупу</div>
              <div className="stat-value">{formatNumber(data.totals.to_purchase_qty)} шт</div>
              <div className="stat-sublabel">{formatMoney(data.totals.to_purchase_value)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Лишний остаток</div>
              <div className="stat-value">{formatNumber(data.totals.excess_qty)} шт</div>
              <div className="stat-sublabel">{formatMoney(data.totals.excess_value)}</div>
            </div>
          </div>

          <div className="period-bar">
            {TABS.map((t) => {
              const count = t.key === 'all' ? products.length : data.totals[t.key];
              return (
                <button
                  key={t.key}
                  className={`period-chip ${activeTab === t.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.label} ({count})
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="batches-toolbar">
        <input
          className="toolbar-input"
          type="text"
          placeholder="Поиск по товару..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="secondary-button" onClick={() => setShowSettings(true)}>
          Настройка параметров
        </button>
        <button className="secondary-button" onClick={() => exportCsv(filtered)}>
          Экспорт CSV
        </button>
        <button className="primary-button toolbar-create" onClick={onGoToBatches}>
          + Создать поставку
        </button>
      </div>

      <div className="card" style={{ opacity: liveRefreshing ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Ничего не найдено по заданным фильтрам</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Товары</th>
                  <th>Доступно</th>
                  <th className="num">Остаток</th>
                  <th className="num">Прод./день</th>
                  <th className="num">Точка заказа</th>
                  <th className="num">В пути</th>
                  <th className="num">Ост. + В пути</th>
                  <th>Дней ост.</th>
                  <th className="num">Лишнее кол-во</th>
                  <th>Статус</th>
                  <th className="num">К закупу</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const barPct = p.days_left === null ? 0 : Math.min(100, (p.days_left / DAYS_BAR_MAX) * 100);
                  return (
                    <tr key={p.product_id}>
                      <td>
                        <div className="warehouse-product-cell">
                          {images[p.product_id] ? (
                            <img className="warehouse-thumb" src={images[p.product_id]} alt={p.product_name} />
                          ) : (
                            <div className="warehouse-thumb warehouse-thumb-empty" />
                          )}
                          <div>
                            <div>{p.product_name}</div>
                            <div className="purchasing-formula-hint">{p.product_id}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {p.available_by_city.length === 0 ? (
                          <span className="purchasing-none">—</span>
                        ) : (
                          <div className="purchasing-city-badges">
                            {p.available_by_city.map((c) => (
                              <span key={c.city} className="purchasing-city-badge">{c.city} — {formatNumber(c.qty)}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="num">{formatNumber(p.remaining)}</td>
                      <td className="num">
                        {p.daily_sales}
                        <div className="purchasing-buffer-badge">▲ +{data.settings.buffer_pct}%</div>
                      </td>
                      <td className="num">
                        {formatNumber(p.reorder_point)}
                        <div className="purchasing-formula-hint">
                          {p.daily_sales} × {data.settings.lead_time_days} д. + {data.settings.buffer_pct}%
                        </div>
                      </td>
                      <td className="num">{p.in_transit > 0 ? formatNumber(p.in_transit) : <span className="purchasing-none">—</span>}</td>
                      <td className="num">{formatNumber(p.stock_plus_transit)}</td>
                      <td>
                        <div className="purchasing-days-cell">
                          <div className="purchasing-days-bar-row">
                            <div className="purchasing-days-bar-track">
                              <div className={`purchasing-days-bar-fill ${p.status}`} style={{ width: `${barPct}%` }} />
                            </div>
                            <span className="purchasing-days-value">{p.days_left === null ? '—' : p.days_left}</span>
                          </div>
                          <span className="purchasing-days-hint">мин. {data.settings.lead_time_days} дн.</span>
                        </div>
                      </td>
                      <td className="num">
                        {p.excess_qty > 0 ? (
                          <>
                            {formatNumber(p.excess_qty)} шт
                            <div className="purchasing-formula-hint">{formatMoney(p.excess_value)}</div>
                          </>
                        ) : (
                          <span className="purchasing-none">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`purchasing-status-pill ${p.status}`}>{STATUS_LABELS[p.status]}</span>
                      </td>
                      <td className="num">
                        {p.to_purchase > 0 ? (
                          <>
                            {formatNumber(p.to_purchase)} шт
                            <div className="purchasing-formula-hint">{formatMoney(p.to_purchase_value)}</div>
                          </>
                        ) : (
                          <span className="purchasing-none">— не нужно</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && (
        <div className="report-note">
          «Точка заказа» и «К закупу» считаются по формуле (s, S): скорость продаж — среднее за последние {data.sales_window_days} дней.
          «В пути» — партии со статусом «В пути» на странице «Поставки» (заказаны у поставщика, но ещё не прибыли на склад).
          «Доступно» — реальный остаток по городам (метод FIFO), как на странице «Склад».
        </div>
      )}

      {showSettings && data && (
        <SettingsModal
          password={password}
          settings={data.settings}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setShowSettings(false);
            loadAll();
          }}
        />
      )}
    </div>
  );
}
