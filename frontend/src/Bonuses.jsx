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

// Карточка показателя. Если передан onSelect — становится кнопкой: клик переключает график.
// Без onSelect (страница "Бонусы за отзыв", где дневных метрик нет) остаётся обычной карточкой,
// чтобы не обещать переключение, которого не будет.
function MetricCard({ metricKey, label, value, hint, color, selected, onSelect }) {
  const content = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>{value}</div>
      {hint && <div className="stat-card-hint">{hint}</div>}
    </>
  );
  if (!onSelect) return <div className="stat-card">{content}</div>;
  return (
    <button
      type="button"
      className={`stat-card stat-card-button${selected ? ' selected' : ''}`}
      onClick={() => onSelect(metricKey)}
      title={`Показать на графике: ${label}`}
    >
      {content}
    </button>
  );
}

// Сводка по акциям. Кроме расхода Kaspi отдаёт по тем же акциям продажи и всю воронку —
// показываем их, только если они реально есть: на "Бонусах за отзыв" (та же страница, другой
// источник данных) этих метрик нет вовсе, и лишние карточки с нулями там были бы враньём.
function BonusStats({ data, metric, onSelect }) {
  const totals = data.totals || {};
  const cost = data.totalCost || 0;
  const gmv = totals.gmv || 0;
  const orders = totals.transactions || 0;

  return (
    <div className="stats-row-auto">
      <MetricCard
        metricKey="cost" label="Расходы на бонусы за период" value={formatMoney(cost)}
        color={METRICS.cost.color} selected={metric === 'cost'} onSelect={onSelect}
      />
      <MetricCard
        metricKey="gmv" label="Продажи по акциям" value={formatMoney(gmv)}
        color={METRICS.gmv.color} selected={metric === 'gmv'} onSelect={onSelect}
      />
      <MetricCard
        metricKey="transactions" label="Заказы" value={formatNumber(orders)}
        selected={metric === 'transactions'} onSelect={onSelect}
      />
      {/* Отдача и стоимость заказа — производные величины, по дням их рисовать бессмысленно
          (в день без заказов делить не на что), поэтому они не кнопки. */}
      <MetricCard
        label="Отдача с 1 ₸ бонусов"
        value={cost > 0 ? `${(gmv / cost).toFixed(1)} ₸` : '—'}
        hint="сколько тенге продаж принесла каждая тенге бонусов"
      />
      <MetricCard
        label="Бонусов на один заказ"
        value={orders > 0 ? formatMoney(cost / orders) : '—'}
      />
    </div>
  );
}

// Воронка акции: показы → клики → корзина → заказы. Проценты считаются от предыдущего шага,
// избранное стоит в стороне — это не ступень воронки, а отдельное действие покупателя.
function BonusFunnel({ totals, metric, onSelect }) {
  const step = (key, label, prev) => ({
    key,
    label,
    value: totals[key] || 0,
    pct: prev > 0 ? `${(((totals[key] || 0) / prev) * 100).toFixed(1)}%` : null,
  });
  const steps = [
    step('views', 'просмотры', 0),
    step('clicks', 'клики', totals.views),
    step('carts', 'в корзину', totals.clicks),
    step('transactions', 'заказы', totals.carts),
  ];

  const renderStep = (s, aside) => (
    <button
      type="button"
      className={`bonus-funnel-step${aside ? ' bonus-funnel-aside' : ''}${metric === s.key ? ' selected' : ''}`}
      onClick={() => onSelect(s.key)}
      title={`Показать на графике: ${s.label}`}
    >
      <div className="bonus-funnel-value">{formatNumber(s.value)}</div>
      <div className="bonus-funnel-label">{s.label}</div>
      {s.pct && <div className="bonus-funnel-pct">{s.pct} от предыдущего</div>}
    </button>
  );

  return (
    <div className="card bonus-funnel">
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && <div className="bonus-funnel-arrow">→</div>}
          {renderStep(s, false)}
        </React.Fragment>
      ))}
      {renderStep(step('favorites', 'в избранное', 0), true)}
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
          <>
            <BonusStats data={data} metric={metric} onSelect={setMetric} />
            <BonusFunnel totals={t} metric={metric} onSelect={setMetric} />
          </>
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
                  <>
                    <BonusStats data={campaignData} metric={metric} onSelect={setMetric} />
                    <BonusFunnel totals={campaignData.totals || {}} metric={metric} onSelect={setMetric} />
                  </>
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
