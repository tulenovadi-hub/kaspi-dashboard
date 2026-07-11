import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatDayLabel, formatMoney } from './dateUtils.js';

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: '#1c2436', border: '1px solid #262f45', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
      <div style={{ color: '#6b7690', marginBottom: 6 }}>{formatDayLabel(label)}</div>
      <div style={{ color: '#ff6b6b', fontFamily: 'JetBrains Mono, monospace' }}>{formatMoney(payload[0].value)}</div>
    </div>
  );
}

// В отличие от MarketingChart (реклама), здесь только расход — "Бонусы от продавца" не даёт
// выручку по дням, только сумму выплаченных клиентам бонусов, поэтому одна линия и одна ось Y.
export default function BonusChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">За выбранный период данных нет</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#262f45" vertical={false} />
        <XAxis dataKey="day" tickFormatter={formatDayLabel} stroke="#6b7690" fontSize={12} tickLine={false} axisLine={{ stroke: '#262f45' }} />
        <YAxis stroke="#ff6b6b" fontSize={12} tickLine={false} axisLine={false} width={80} />
        <Tooltip content={<CustomTooltip />} />
        <Line type="monotone" dataKey="cost" name="cost" stroke="#ff6b6b" strokeWidth={2} dot={false} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
