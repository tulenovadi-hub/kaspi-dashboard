import React, { useEffect, useState } from 'react';
import { fetchAdExpenses } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';
import SalesChart from './SalesChart.jsx';

export default function Marketing({ password }) {
  const [from, setFrom] = useState(() => toISODate(daysAgo(29)));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('30days');
  const [data, setData] = useState({ totalCost: 0, byDay: [], byCampaign: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchAdExpenses(password, from, to)
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password, from, to]);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  const hasData = data.byCampaign.length > 0;

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
        <div className="stats-row" style={{ gridTemplateColumns: '1fr' }}>
          <div className="stat-card">
            <div className="stat-label">Расходы на рекламу за период</div>
            <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(data.totalCost)}</div>
          </div>
        </div>

        <div className="section-title">Динамика расходов по дням</div>
        <div className="card">
          <SalesChart data={data.byDay} dataKey="cost" />
        </div>

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
                    <tr key={c.campaign_id}>
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
      </div>

      <div className="report-note">
        Данные заливаются вручную через Tampermonkey-скрипт со страницы кампаний Kaspi Pay (marketing.kaspi.kz) —
        официального API для расходов на рекламу у Kaspi нет. Эти цифры пока нигде больше на сайте не используются
        (не влияют на «Прочие расходы» в Отчёте и на «Чистую прибыль») — это отдельная, самостоятельная сводка.
      </div>
    </div>
  );
}
