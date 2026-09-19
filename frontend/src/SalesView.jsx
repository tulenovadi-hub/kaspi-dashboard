import React, { useEffect, useRef, useState } from 'react';
import TodayVsYesterday from './TodayVsYesterday.jsx';
import MetricLineChart from './MetricLineChart.jsx';
import ProductTable from './ProductTable.jsx';
import ProductDetail from './ProductDetail.jsx';
import { fetchSummary, fetchProducts, fetchSummaryProfit, fetchInventoryValue, fetchOrdersRevision, triggerSync } from './api.js';
import { toISODate, daysAgo, startOfMonth, formatMoney, formatNumber, formatPercent, shiftDays, daysInRange, formatOrders } from './dateUtils.js';
import SalesViewMobile, { SalesPeriodControls } from './SalesViewMobile.jsx';
import { useIsMobile } from './useIsMobile.js';
import { useAppRefresh } from './useAppRefresh.js';
import Odometer from './Odometer.jsx';

export default function SalesView({ password, onLogout, mode, title, showSync, active = true, isOnline = true }) {
  const [from, setFrom] = useState(toISODate(startOfMonth()));
  const [to, setTo] = useState(toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('month');

  const [summaryDays, setSummaryDays] = useState([]);
  const [products, setProducts] = useState([]);
  const [todayRevenue, setTodayRevenue] = useState(0);
  const [yesterdayRevenue, setYesterdayRevenue] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [periodNetProfit, setPeriodNetProfit] = useState(0);
  const [usedEstimate, setUsedEstimate] = useState(false);
  const [usedMarketingEstimate, setUsedMarketingEstimate] = useState(false);
  const [confirmedReturns, setConfirmedReturns] = useState(0);
  const [confirmedReturnImpact, setConfirmedReturnImpact] = useState(0);
  const [forecastBreakdown, setForecastBreakdown] = useState(null);
  // Чистая прибыль по дням — для переключаемого графика на телефоне и компьютере.
  // Приходит из того же /summary-profit, что и итоговая цифра.
  const [profitDays, setProfitDays] = useState([]);
  // Чистая прибыль по товарам — для разбивки под карточкой на телефоне. Приходит тем же
  // запросом; в ней нет маркетинга, операционных расходов и общего вычета возвратов
  // (они по магазину целиком), см.
  // computeSummaryNetProfit на бэкенде.
  const [profitProducts, setProfitProducts] = useState([]);

  // Итоги ПРЕДЫДУЩЕГО периода такой же длины — для процента изменения у каждого показателя
  // на телефоне. На компьютере не грузятся: там дельта только "сегодня к вчера" в блоке
  // TodayVsYesterday, и лишние два запроса на каждую смену периода ни к чему.
  const [prevTotals, setPrevTotals] = useState(null);
  // На компьютере карточки показателей теперь управляют тем же анимированным графиком, что
  // используется на телефоне. Выбранный показатель храним отдельно: мобильный компонент
  // управляет своей плиткой сам.
  const [desktopMetric, setDesktopMetric] = useState('revenue');

  const isMobile = useIsMobile();

  // Свайп вниз по странице просит перезапросить данные, не размонтируя её: содержимое
  // остаётся на месте и просто тускнеет, как в офлайне (см. useAppRefresh.js).
  const refreshTick = useAppRefresh(active);


  // "Деньги в товаре" — снимок на сейчас, а не за выбранный период, поэтому грузится один раз
  // и не перезапрашивается при смене дат. На самовыкупах не показывается: цифра общая по
  // магазину, среди самовыкупных продаж она читалась бы как их собственная.
  const [inventoryTotal, setInventoryTotal] = useState(null);
  // Те же деньги в разбивке по товарам (сумма равна total) — набор товаров тут свой: не те,
  // что продавались в периоде, а те, в которых сейчас лежат деньги.
  const [inventoryProducts, setInventoryProducts] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const revisionRef = useRef(null);
  const revisionPollBusyRef = useRef(false);

  function revisionSignature(revision) {
    return [
      revision.orders_count || 0,
      revision.active_orders_count || 0,
      revision.active_revenue || 0,
      revision.items_count || 0,
      revision.latest_creation || '',
    ].join(':');
  }

  // Предыдущий период: ровно столько же дней, вплотную до начала выбранного.
  // "С начала месяца" 01.09–08.09 (8 дней) сравнивается с 24.08–31.08.
  function previousRange() {
    const length = daysInRange(from, to);
    return { prevFrom: shiftDays(from, -length), prevTo: shiftDays(from, -1) };
  }

  function loadPrevTotals() {
    const { prevFrom, prevTo } = previousRange();
    setPrevTotals(null);
    Promise.all([
      fetchSummary(password, prevFrom, prevTo, mode),
      fetchSummaryProfit(password, prevFrom, prevTo, mode),
    ])
      .then(([summaryRes, profitRes]) => {
        const revenue = summaryRes.days.reduce((sum, d) => sum + Number(d.total_revenue), 0);
        const orders = summaryRes.days.reduce((sum, d) => sum + Number(d.orders_count), 0);
        setPrevTotals({
          from: prevFrom,
          to: prevTo,
          days: daysInRange(prevFrom, prevTo),
          revenue,
          orders,
          avg: orders > 0 ? revenue / orders : 0,
          profit: Number(profitRes.net_profit) || 0,
        });
      })
      .catch(() => setPrevTotals(null)); // сравнение необязательное — молча прячем процент
  }

  function loadData({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
      setError('');
    }

    const todayStr = toISODate(daysAgo(0));
    const yesterdayStr = toISODate(daysAgo(1));

    return Promise.all([
      fetchSummary(password, from, to, mode),
      fetchProducts(password, from, to, mode),
      fetchSummary(password, yesterdayStr, todayStr, mode),
      fetchSummaryProfit(password, from, to, mode),
      fetchOrdersRevision(password),
    ])
      .then(([summaryRes, productsRes, recentRes, profitRes, revisionRes]) => {
        revisionRef.current = revisionSignature(revisionRes);
        setSummaryDays(summaryRes.days);
        setProducts(productsRes.products);
        setPeriodNetProfit(Number(profitRes.net_profit) || 0);
        setUsedEstimate(!!profitRes.used_estimate);
        setUsedMarketingEstimate(!!profitRes.used_marketing_estimate);
        setConfirmedReturns(Number(profitRes.confirmed_returns) || 0);
        setConfirmedReturnImpact(Number(profitRes.confirmed_return_impact) || 0);
        setForecastBreakdown(profitRes.forecast_breakdown || null);
        setProfitDays(Array.isArray(profitRes.days) ? profitRes.days : []);
        setProfitProducts(Array.isArray(profitRes.products) ? profitRes.products : []);

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
        } else if (!silent) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }

  function loadInventory() {
    if (mode === 'selfbuy') return Promise.resolve();
    return fetchInventoryValue(password)
      .then((res) => {
        setInventoryTotal(res.total);
        setInventoryProducts(Array.isArray(res.by_product) ? res.by_product : []);
      })
      .catch(() => {}); // плитка необязательная — молча прячем, если не посчиталось
  }

  // active в зависимостях — не только реагируем на смену периода, но и перепроверяем данные
  // каждый раз, когда пользователь возвращается на этот раздел (страницы не размонтируются
  // при переключении, см. Dashboard.jsx, поэтому без этого повторный визит не обновил бы ничего).
  useEffect(() => {
    if (!active) return;
    loadInventory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, password, refreshTick]);

  useEffect(() => {
    if (active) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, from, to, mode, refreshTick]);

  useEffect(() => {
    if (active && isMobile) loadPrevTotals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isMobile, from, to, mode, refreshTick]);

  // Открытая Главная раз в 20 секунд спрашивает только короткую "ревизию" таблицы заказов.
  // Полный расчёт графиков и прибыли запускается лишь когда число/дата заказов изменились.
  // Сам Kaspi отсюда НЕ опрашивается — это независимо делает Oracle через /api/sync/live.
  useEffect(() => {
    if (!active || !isOnline) return undefined;

    async function checkForNewOrders() {
      if (document.hidden || syncing || revisionPollBusyRef.current) return;
      revisionPollBusyRef.current = true;
      try {
        const revision = await fetchOrdersRevision(password);
        const signature = revisionSignature(revision);
        if (revisionRef.current !== null && signature !== revisionRef.current) {
          revisionRef.current = signature;
          await Promise.all([loadData({ silent: true }), loadInventory()]);
        } else {
          revisionRef.current = signature;
        }
      } catch (err) {
        if (err.message === 'UNAUTHORIZED') onLogout();
        // Фоновая проверка необязательная: краткий сетевой сбой не должен перекрывать страницу.
      } finally {
        revisionPollBusyRef.current = false;
      }
    }

    const timer = window.setInterval(checkForNewOrders, 20 * 1000);
    const onVisibilityChange = () => {
      if (!document.hidden) checkForNewOrders();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isOnline, password, from, to, mode, syncing, refreshTick]);

  // Общий для телефона и компьютера выбор периода присылает ключ пресета; даты считаем здесь,
  // чтобы обе версии всегда запрашивали одинаковый диапазон.
  function handleMobilePreset(key) {
    const map = {
      today: [daysAgo(0), daysAgo(0)],
      yesterday: [daysAgo(1), daysAgo(1)],
      '7days': [daysAgo(6), daysAgo(0)],
      '14days': [daysAgo(13), daysAgo(0)],
      '30days': [daysAgo(29), daysAgo(0)],
      '90days': [daysAgo(89), daysAgo(0)],
      month: [startOfMonth(), daysAgo(0)],
    };
    const range = map[key];
    if (!range) return;
    handlePeriodChange({ from: toISODate(range[0]), to: toISODate(range[1]), presetKey: key });
  }

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  // Кнопка ждёт, пока сервер реально сходит в Kaspi (wait: true в api.js), и только потом
  // перечитывает страницу. До 2026-09-10 ответ приходил сразу, ещё до похода в Kaspi, и
  // страница обновлялась пустой — свежий заказ появлялся сам через несколько секунд, и
  // выглядело это так, будто кнопка не работает.
  function handleManualSync() {
    setSyncing(true);
    setSyncResult('');
    setError('');
    triggerSync(password)
      .then((res) => {
        setSyncResult(
          res && typeof res.orders === 'number'
            ? (res.orders > 0 ? `Из Kaspi: ${formatOrders(res.orders)}` : 'Новых заказов нет')
            : 'Готово'
        );
        return loadData();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSyncing(false));
  }

  const totalRevenue = summaryDays.reduce((sum, d) => sum + Number(d.total_revenue), 0);
  const totalOrders = summaryDays.reduce((sum, d) => sum + Number(d.orders_count), 0);
  const avgOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const periodMargin = totalRevenue > 0 ? (periodNetProfit / totalRevenue) * 100 : null;

  // Среднее количество заказов в день за период
  const daysCount = summaryDays.length || 1;
  const avgOrdersPerDay = totalOrders > 0 ? (totalOrders / daysCount).toFixed(1) : 0;
  const dayLabel = (value) => {
    const day = String(value).slice(0, 10);
    return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  };
  const summaryLabels = summaryDays.map((d) => dayLabel(d.day));
  const desktopMetrics = [
    {
      key: 'revenue',
      label: 'Сумма продаж за период',
      value: totalRevenue,
      format: formatMoney,
      series: summaryDays.map((d) => Number(d.total_revenue) || 0),
      labels: summaryLabels,
    },
    {
      key: 'orders',
      label: 'Количество заказов',
      value: totalOrders,
      format: formatNumber,
      series: summaryDays.map((d) => Number(d.orders_count) || 0),
      labels: summaryLabels,
      badge: `⌀ ${avgOrdersPerDay}/день`,
    },
    {
      key: 'avg',
      label: 'Средний чек',
      value: avgOrder,
      format: formatMoney,
      series: summaryDays.map((d) => (
        Number(d.orders_count) ? Number(d.total_revenue) / Number(d.orders_count) : 0
      )),
      labels: summaryLabels,
    },
    {
      key: 'profit',
      label: 'Чистая прибыль',
      value: periodNetProfit,
      format: formatMoney,
      series: profitDays.length ? profitDays.map((d) => Number(d.net_profit) || 0) : null,
      labels: profitDays.map((d) => dayLabel(d.day)),
      tone: periodNetProfit < 0 ? 'down' : 'up',
      margin: periodMargin,
    },
    ...(inventoryTotal !== null ? [{
      key: 'inventory',
      label: 'Деньги в товаре сейчас',
      value: inventoryTotal,
      format: formatMoney,
      snapshot: true,
      note: 'Остаток складов плюс оплаченное в пути — подробности на «Складе»',
    }] : []),
  ];
  const activeDesktopMetric = desktopMetrics.find((metric) => metric.key === desktopMetric)
    || desktopMetrics[0];
  const desktopChartColor = activeDesktopMetric.key === 'profit'
    ? (periodNetProfit < 0 ? 'var(--accent-down)' : 'var(--accent-up)')
    : 'var(--accent-brand)';

  if (isMobile) {
    return (
      <>
        {error && <div className="error-banner">{error}</div>}
        {loading && summaryDays.length === 0 && products.length === 0 ? (
          <div className="empty-state">Загрузка данных...</div>
        ) : (
          <div style={{
            opacity: loading || !isOnline ? 0.55 : 1,
            transition: 'opacity 0.25s ease',
            pointerEvents: loading ? 'none' : 'auto',
          }}>
            {selectedProduct ? (
              <ProductDetail
                password={password}
                product={selectedProduct}
                from={from}
                to={to}
                mode={mode}
                isOnline={isOnline}
                onClose={() => setSelectedProduct(null)}
              />
            ) : (
              <SalesViewMobile
                days={summaryDays}
                profitDays={profitDays}
                products={products}
                todayRevenue={todayRevenue}
                yesterdayRevenue={yesterdayRevenue}
                prevTotals={prevTotals}
                totalRevenue={totalRevenue}
                totalOrders={totalOrders}
                avgOrder={avgOrder}
                avgOrdersPerDay={avgOrdersPerDay}
                periodNetProfit={periodNetProfit}
                profitProducts={profitProducts}
                inventoryTotal={inventoryTotal}
                inventoryProducts={inventoryProducts}
                usedEstimate={usedEstimate}
                usedMarketingEstimate={usedMarketingEstimate}
                confirmedReturns={confirmedReturns}
                confirmedReturnImpact={confirmedReturnImpact}
                forecastBreakdown={forecastBreakdown}
                showMarketingNote={mode !== 'selfbuy'}
                from={from}
                to={to}
                presetKey={presetKey}
                onPeriodChange={handleMobilePreset}
                onCustomDates={(f, t) => handlePeriodChange({ from: f, to: t, presetKey: 'custom' })}
                showSync={showSync}
                syncResult={syncResult}
                syncing={syncing}
                onSync={handleManualSync}
                onSelectProduct={setSelectedProduct}
              />
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="app-header">
        <h1 className="app-title">{title}</h1>
        {showSync && (
          <div className="sync-status">
            {syncResult && <span className="sync-result">{syncResult}</span>}
            <button className="sync-button" onClick={handleManualSync} disabled={syncing}>
              {syncing ? 'Сверяем...' : 'Сверить с Kaspi'}
            </button>
          </div>
        )}
      </div>

      <TodayVsYesterday todayRevenue={todayRevenue} yesterdayRevenue={yesterdayRevenue} />

      <SalesPeriodControls
        from={from}
        to={to}
        presetKey={presetKey}
        onPeriodChange={handleMobilePreset}
        onCustomDates={(f, t) => handlePeriodChange({ from: f, to: t, presetKey: 'custom' })}
      />

      {error && <div className="error-banner">{error}</div>}

      {loading && summaryDays.length === 0 && products.length === 0 ? (
        // Самая первая загрузка страницы — данных ещё вообще никаких нет, показать нечего
        <div className="empty-state">Загрузка данных...</div>
      ) : (
        <div
          style={{
            opacity: loading || !isOnline ? 0.55 : 1,
            transition: 'opacity 0.25s ease',
            pointerEvents: loading ? 'none' : 'auto',
          }}
        >
          <div className={inventoryTotal !== null ? 'stats-row-auto' : 'stats-row'}>
            {desktopMetrics.map((metric) => (
              <button
                type="button"
                key={metric.key}
                className="stat-card sales-metric-card"
                aria-pressed={metric.key === activeDesktopMetric.key}
                onClick={() => setDesktopMetric(metric.key)}
              >
                <div className="stat-label">{metric.label}</div>
                <div className={`stat-value${metric.key === 'profit' ? ' profit-value-line' : ''}${metric.tone === 'up' ? ' profit-positive' : metric.tone === 'down' ? ' profit-negative' : ''}`}>
                  <Odometer value={metric.value} format={metric.format} />
                  {metric.key === 'profit' && (
                    <span className="profit-margin">маржа {formatPercent(metric.margin)}</span>
                  )}
                </div>
                {metric.badge && <div className="sales-metric-badge">{metric.badge}</div>}
                {metric.note && <div className="stat-card-hint">{metric.note}</div>}
              </button>
            ))}
          </div>

          <div className="section-title">{activeDesktopMetric.label} по дням</div>
          <div className="card sales-metric-chart-card">
            {activeDesktopMetric.series && activeDesktopMetric.series.length ? (
              <MetricLineChart
                values={activeDesktopMetric.series}
                labels={activeDesktopMetric.labels}
                color={desktopChartColor}
                height={360}
                format={activeDesktopMetric.format}
                responsiveWidth
              />
            ) : (
              <div className="sales-metric-no-chart">
                {activeDesktopMetric.snapshot
                  ? 'Снимок на сейчас — по дням периода не разбивается'
                  : 'За этот период дневных данных нет'}
              </div>
            )}
          </div>

          {usedEstimate && (
            <div style={{ color: '#6b7690', fontSize: 12, marginTop: -12, marginBottom: 16 }}>
              Kaspi Pay подтверждает {forecastBreakdown?.confirmedOrders || 0} из {forecastBreakdown?.totalOrders || 0} заказов
              {' '}({Math.round(Number(forecastBreakdown?.coveragePercent) || 0)}%).
              {Number(forecastBreakdown?.estimatedOrders) > 0 && (
                <> Для остальных точно учтены налог и доставка из заказа, себестоимость берётся по FIFO,
                  а комиссия Kaspi оценивается по истории товара.
                  {Number(forecastBreakdown?.fallbackCostItems) > 0 && (
                    <> Для {forecastBreakdown.fallbackCostItems} позиций без связанной партии себестоимость тоже оценена по истории.</>
                  )}
                  {' '}Прибыль подтверждённых заказов до общих расходов:{' '}
                  {formatMoney(forecastBreakdown.confirmedOrderProfit)}, оценка остальных:{' '}
                  {formatMoney(forecastBreakdown.estimatedOrderProfit)}.</>
              )}
              {Number(forecastBreakdown?.expectedReturnReserve) > 0 && (
                <> Резерв возможных возвратов: {formatMoney(forecastBreakdown.expectedReturnReserve)}.</>
              )}
              {Number(forecastBreakdown?.forecastHigh) > Number(forecastBreakdown?.forecastLow) && (
                <> Ожидаемый диапазон итоговой прибыли: {formatMoney(forecastBreakdown.forecastLow)}–{formatMoney(forecastBreakdown.forecastHigh)}.</>
              )}
            </div>
          )}

          {usedMarketingEstimate && (
            <div style={{ color: '#6b7690', fontSize: 12, marginTop: usedEstimate ? -4 : -12, marginBottom: 16 }}>
              По дням после последней маркетинговой выгрузки расходы оценены по исторической доле
              рекламы и бонусов в выручке за последние 60 дней. После загрузки свежих данных прогноз
              автоматически заменится фактическими расходами.
            </div>
          )}

          {confirmedReturns > 0 && (
            <div style={{ color: '#6b7690', fontSize: 12, marginTop: usedEstimate || usedMarketingEstimate ? -4 : -12, marginBottom: 16 }}>
              Подтверждённые возвраты Kaspi Pay: {formatMoney(confirmedReturns)}. Их чистое влияние после
              возврата комиссии, корректировки доставки и налога: −{formatMoney(confirmedReturnImpact)}.
            </div>
          )}

          {mode !== 'selfbuy' && (
            <div style={{ color: '#6b7690', fontSize: 12, marginTop: usedEstimate || usedMarketingEstimate || confirmedReturns > 0 ? -4 : -12, marginBottom: 16 }}>
              Из чистой прибыли также вычтены расходы на маркетинг (реклама, бонусы от продавца, бонусы за отзыв)
              и операционные расходы со страницы «Расходы» — категории «Прочие затраты» и «Упаковка».
              В разбивке по товарам эти общие расходы и подтверждённые возвраты распределены
              пропорционально выручке каждого товара, поэтому сумма прибыли по строкам равна общей прибыли.
              Расходы месяца раскладываются равными долями на каждый его день, чтобы периоды сравнивались
              честно, независимо от того, какого числа прошёл платёж. В незаконченном месяце делятся на
              прошедшие дни, а не на весь месяц. Для маркетинга используются фактические данные и прогноз
              за ещё не загруженные свежие дни.
            </div>
          )}

          {selectedProduct ? (
            <ProductDetail
              password={password}
              product={selectedProduct}
              from={from}
              to={to}
              mode={mode}
              isOnline={isOnline}
              onClose={() => setSelectedProduct(null)}
            />
          ) : (
            <>
              <div className="section-title">Продажи по товарам</div>
              <div className="card">
                <ProductTable products={products} profitProducts={profitProducts} onSelectProduct={setSelectedProduct} />
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
