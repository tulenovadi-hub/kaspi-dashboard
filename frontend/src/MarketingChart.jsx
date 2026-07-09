import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatDayLabel, formatMoney } from './dateUtils.js';

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: '#1c2436', border: '1px solid #262f45', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
      <div style={{ color: '#6b7690', marginBottom: 6 }}>{formatDayLabel(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color, fontFamily: 'JetBrains Mono, monospace' }}>
          {p.name}: {formatMoney(p.value)}
        </div>
      ))}
    </div>
  );
}

// Две линии на одном графике — расходы на рекламу (cost) и выручка "по рекламе" (gmv).
// У них разный порядок величин (выручка обычно в разы больше расходов), поэтому у каждой
// линии своя ось Y (слева — расходы, справа — выручка), а не общая шкала — иначе расходы
// были бы почти не видны на фоне выручки.
export default function MarketingChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">За выбранный период данных нет</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#262f45" vertical={false} />
        <XAxis dataKey="day" tickFormatter={formatDayLabel} stroke="#6b7690" fontSize={12} tickLine={false} axisLine={{ stroke: '#262f45' }} />
        <YAxis yAxisId="cost" stroke="#ff6b6b" fontSize={12} tickLine={false} axisLine={false} width={80} />
        <YAxis yAxisId="gmv" orientation="right" stroke="#3ddc97" fontSize={12} tickLine={false} axisLine={false} width={80} />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 13 }} formatter={(value) => (value === 'cost' ? 'Расходы на рекламу' : 'Продажи по рекламе')} />
        <Line yAxisId="cost" type="monotone" dataKey="cost" name="cost" stroke="#ff6b6b" strokeWidth={2} dot={false} connectNulls={false} />
        <Line yAxisId="gmv" type="monotone" dataKey="gmv" name="gmv" stroke="#3ddc97" strokeWidth={2} dot={false} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
