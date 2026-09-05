import React, { useEffect, useState } from 'react';
import { fetchBonusExpenses } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo, startOfMonth } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';
import BonusChart from './BonusChart.jsx';

// Показатели, между которыми переключается график по дням — как на странице акции у Kaspi:
// нажал на цифру, график перестроился, нажатая цифра подсвечена. Ключ совпадает с полем,
// которое отдаёт бэкенд и в byDay, и в byCampaign. money — печатать со знаком ₸ или как штуки.
const METRICS = {
  cost: { label: 'Расходы на бонусы', color: '#ff6b6b', money: true },
  gmv: { label: 'Продажи по акциям', color: '#3ddc97', money: true },
  transactions: { label: 'Заказы', color: '#6e8bff', money: false },
  views: { label: 'Просмотры', color: '#4ec9f5', money: false },
  clicks: { label: 'Клики', color: '#b38bff', money: false },
  carts: { label: 'В корзину', color: '#ffb347', money: false },
  favorites: { label: 'В избранное', color: '#ffd166', money: false },
};

// Строка показателей акции: воронка просмотры → клики → корзина → заказы, а справа, в стороне
// от воронки, — избранное и расход на бонусы. Порядок и состав повторяют строку на странице
// акции у Kaspi, чтобы цифры можно было сверять глазами один в один.
//
// Каждый показатель — кнопка, переключающая график. У заказов кнопка двойная: первый клик
// показывает количество заказов, повторный — сумму этих заказов (она же в скобках). Так сумма
// продаж не занимает отдельную кнопку, но остаётся доступной.
function BonusFunnel({ totals, cost, metric, onSelect }) {
  const value = (key) => totals[key] || 0;
  const pct = (key, prev) => (prev > 0 ? `${((value(key) / prev) * 100).toFixed(1)}%` : null);

  const steps = [
    { key: 'views', label: 'просмотры', pct: null },
    { key: 'clicks', label: 'клики', pct: pct('clicks', value('views')) },
    { key: 'carts', label: 'в корзину', pct: pct('carts', value('clicks')) },
    { key: 'transactions', label: 'заказы', pct: pct('transactions', value('carts')) },
  ];

  const ordersSelected = metric === 'transactions' || metric === 'gmv';

  function renderStep(step, extraClass) {
    const isOrders = step.key === 'transactions';
    const selected = isOrders ? ordersSelected : metric === step.key;
    return (
      <button
        type="button"
        className={`bonus-funnel-step${extraClass ? ' ' + extraClass : ''}${selected ? ' selected' : ''}`}
        // Повторный клик по заказам переключает на сумму и обратно — отсюда тройное условие.
        onClick={() => onSelect(isOrders && metric === 'transactions' ? 'gmv' : step.key)}
        title={isOrders
          ? (metric === 'transactions' ? 'Нажмите ещё раз: сумма заказов на графике' : 'Показать на графике: количество заказов')
          : `Показать на графике: ${step.label}`}
      >
        <div className="bonus-funnel-value">
          <span className={isOrders && metric === 'gmv' ? 'bonus-funnel-dimmed' : undefined}>
            {formatNumber(value(step.key))}
          </span>
          {isOrders && (
            <span className={`bonus-funnel-sum${metric === 'gmv' ? ' selected' : ''}`}>
              {' '}({formatMoney(value('gmv'))})
            </span>
          )}
        </div>
        <div className="bonus-funnel-label">{step.label}</div>
        {step.pct && <div className="bonus-funnel-pct">{step.pct} от предыдущего</div>}
      </button>
    );
  }

  return (
    <div className="card bonus-funnel">
      {steps.map((step, i) => (
        <React.Fragment key={step.key}>
          {i > 0 && <div className="bonus-funnel-arrow">→</div>}
          {renderStep(step)}
        </React.Fragment>
      ))}
      <div className="bonus-funnel-tail">
        {renderStep({ key: 'favorites', label: 'в избранное', pct: null }, 'bonus-funnel-aside')}
        <button
          type="button"
          className={`bonus-funnel-step bonus-funnel-cost${metric === 'cost' ? ' selected' : ''}`}
          onClick={() => onSelect('cost')}
          title="Показать на графике: расходы на бонусы"
        >
          <div className="bonus-funnel-value">{formatMoney(cost || 0)}</div>
          <div className="bonus-funnel-label">выплачено бонусов</div>
        </button>
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
  // Какой показатель сейчас на графике. По умолчанию расход — то, ради чего страница и делалась.
  const [metric, setMetric] = useState('cost');

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
          <BonusFunnel totals={t} cost={data.totalCost} metric={metric} onSelect={setMetric} />
        ) : (
          <div className="stat-card" style={{ marginBottom: 20 }}>
            <div className="stat-label">Расходы на бонусы за период</div>
            <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(data.totalCost)}</div>
          </div>
        )}

        <div className="section-title">
          Динамика по дням{hasFunnel ? ` — ${METRICS[metric].label.toLowerCase()}` : ''}
        </div>
        <div className="card">
          <BonusChart
            data={data.byDay}
            dataKey={hasFunnel ? metric : 'cost'}
            color={METRICS[hasFunnel ? metric : 'cost'].color}
            money={METRICS[hasFunnel ? metric : 'cost'].money}
          />
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
                  <BonusFunnel
                    totals={campaignData.totals || {}}
                    cost={campaignData.totalCost}
                    metric={metric}
                    onSelect={setMetric}
                  />
                ) : (
                  <div className="stat-card" style={{ marginBottom: 20 }}>
                    <div className="stat-label">Расходы на бонусы за период</div>
                    <div className="stat-value" style={{ color: '#ff6b6b' }}>{formatMoney(campaignData.totalCost)}</div>
                  </div>
                )}
                <BonusChart
                  data={campaignData.byDay}
                  dataKey={hasFunnel ? metric : 'cost'}
                  color={METRICS[hasFunnel ? metric : 'cost'].color}
                  money={METRICS[hasFunnel ? metric : 'cost'].money}
                />
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
