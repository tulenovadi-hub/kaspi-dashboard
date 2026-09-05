import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatDayLabel, formatMoney, formatNumber } from './dateUtils.js';

// Показатель выбирается на самой странице (как у Kaspi: нажал на цифру — график перестроился),
// поэтому и ключ, и цвет, и способ форматирования приходят пропсами. money=false — это штуки
// (просмотры, клики, заказы), их нельзя показывать со знаком ₸.
function makeTooltip(color, money) {
  return function CustomTooltip({ active, payload, label }) {
    if (!active || !payload || !payload.length) return null;
    return (
      <div style={{ background: '#1c2436', border: '1px solid #262f45', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
        <div style={{ color: '#6b7690', marginBottom: 6 }}>{formatDayLabel(label)}</div>
        <div style={{ color, fontFamily: 'JetBrains Mono, monospace' }}>
          {money ? formatMoney(payload[0].value) : formatNumber(payload[0].value)}
        </div>
      </div>
    );
  };
}

export default function BonusChart({ data, dataKey = 'cost', color = '#ff6b6b', money = true }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">За выбранный период данных нет</div>;
  }

  const Tip = makeTooltip(color, money);

  return (
    <ResponsiveContainer width="100%" height={320}>
      {/* key по показателю — чтобы при переключении линия перерисовывалась с новой анимацией,
          а не перетекала из предыдущего ряда (у штук и тенге разные порядки величин). */}
      <LineChart key={dataKey} data={data} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#262f45" vertical={false} />
        <XAxis dataKey="day" tickFormatter={formatDayLabel} stroke="#6b7690" fontSize={12} tickLine={false} axisLine={{ stroke: '#262f45' }} />
        <YAxis
          stroke={color}
          fontSize={12}
          tickLine={false}
          axisLine={false}
          width={money ? 80 : 50}
          tickFormatter={(v) => (money ? v : formatNumber(v))}
        />
        <Tooltip content={<Tip />} />
        <Line type="monotone" dataKey={dataKey} name={dataKey} stroke={color} strokeWidth={2} dot={false} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
