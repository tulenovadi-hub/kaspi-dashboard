import React, { useEffect, useState } from 'react';
import { fetchAdExpenses, fetchSummary, fetchProducts } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';
import SalesChart from './SalesChart.jsx';

// Считает суммарную выручку товаров, привязанных к кампании (по её product_ids, полученным
// от Tampermonkey-скрипта через merchantSku) — точное совпадение, без угадывания по названию.
function getMatchedRevenue(products, productIds) {
  if (!productIds || productIds.length === 0) return null;
  const matched = products.filter((p) => productIds.includes(p.product_id));
  if (matched.length === 0) return null;
  return matched.reduce((sum, p) => sum + Number(p.total_revenue || 0), 0);
}

function DrrCard({ cost, revenue }) {
  const drr = revenue > 0 ? (cost / revenue) * 100 : null;
  return (
    <div className="stat-card">
      <div className="stat-label">ДРР за период</div>
      <div className="stat-value">{drr !== null ? `${drr.toFixed(1)}%` : '—'}</div>
    </div>
  );
}

export default function Marketing({ password }) {
  const [from, setFrom] = useState(() => toISODate(daysAgo(29)));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('30days');
  const [data, setData] = useState({ totalCost: 0, byDay: [], byCampaign: [] });
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [products, setProducts] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null); // { campaign_id, campaign_name }
  const [campaignData, setCampaignData] = useState({ totalCost: 0, byDay: [] });
  const [loading, setLoading] = useState(true);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [error, setError] = useState('');

  // Общая сводка по рекламе + выручка магазина за тот же период (как на Главной) + список
  // товаров с их выручкой (нужен для сопоставления с кампанией при клике на строку).
  useEffect(() => {
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
  }, [password, from, to]);

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
          opacity: loading ? 0.55 : 1,
          transition: 'opacity 0.25s ease',
          pointerEvents: loading ? 'none' : 'auto',
        }}
      >
        <div className="stats-row-3">
          <div className="stat-card">
            <div className="stat-label">Сумма продаж за период</div>
            <div className="stat-value">{formatMoney(totalRevenue)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Расходы на рекламу за период</div>
            <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(data.totalCost)}</div>
          </div>
          <DrrCard cost={data.totalCost} revenue={totalRevenue} />
        </div>

        <div className="section-title">Динамика расходов по дням</div>
        <div className="card">
          <SalesChart data={data.byDay} dataKey="cost" />
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
                <div className="stats-row-3" style={{ marginBottom: 20 }}>
                  <div className="stat-card">
                    <div className="stat-label">Сумма продаж за период</div>
                    <div className="stat-value">{matchedRevenue !== null ? formatMoney(matchedRevenue) : '—'}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Расходы на рекламу за период</div>
                    <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(campaignData.totalCost)}</div>
                  </div>
                  <DrrCard cost={campaignData.totalCost} revenue={matchedRevenue || 0} />
                </div>
                {matchedRevenue === null && (
                  <div style={{ color: '#6b7690', fontSize: 12, marginBottom: 12 }}>
                    Для этой кампании ещё нет привязки к товару — переустановите Tampermonkey-скрипт (обновлённая версия
                    передаёт merchantSku) и заново нажмите «Выгрузить расходы в дашборд».
                  </div>
                )}
                <SalesChart data={campaignData.byDay} dataKey="cost" />
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
                        <th className="num">Доля от общих расходов</th>
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
                          <td className="num">
                            {data.totalCost > 0 ? formatNumber(((c.cost / data.totalCost) * 100).toFixed(1)) : '0'}%
                          </td>
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
        Нажмите на строку кампании, чтобы увидеть график расходов именно по этому товару.
      </div>
    </div>
  );
}
