import React, { useEffect, useState } from 'react';
import { fetchBonusExpenses } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo, startOfMonth } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';
import BonusChart from './BonusChart.jsx';

// Сводка по акциям. Кроме расхода Kaspi отдаёт по тем же акциям продажи и всю воронку —
// показываем их, только если они реально есть: на "Бонусах за отзыв" (та же страница, другой
// источник данных) этих метрик нет вовсе, и лишние карточки с нулями там были бы враньём.
function BonusStats({ data }) {
  const totals = data.totals || {};
  const cost = data.totalCost || 0;
  const gmv = totals.gmv || 0;
  const orders = totals.transactions || 0;

  return (
    <div className="stats-row-auto">
      <div className="stat-card">
        <div className="stat-label">Расходы на бонусы за период</div>
        <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(cost)}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Продажи по акциям</div>
        <div className="stat-value" style={{ color: '#3ddc97' }}>{formatMoney(gmv)}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Заказы</div>
        <div className="stat-value">{formatNumber(orders)}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Отдача с 1 ₸ бонусов</div>
        <div className="stat-value">{cost > 0 ? `${(gmv / cost).toFixed(1)} ₸` : '—'}</div>
        <div className="stat-card-hint">сколько тенге продаж принесла каждая тенге бонусов</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Бонусов на один заказ</div>
        <div className="stat-value">{orders > 0 ? formatMoney(cost / orders) : '—'}</div>
      </div>
    </div>
  );
}

// Воронка акции: показы → клики → корзина → заказы. Проценты считаются от предыдущего шага,
// избранное стоит в стороне — это не ступень воронки, а отдельное действие покупателя.
function BonusFunnel({ totals }) {
  const step = (value, label, prev) => ({
    value,
    label,
    pct: prev > 0 ? `${((value / prev) * 100).toFixed(1)}%` : null,
  });
  const steps = [
    step(totals.views, 'просмотры', 0),
    step(totals.clicks, 'клики', totals.views),
    step(totals.carts, 'в корзину', totals.clicks),
    step(totals.transactions, 'заказы', totals.carts),
  ];

  return (
    <div className="card bonus-funnel">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          {i > 0 && <div className="bonus-funnel-arrow">→</div>}
          <div className="bonus-funnel-step">
            <div className="bonus-funnel-value">{formatNumber(s.value || 0)}</div>
            <div className="bonus-funnel-label">{s.label}</div>
            {s.pct && <div className="bonus-funnel-pct">{s.pct} от предыдущего</div>}
          </div>
        </React.Fragment>
      ))}
      <div className="bonus-funnel-step bonus-funnel-aside">
        <div className="bonus-funnel-value">{formatNumber(totals.favorites || 0)}</div>
        <div className="bonus-funnel-label">в избранное</div>
      </div>
    </div>
  );
}

