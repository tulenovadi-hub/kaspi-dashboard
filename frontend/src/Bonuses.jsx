import React, { useEffect, useState } from 'react';
import { fetchBonusExpenses } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo, startOfMonth } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';
import BonusChart from './BonusChart.jsx';

export default function Bonuses({ password }) {
  const [from, setFrom] = useState(() => toISODate(startOfMonth()));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('month');
  const [data, setData] = useState({ totalCost: 0, byDay: [], byCampaign: [] });
  const [selectedCampaign, setSelectedCampaign] = useState(null); // { campaign_id, campaign_name }
  const [campaignData, setCampaignData] = useState({ totalCost: 0, byDay: [], byCampaign: [] });
  const [loading, setLoading] = useState(true);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchBonusExpenses(password, from, to)
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password, from, to]);

  // Данные конкретной кампании — грузятся отдельно, только когда выбрана строка в таблице
  useEffect(() => {
    if (!selectedCampaign) return;
    setCampaignLoading(true);
    fetchBonusExpenses(password, from, to, selectedCampaign.campaign_id)
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

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Бонусы <span>от продавца</span></h1>
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
        <div className="stat-card" style={{ marginBottom: 20 }}>
          <div className="stat-label">Расходы на бонусы за период</div>
          <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(data.totalCost)}</div>
        </div>

        <div className="section-title">Динамика по дням</div>
        <div className="card">
          <BonusChart data={data.byDay} />
        </div>

        {selectedCampaign ? (
          <>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{selectedCampaign.campaign_name || selectedCampaign.campaign_id}</span>
              <button className="sync-button" onClick={() => setSelectedCampaign(null)}>Назад к списку</button>
            </div>
            <div className="card">
              <div style={{ opacity: campaignLoading ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
                <div className="stat-card" style={{ marginBottom: 20 }}>
                  <div className="stat-label">Расходы на бонусы за период</div>
                  <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(campaignData.totalCost)}</div>
                </div>
                <BonusChart data={campaignData.byDay} />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="section-title">По акциям</div>
            <div className="card">
              {!hasData && !loading ? (
                <div className="empty-state">
                  Данных нет — загрузите расходы через Tampermonkey-скрипт на странице «Бонусы от продавца» Kaspi Pay
                </div>
              ) : (
                <div className="table-scroll">
                  <table className="product-table">
                    <thead>
                      <tr>
                        <th>Акция</th>
                        <th className="num">Расход за период</th>
                        <th className="num">Доля от общих расходов</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byCampaign.map((c) => (
                        <tr
                          key={c.campaign_id}
                          className="batch-row"
                          onClick={() => setSelectedCampaign({ campaign_id: c.campaign_id, campaign_name: c.campaign_name })}
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
        Данные заливаются вручную через Tampermonkey-скрипт со страницы «Бонусы от продавца» (marketing.kaspi.kz) —
        официального API для этого у Kaspi нет. Здесь показывается только расход (сумма бонусов, выплаченных
        покупателям) — выручку по этим акциям сознательно не считаем. Эти цифры пока нигде больше на сайте не
        используются (не влияют на «Прочие расходы»/«Упаковка» в Отчёте и на «Чистую прибыль») — отдельная
        самостоятельная сводка. Нажмите на строку акции, чтобы увидеть динамику по дням именно по ней.
      </div>
    </div>
  );
}
