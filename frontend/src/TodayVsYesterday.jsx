import React from 'react';
import { formatMoney, percentChange } from './dateUtils.js';

export default function TodayVsYesterday({ todayRevenue, yesterdayRevenue }) {
  const delta = percentChange(todayRevenue, yesterdayRevenue);
  const isUp = delta !== null && delta > 0;
  const isDown = delta !== null && delta < 0;

  let badgeClass = 'flat';
  let badgeText = '0%';
  if (delta === null) {
    badgeClass = 'flat';
    badgeText = '—';
  } else if (isUp) {
    badgeClass = 'up';
    badgeText = `+${delta.toFixed(1)}%`;
  } else if (isDown) {
    badgeClass = 'down';
    badgeText = `${delta.toFixed(1)}%`;
  }

  return (
    <div className="hero">
      <div className="hero-block">
        <span className="hero-label">Вчера</span>
        <span className="hero-value">{formatMoney(yesterdayRevenue)}</span>
        <span className="hero-sub">сумма продаж</span>
      </div>

      <div className="hero-divider">
        <span className={`delta-badge ${badgeClass}`}>{badgeText}</span>
        <span className="delta-arrow">по сравнению со вчера</span>
      </div>

      <div className="hero-block" style={{ textAlign: 'right' }}>
        <span className="hero-label">Сегодня</span>
        <span className="hero-value">{formatMoney(todayRevenue)}</span>
        <span className="hero-sub">сумма продаж</span>
      </div>
    </div>
  );
}