// Одинаковая страница используется для двух разных программ бонусов Kaspi (от продавца и за
// отзыв): структура данных у них общая, разные только источник (fetchExpenses) и подписи.
// По умолчанию — "Бонусы от продавца"; для "Бонусы за отзыв" снаружи передаётся другая функция
// и подписи (см. Dashboard.jsx). Расширенные метрики (продажи, заказы, воронка) есть только у
// бонусов от продавца — блоки с ними показываются по факту наличия данных, а не по названию.
export default function Bonuses({
  password,
  fetchExpenses = fetchBonusExpenses,
  subtitle = 'от продавца',
  pageLabel = '«Бонусы от продавца»',
  active = true,
  isOnline = true,
}) {
  const [from, setFrom] = useState(() => toISODate(startOfMonth()));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('month');
  const [data, setData] = useState({ totalCost: 0, totals: {}, byDay: [], byCampaign: [] });
  const [selectedCampaign, setSelectedCampaign] = useState(null); // { campaign_id, campaign_name }
  const [campaignData, setCampaignData] = useState({ totalCost: 0, totals: {}, byDay: [], byCampaign: [] });
  const [loading, setLoading] = useState(true);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [error, setError] = useState('');

  function loadData() {
    setLoading(true);
    setError('');
    fetchExpenses(password, from, to)
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (active) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, password, from, to, fetchExpenses]);

  // Данные конкретной кампании — грузятся отдельно, только когда выбрана строка в таблице
  useEffect(() => {
    if (!selectedCampaign) return;
    setCampaignLoading(true);
    fetchExpenses(password, from, to, selectedCampaign.campaign_id)
      .then((res) => setCampaignData(res))
      .catch((err) => setError(err.message))
      .finally(() => setCampaignLoading(false));
  }, [password, from, to, selectedCampaign, fetchExpenses]);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  const hasData = data.byCampaign.length > 0;
  // Есть ли вообще расширенные метрики: у "Бонусов за отзыв" их нет, и там страница должна
  // остаться ровно такой, какой была.
  const t = data.totals || {};
  const hasFunnel = (t.views || 0) + (t.clicks || 0) + (t.carts || 0) + (t.transactions || 0) + (t.gmv || 0) > 0;

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Бонусы <span>{subtitle}</span></h1>
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
        {hasFunnel ? (
          <>
            <BonusStats data={data} />
            <BonusFunnel totals={t} />
          </>
        ) : (
          <div className="stat-card" style={{ marginBottom: 20 }}>
            <div className="stat-label">Расходы на бонусы за период</div>
            <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(data.totalCost)}</div>
          </div>
        )}

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
                {hasFunnel ? (
                  <>
                    <BonusStats data={campaignData} />
                    <BonusFunnel totals={campaignData.totals || {}} />
                  </>
                ) : (
                  <div className="stat-card" style={{ marginBottom: 20 }}>
                    <div className="stat-label">Расходы на бонусы за период</div>
                    <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(campaignData.totalCost)}</div>
                  </div>
                )}
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
                  Данных нет — загрузите расходы через Tampermonkey-скрипт на странице {pageLabel} Kaspi Pay
                </div>
              ) : (
                <div className="table-scroll">
                  <table className="product-table">
                    <thead>
                      <tr>
                        <th>Акция</th>
                        <th className="num">Расход за период</th>
                        <th className="num">Доля от общих расходов</th>
                        {hasFunnel && <th className="num">Продажи</th>}
                        {hasFunnel && <th className="num">Заказы</th>}
                        {hasFunnel && <th className="num">Отдача</th>}
                        {hasFunnel && <th className="num">Просмотры</th>}
                        {hasFunnel && <th className="num">Клики</th>}
                        {hasFunnel && <th className="num">В корзину</th>}
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
                          {hasFunnel && <td className="num">{formatMoney(c.gmv || 0)}</td>}
                          {hasFunnel && <td className="num">{formatNumber(c.transactions || 0)}</td>}
                          {hasFunnel && <td className="num">{c.cost > 0 ? `${((c.gmv || 0) / c.cost).toFixed(1)} ₸` : '—'}</td>}
                          {hasFunnel && <td className="num">{formatNumber(c.views || 0)}</td>}
                          {hasFunnel && <td className="num">{formatNumber(c.clicks || 0)}</td>}
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
        Данные заливаются вручную через Tampermonkey-скрипт со страницы {pageLabel} (marketing.kaspi.kz) —
        официального API для этого у Kaspi нет. Нажмите на строку акции, чтобы увидеть динамику по дням именно по ней.
        {hasFunnel && (
          <>
            {' '}«Продажи» и «Заказы» — это то, что Kaspi засчитал акции: заказы на товары акции за те же дни.
            Расход бонусов при этом уже вычтен из прибыли в «Отчёте» (колонка «Маркетинг»), а вот продажи по акции
            там отдельно не выделяются — это справочная цифра, чтобы видеть отдачу. «Отдача» — сколько тенге продаж
            пришлось на каждую тенге выплаченных бонусов; ниже 1 ₸ акция не окупает даже сами бонусы, не говоря
            о себестоимости товара.
          </>
        )}
      </div>
    </div>
  );
}
