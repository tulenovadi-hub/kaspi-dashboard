import React from 'react';
import { formatMoney, formatNumber } from './dateUtils.js';

// Показатели, между которыми переключается график по дням — общие для "Рекламы товаров" и
// "Бонусов от продавца": у Kaspi обе страницы устроены одинаково, и данные к нам приходят в
// одинаковых полях. Ключ совпадает с полем в ответе бэкенда; money — печатать с ₸ или как штуки.
export const METRICS = {
  cost: { label: 'Расходы', color: '#ff6b6b', money: true },
  gmv: { label: 'Продажи', color: '#3ddc97', money: true },
  transactions: { label: 'Заказы', color: '#6e8bff', money: false },
  views: { label: 'Просмотры', color: '#4ec9f5', money: false },
  clicks: { label: 'Клики', color: '#b38bff', money: false },
  carts: { label: 'В корзину', color: '#ffb347', money: false },
  favorites: { label: 'В избранное', color: '#ffd166', money: false },
};

// Строка показателей кампании: воронка просмотры → клики → корзина → заказы, а справа, в стороне
// от воронки, — избранное, расход и (у рекламы) ДРР. Порядок и состав повторяют строку на
// странице кампании у Kaspi, чтобы цифры можно было сверять глазами один в один.
//
// Каждый показатель — кнопка, переключающая график. У заказов кнопка двойная: первый клик
// показывает количество заказов, повторный — сумму этих заказов (она же в скобках). Так сумма
// продаж не занимает отдельную кнопку, но остаётся доступной.
//
// costLabel — подпись под расходом ("выплачено бонусов" / "расходы на рекламу"), extraStat —
// необязательная цифра в конце строки без кнопки (ДРР: он производный, по дням его не рисуем).
export default function CampaignFunnel({ totals, cost, costLabel, extraStat, metric, onSelect }) {
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
          title={`Показать на графике: ${costLabel}`}
        >
          <div className="bonus-funnel-value">{formatMoney(cost || 0)}</div>
          <div className="bonus-funnel-label">{costLabel}</div>
        </button>
        {extraStat && (
          <div className="bonus-funnel-step bonus-funnel-static">
            <div className="bonus-funnel-value">{extraStat.value}</div>
            <div className="bonus-funnel-label">{extraStat.label}</div>
          </div>
        )}
      </div>
    </div>
  );
}
