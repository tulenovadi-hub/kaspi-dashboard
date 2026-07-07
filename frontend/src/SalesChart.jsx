import React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { formatDayLabel, formatMoney, formatNumber } from './dateUtils.js';

function CustomTooltip({ active, payload, label, isQuantity }) {
  if (!active || !payload || !payload.length) return null;
  const value = payload[0].value;
  const isMissing = value === null || value === undefined;
  return (
    <div style={{ background: '#1c2436', border: '1px solid #262f45', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
      <div style={{ color: '#6b7690', marginBottom: 4 }}>{formatDayLabel(label)}</div>
      {isMissing ? (
        <div style={{ color: '#6b7690' }}>нет данных за этот день</div>
      ) : (
        <div style={{ color: value < 0 ? '#ff6b6b' : '#e8ecf4', fontFamily: 'JetBrains Mono, monospace' }}>
          {isQuantity ? `${formatNumber(value)} шт` : formatMoney(value)}
        </div>
      )}
    </div>
  );
}

export default function SalesChart({ data, dataKey = 'total_revenue' }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">За выбранный период данных нет</div>;
  }

  const isQuantity = dataKey === 'total_quantity';
  const values = data
    .map((d) => d[dataKey])
    .filter((v) => v !== null && v !== undefined)
    .map(Number);
  const maxVal = Math.max(...values, 0);
  const minVal = Math.min(...values, 0);
  // Выручка и количество продаж не бывают отрицательными — им ось всегда от 0. А вот чистая
  // прибыль в отдельные дни может уйти в минус (возвраты, дни без продаж при расходах) — тогда
  // ось должна опускаться ниже нуля, иначе просадки будет не видно.
  const yDomain = minVal < 0 ? [Math.floor(minVal * 1.2), Math.ceil(maxVal * 1.2)] : [0, Math.ceil(maxVal * 1.2)];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6e8bff" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#6e8bff" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#262f45" vertical={false} />
        <XAxis dataKey="day" tickFormatter={formatDayLabel} stroke="#6b7690" fontSize={12} tickLine={false} axisLine={{ stroke: '#262f45' }} />
        <YAxis stroke="#6b7690" fontSize={12} tickLine={false} axisLine={false} width={80} domain={yDomain} />
        {minVal < 0 && <ReferenceLine y={0} stroke="#6b7690" strokeDasharray="3 3" />}
        <Tooltip content={<CustomTooltip isQuantity={isQuantity} />} />
        <Area type="monotone" dataKey={dataKey} stroke="#6e8bff" strokeWidth={2} fill="url(#revenueFill)" connectNulls={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
