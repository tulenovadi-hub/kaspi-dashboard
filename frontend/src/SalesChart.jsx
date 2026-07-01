import React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatDayLabel, formatMoney } from './dateUtils.js';

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: '#1c2436', border: '1px solid #262f45', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
      <div style={{ color: '#6b7690', marginBottom: 4 }}>{formatDayLabel(label)}</div>
      <div style={{ color: '#e8ecf4', fontFamily: 'JetBrains Mono, monospace' }}>{formatMoney(payload[0].value)}</div>
    </div>
  );
}

export default function SalesChart({ data, dataKey = 'total_revenue' }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">За выбранный период данных нет</div>;
  }

  const maxVal = Math.max(...data.map(d => Number(d[dataKey] || 0)));

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
        <YAxis stroke="#6b7690" fontSize={12} tickLine={false} axisLine={false} width={80} domain={[0, Math.ceil(maxVal * 1.2)]} />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey={dataKey} stroke="#6e8bff" strokeWidth={2} fill="url(#revenueFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
