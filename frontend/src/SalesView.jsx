import React, { useEffect, useState } from 'react';
import PeriodSelector from './PeriodSelector.jsx';
import TodayVsYesterday from './TodayVsYesterday.jsx';
import SalesChart from './SalesChart.jsx';
import ProductTable from './ProductTable.jsx';
import ProductDetail from './ProductDetail.jsx';
import { fetchSummary, fetchProducts, fetchSummaryProfit, triggerSync } from './api.js';
import { toISODate, daysAgo, formatMoney, formatNumber } from './dateUtils.js';

export default function SalesView({ password, onLogout, mode, title, showSync }) {
  const [from, setFrom] = useState(toISODate(daysAgo(6)));
  const [to, setTo] = useState(toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('7days');

  const [summaryDays, setSummaryDays] = useState([]);
  const [products, setProducts] = useState([]);
  const [todayRevenue, setTodayRevenue] = useState(0);
  const [yesterdayRevenue, setYesterdayRevenue] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [periodNetProfit, setPeriodNetProfit] = useState(0);
  const [usedEstimate, setUsedEstimate] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);

  function loadData() {
    setLoading(true);
    setError('');

    const todayStr = toISODate(daysAgo(0));
    const yesterdayStr = toISODate(daysAgo(1));

    Promise.all([
      fetchSummary(password, from, to, mode),
      fetchProducts(password, from, to, mode),
      fetchSummary(password, yesterdayStr, todayStr, mode),
      fetchSummaryProfit(password, from, to, mode),
    ])
      .then(([summaryRes, productsRes, recentRes, profitRes]) => {
        setSummaryDays(summaryRes.days);
        setProducts(productsRes.products);
        setPeriodNetProfit(Number(profitRes.net_profit) || 0);
        setUsedEstimate(!!profitRes.used_estimate);

        // Если сейчас открыт конкретный товар — не выкидываем на список при смене периода,
        // а просто подтягиваем его актуальные "Продано за период" под новый диапазон дат
        // (сам график внутри ProductDetail перезапросится самостоятельно по своим from/to).
        setSelectedProduct((prev) => {
          if (!prev) return prev;
          const fresh = productsRes.products.find((p) => p.product_id === prev.product_id);
          return fresh || { ...prev, total_quantity: 0, total_revenue: 0 };
        });

        const todayRow = recentRes.days.find((d) => toISODate(new Date(d.day)) === todayStr);
        const yesterdayRow = recentRes.days.find((d) => toISODate(new Date(d.day)) === yesterdayStr);
        setTodayRevenue(todayRow ? Number(todayRow.total_revenue) : 0);
        setYesterdayRevenue(yesterdayRow ? Number(yesterdayRow.total_revenue) : 0);
      })
      .catch((err) => {
        if (err.message === 'UNAUTHORIZED') {
          onLogout();
        } else {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, mode]);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  function handleManualSync() {
    setSyncing(true);
    triggerSync(password)
      .then(() => loadData())
      .catch((err) => setError(err.message))
      .finally(() => setSyncing(false));
  }

  const totalRevenue = summaryDays.reduce((sum, d) => sum + Number(d.total_revenue), 0);
  const totalOrders = summaryDays.reduce((sum, d) => sum + Number(d.orders_count), 0);
  const avgOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  // Среднее количество заказов в день за период
  const daysCount = summaryDays.length || 1;
  const avgOrdersPerDay = totalOrders > 0 ? (totalOrders / daysCount).toFixed(1) : 0;

  return (
    <>
      <div className="app-header">
        <h1 className="app-title">{title}</h1>
        {showSync && (
          <div className="sync-status">
            <button className="sync-button" onClick={handleManualSync} disabled={syncing}>
              {syncing ? 'Обновляем...' : 'Обновить сейчас'}
            </button>
          </div>
        )}
      </div>

      <TodayVsYesterday todayRevenue={todayRevenue} yesterdayRevenue={yesterdayRevenue} />

      <PeriodSelector from={from} to={to} activePreset={presetKey} onChange={handlePeriodChange} />

      {error && <div className="error-banner">{error}</div>}

      {loading && summaryDays.length === 0 && products.length === 0 ? (
        // Самая первая загрузка страницы — данных ещё вообще никаких нет, показать нечего
        <div className="empty-state">Загрузка данных...</div>
      ) : (
        <div
          style={{
            opacity: loading ? 0.55 : 1,
            transition: 'opacity 0.25s ease',
            pointerEvents: loading ? 'none' : 'auto',
          }}
        >
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-label">Сумма продаж за период</div>
              <div className="stat-value">{formatMoney(totalRevenue)}</div>
            </div>
            <div className="stat-card" style={{ position: 'relative' }}>
              <div className="stat-label">Количество заказов</div>
              <div className="stat-value">{formatNumber(totalOrders)}</div>
              <div style={{
                position: 'absolute',
                top: 12,
                right: 14,
                background: 'rgba(110, 139, 255, 0.15)',
                color: '#6e8bff',
                borderRadius: 8,
                padding: '2px 8px',
                fontSize: 11,
                fontFamily: 'JetBrains Mono, monospace',
              }}>
                ⌀ {avgOrdersPerDay}/день
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Средний чек</div>
              <div className="stat-value">{formatMoney(avgOrder)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Чистая прибыль</div>
              <div className="stat-value" style={{ color: periodNetProfit < 0 ? '#ff6b6b' : '#3ddc97' }}>
                {formatMoney(periodNetProfit)}
              </div>
            </div>
          </div>

          {usedEstimate && (
            <div style={{ color: '#6b7690', fontSize: 12, marginTop: -12, marginBottom: 16 }}>
              Примечание: по части заказов ещё не загружен свежий Excel-отчёт Kaspi Pay — их чистая прибыль оценена
              примерно, по среднему проценту прибыли уже посчитанных заказов с тем же товаром.
            </div>
          )}

          <div className="section-title">Динамика продаж</div>
          <div className="card">
            <SalesChart data={summaryDays} dataKey="total_revenue" />
          </div>

          {selectedProduct ? (
            <ProductDetail
              password={password}
              product={selectedProduct}
              from={from}
              to={to}
              mode={mode}
              onClose={() => setSelectedProduct(null)}
            />
          ) : (
            <>
              <div className="section-title">Продажи по товарам</div>
              <div className="card">
                <ProductTable products={products} onSelectProduct={setSelectedProduct} />
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
