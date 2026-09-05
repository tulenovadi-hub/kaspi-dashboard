import React, { useEffect, useState } from 'react';
import { fetchAdExpenses, fetchSummary, fetchProducts } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo, startOfMonth } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';
import MetricChart from './MetricChart.jsx';
import CampaignFunnel, { METRICS } from './CampaignFunnel.jsx';

// ДРР считается двумя способами, и оба нужны:
//  * от продаж ПО РЕКЛАМЕ (gmv) — ровно то, что Kaspi называет "Доля рекламных расходов";
//  * от ВСЕЙ выручки за период — сколько процентов всего оборота съедает реклама. Это число
//    больше говорит о бизнесе: реклама может красиво выглядеть по своему gmv и при этом
//    съедать заметную долю всех денег магазина.
// Ни то, ни другое не храним — оба выводятся из уже имеющихся чисел.
function formatDrr(cost, revenue) {
  return revenue > 0 ? `${((cost / revenue) * 100).toFixed(1)}%` : '—';
}

// Выручка товаров, привязанных к кампании (по product_ids от Tampermonkey-скрипта, через
// merchantSku) — точное совпадение, без угадывания по названию кампании. Для блока кампании
// это и есть "вся выручка" в знаменателе второго ДРР.
function getMatchedRevenue(products, productIds) {
  if (!productIds || productIds.length === 0) return null;
  const matched = products.filter((p) => productIds.includes(p.product_id));
  if (matched.length === 0) return null;
  return matched.reduce((sum, p) => sum + Number(p.total_revenue || 0), 0);
}

// Производные показатели — ДРР и доля выручки по рекламе. Отдельным блоком в начале страницы,
// а не в строке воронки: они не переключают график (по дням отношение считать не на чем) и
// в общем ряду с кнопками только сбивали с толку. Пункт без значения не рисуется вовсе:
// у кампании без привязки к товару знаменателя нет, и прочерк был бы враньём.
function DerivedStats({ items }) {
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div className="card metric-summary">
      {shown.map((item) => (
        <div className="metric-summary-item" key={item.label}>
          <div className="metric-summary-value">{item.value}</div>
          <div className="metric-summary-label">{item.label}</div>
          {item.note && <div className="metric-summary-note">{item.note}</div>}
        </div>
      ))}
    </div>
  );
}

