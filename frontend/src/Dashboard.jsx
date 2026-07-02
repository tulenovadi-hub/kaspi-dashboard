import React, { useEffect, useState } from 'react';
import Sidebar from './Sidebar.jsx';
import PeriodSelector from './PeriodSelector.jsx';
import TodayVsYesterday from './TodayVsYesterday.jsx';
import SalesChart from './SalesChart.jsx';
import ProductTable from './ProductTable.jsx';
import ProductDetail from './ProductDetail.jsx';
import Batches from './Batches.jsx';
import ComingSoon from './ComingSoon.jsx';
import { fetchSummary, fetchProducts, triggerSync } from './api.js';
import { toISODate, daysAgo, formatMoney, formatNumber } from './dateUtils.js';

const SECTION_TITLES = {
  report: 'Отчёт',
  expenses: 'Расходы',
  warehouse: 'Склад',
  marketing: 'Маркетинг',
};

export default function Dashboard({ password, onLogout }) {
  const [view, setView] = useState('sales'); // 'sales' | 'report' | 'expenses' | 'batches' | 'warehouse' | 'marketing'
  const [collapsed, setCollapsed] = useState(() => sessionStorage.getItem('sidebar_collapsed') === '1');

  const [from, setFrom] = useState(toISODate(daysAgo(6)));
  const [to, setTo] = useState(toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('7days');

  const [summaryDays, setSummaryDays] = useState([]);
  const [products, setProducts] = useState([]);
  const [todayRevenue, setTodayRevenue] = useState(0);
  const [yesterdayRevenue, setYesterdayRevenue] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);

  function loadData() {
    setLoading(true);
    setError('');

    const todayStr = toISODate(daysAgo(0));
    const yesterdayStr = toISODate(daysAgo(1));

    Promise.all([
      fetchSummary(password, from, to),
      fetchProducts(password, from, to),
      fetchSummary(password, yesterdayStr, todayStr),
    ])
      .then(([summaryRes, productsRes, recentRes]) => {
        setSummaryDays(summaryRes.days);
        setProducts(productsRes.products);

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
  }, [from, to]);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
    setSelectedProduct(null);
  }

  function handleManualSync() {
    setSyncing(true);
    triggerSync(password)
      .then(() => loadData())
      .catch((err) => setError(err.message))
      .finally(() => setSyncing(false));
  }

  function handleToggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      sessionStorage.setItem('sidebar_collapsed', next ? '1' : '0');
      return next;
    });
  }

  const totalRevenue = summaryDays.reduce((sum, d) => sum + Number(d.total_revenue), 0);
  const totalOrders = summaryDays.reduce((sum, d) => sum + Number(d.orders_count), 0);
  const avgOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  // Среднее количество заказов в день за период
  const daysCount = summaryDays.length || 1;
  const avgOrdersPerDay = totalOrders > 0 ? (totalOrders / daysCount).toFixed(1) : 0;

  function renderContent() {
    if (view === 'batches') {
      return <Batches password={password} onClose={() => setView('sales')} />;
    }

    if (SECTION_TITLES[view]) {
      return <ComingSoon title={SECTION_TITLES[view]} />;
    }

    // view === 'sales'
    return (
      <>
        <div className="app-header">
          <h1 className="app-title">Продажи <span>Kaspi</span></h1>
          <div className="sync-status">
            <button className="sync-button" onClick={handleManualSync} disabled={syncing}>
              {syncing ? 'Обновляем...' : 'Обновить сейчас'}
            </button>
          </div>
        </div>

        <TodayVsYesterday todayRevenue={todayRevenue} yesterdayRevenue={yesterdayRevenue} />

        <PeriodSelector from={from} to={to} activePreset={presetKey} onChange={handlePeriodChange} />

        {error && <div className="error-banner">{error}</div>}

        {loading ? (
          <div className="empty-state">Загрузка данных...</div>
        ) : (
          <>
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
            </div>

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
          </>
        )}
      </>
    );
  }

  return (
    <div className="layout">
      <Sidebar
        view={view}
        onSelect={setView}
        collapsed={collapsed}
        onToggleCollapse={handleToggleCollapse}
        onLogout={onLogout}
      />
      <div className="main-content">
        <div className="app">{renderContent()}</div>
      </div>
    </div>
  );
}
