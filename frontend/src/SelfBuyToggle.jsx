import React from 'react';

// Кнопка "отметить заказ самовыкупом" в строке заказа. Span, а не button: на телефоне она лежит
// внутри карточки-кнопки, а вложенная кнопка в HTML недопустима. По этой же причине останавливаем
// всплытие: нажатие не должно сворачивать карточку.
export default function SelfBuyToggle({ order, busy, onToggle }) {
  const marked = order.self_buy_marked;

  function activate(e) {
    e.stopPropagation();
    if (!busy) onToggle(order);
  }

  return (
    <span
      className={`orders-selfbuy-btn${marked ? ' is-marked' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={marked}
      aria-disabled={busy}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(e);
        }
      }}
    >
      {marked ? 'Самовыкуп ✓' : 'В самовыкуп'}
    </span>
  );
}