export default function Marketing({ password, active = true, isOnline = true }) {
  const [from, setFrom] = useState(() => toISODate(startOfMonth()));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('month');
  const [data, setData] = useState({ totalCost: 0, totalAdRevenue: 0, totals: {}, byDay: [], byCampaign: [] });
  const [selectedCampaign, setSelectedCampaign] = useState(null); // { campaign_id, campaign_name, product_ids }
  const [campaignData, setCampaignData] = useState({ totalCost: 0, totalAdRevenue: 0, totals: {}, byDay: [], byCampaign: [] });
  const [loading, setLoading] = useState(true);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [error, setError] = useState('');
  // Какой показатель сейчас на графике. По умолчанию расход — то, ради чего страница и делалась.
  const [metric, setMetric] = useState('cost');
  // Выручка магазина и товары нужны только для второго ДРР — от всей выручки, а не от продаж
  // по рекламе. Само по себе это не показатель Kaspi, поэтому и грузится отдельно.
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [products, setProducts] = useState([]);

  function loadData() {
    setLoading(true);
    setError('');
    Promise.all([
      fetchAdExpenses(password, from, to),
      fetchSummary(password, from, to, 'main'),
      fetchProducts(password, from, to, 'main'),
    ])
      .then(([adRes, summaryRes, productsRes]) => {
        setData(adRes);
        setTotalRevenue(summaryRes.days.reduce((sum, d) => sum + Number(d.total_revenue || 0), 0));
        setProducts(productsRes.products);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (active) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, password, from, to]);

  // Данные конкретной кампании — грузятся отдельно, только когда выбран товар
  useEffect(() => {
    if (!selectedCampaign) return;
    setCampaignLoading(true);
    fetchAdExpenses(password, from, to, selectedCampaign.campaign_id)
      .then((res) => setCampaignData(res))
      .catch((err) => setError(err.message))
      .finally(() => setCampaignLoading(false));
  }, [password, from, to, selectedCampaign]);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  const hasData = data.byCampaign.length > 0;
  // Воронку показываем, только если она реально загружена: у кампаний, выгруженных старым
  // скриптом, просмотров и кликов нет, и рисовать нули значило бы врать.
  const t = data.totals || {};
  const hasFunnel = (t.views || 0) + (t.clicks || 0) + (t.carts || 0) + (t.favorites || 0) > 0;
  const chartMetric = hasFunnel ? metric : 'cost';
  // Для кампании "вся выручка" — это выручка привязанных к ней товаров.
  const matchedRevenue = selectedCampaign ? getMatchedRevenue(products, selectedCampaign.product_ids) : null;

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Маркетинг <span>расходы на рекламу</span></h1>
      </div>

      <PeriodSelector from={from} to={to} activePreset={presetKey} onChange={handlePeriodChange} />

      {error && <div className="error-banner">{error}</div>}

      <div
        style={{
          opacity: loading || !isOnline ? 0.55 : 1,
          transition: 'opacity 0.25s ease',
          pointerEvents: loading ? 'none' : 'auto',
        }}
      >
        <DerivedStats
          items={[
            {
              label: 'ДРР',
              value: formatDrr(data.totalCost, data.totalAdRevenue),
              note: `${formatDrr(data.totalCost, totalRevenue)} от всей выручки`,
            },
            {
              label: 'Доля выручки по рекламе',
              value: formatDrr(data.totalAdRevenue, totalRevenue),
              note: `вся выручка за период ${formatMoney(totalRevenue)}`,
            },
          ]}
        />

        {hasFunnel ? (
          <CampaignFunnel
            totals={t}
            cost={data.totalCost}
            costLabel="расходы на рекламу"
            metric={metric}
            onSelect={setMetric}
          />
        ) : (
          <div className="stat-card" style={{ marginBottom: 20 }}>
            <div className="stat-label">Расходы на рекламу за период</div>
            <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(data.totalCost)}</div>
          </div>
        )}

        <div className="section-title">
          Динамика по дням{hasFunnel ? ` — ${METRICS[metric].label.toLowerCase()}` : ''}
        </div>
        <div className="card">
          <MetricChart
            data={data.byDay}
            dataKey={chartMetric}
            color={METRICS[chartMetric].color}
            money={METRICS[chartMetric].money}
          />
        </div>

        {selectedCampaign ? (
          <>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{selectedCampaign.campaign_name || selectedCampaign.campaign_id}</span>
              <button className="sync-button" onClick={() => setSelectedCampaign(null)}>Назад к списку</button>
            </div>
            <div className="card">
              <div
                style={{
                  opacity: campaignLoading ? 0.55 : 1,
                  transition: 'opacity 0.25s ease',
                }}
              >
                <DerivedStats
                  items={[
                    {
                      label: 'ДРР',
                      value: formatDrr(campaignData.totalCost, campaignData.totalAdRevenue),
                      note: matchedRevenue
                        ? `${formatDrr(campaignData.totalCost, matchedRevenue)} от выручки товара`
                        : null,
                    },
                    // У кампании "вся выручка" — это выручка её товаров. Без привязки к товару
                    // знаменателя нет, и показывать нечего.
                    matchedRevenue && {
                      label: 'Доля выручки по рекламе',
                      value: formatDrr(campaignData.totalAdRevenue, matchedRevenue),
                      note: `выручка товара ${formatMoney(matchedRevenue)}`,
                    },
                  ]}
                />

                {hasFunnel ? (
                  <CampaignFunnel
                    totals={campaignData.totals || {}}
                    cost={campaignData.totalCost}
                    costLabel="расходы на рекламу"
                    metric={metric}
                    onSelect={setMetric}
                  />
                ) : (
                  <div className="stat-card" style={{ marginBottom: 20 }}>
                    <div className="stat-label">Расходы на рекламу за период</div>
                    <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(campaignData.totalCost)}</div>
                  </div>
                )}
                {/* Привязку к товару проверяем по самой кампании, а не по её выручке: выручка
                    товара для этого блока больше не грузится, а знать о пропавшей привязке важно —
                    без неё расходы кампании не разнесутся по товарам в "Отчёте". */}
                {(!selectedCampaign.product_ids || selectedCampaign.product_ids.length === 0) && (
                  <div style={{ color: '#6b7690', fontSize: 12, marginBottom: 12 }}>
                    Для этой кампании ещё нет привязки к товару — обновите Tampermonkey-скрипт и заново нажмите
                    «Выгрузить расходы в дашборд».
                  </div>
                )}
                <MetricChart
                  data={campaignData.byDay}
                  dataKey={chartMetric}
                  color={METRICS[chartMetric].color}
                  money={METRICS[chartMetric].money}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="section-title">По кампаниям</div>
            <div className="card">
              {!hasData && !loading ? (
                <div className="empty-state">
                  Данных нет — загрузите расходы через Tampermonkey-скрипт на странице кампаний Kaspi Pay
                </div>
              ) : (
                <div className="table-scroll">
                  <table className="product-table">
                    <thead>
                      <tr>
                        <th>Кампания</th>
                        <th className="num">Расход за период</th>
                        <th className="num">Продажи по рекламе</th>
                        <th className="num">ДРР</th>
                        <th className="num">Доля от общих расходов</th>
                        {hasFunnel && <th className="num">Заказы</th>}
                        {hasFunnel && <th className="num">Просмотры</th>}
                        {hasFunnel && <th className="num">Клики</th>}
                        {hasFunnel && <th className="num">CTR</th>}
                        {hasFunnel && <th className="num">В корзину</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.byCampaign.map((c) => (
                        <tr
                          key={c.campaign_id}
                          className="batch-row"
                          onClick={() => setSelectedCampaign({ campaign_id: c.campaign_id, campaign_name: c.campaign_name, product_ids: c.product_ids })}
                        >
                          <td>{c.campaign_name || c.campaign_id}</td>
                          <td className="num">{formatMoney(c.cost)}</td>
                          <td className="num">{formatMoney(c.gmv)}</td>
                          <td className="num">{formatDrr(c.cost, c.gmv)}</td>
                          <td className="num">
                            {data.totalCost > 0 ? formatNumber(((c.cost / data.totalCost) * 100).toFixed(1)) : '0'}%
                          </td>
                          {hasFunnel && <td className="num">{formatNumber(c.transactions || 0)}</td>}
                          {hasFunnel && <td className="num">{formatNumber(c.views || 0)}</td>}
                          {hasFunnel && <td className="num">{formatNumber(c.clicks || 0)}</td>}
                          {hasFunnel && <td className="num">{c.views > 0 ? `${((c.clicks / c.views) * 100).toFixed(2)}%` : '—'}</td>}
                          {hasFunnel && <td className="num">{formatNumber(c.carts || 0)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="report-note">
        Данные заливаются вручную через Tampermonkey-скрипт со страницы кампаний Kaspi Pay (marketing.kaspi.kz) —
        официального API для расходов на рекламу у Kaspi нет. Эти цифры пока нигде больше на сайте не используются
        (не влияют на «Прочие расходы» в Отчёте и на «Чистую прибыль») — это отдельная, самостоятельная сводка.
        Привязка кампании к товару — точная, по merchantSku (вашему коду товара), а не по названию кампании.
        Все показатели считаются по дням, поэтому работают для любого выбранного здесь периода. Нажмите на строку
        кампании, чтобы увидеть данные именно по ней, а на любой показатель наверху — чтобы построить по нему график.
        У заказов кнопка двойная: первое нажатие — количество заказов, повторное — их сумма. «ДРР» показывается
        двумя числами: крупно — доля рекламных расходов от продаж ПО РЕКЛАМЕ (ровно то, что показывает Kaspi),
        мелким шрифтом под ним — та же реклама, но от ВСЕЙ выручки за период (а в блоке кампании — от выручки
        привязанных к ней товаров). Второе число обычно меньше и честнее отвечает на вопрос «какую долю моих денег
        съедает реклама». Рядом «доля выручки по рекламе» — сколько процентов всей выручки принесли заказы,
        засчитанные рекламе.
      </div>
    </div>
  );
}
