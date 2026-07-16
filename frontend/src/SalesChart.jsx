import React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { formatDayLabel, formatMoney, formatNumber } from './dateUtils.js';

function CustomTooltip({ active, payload, label, isQuantity, estimatable }) {
  if (!active || !payload || !payload.length) return null;

  // При estimatable в payload два ряда (точный + прогноз) — берём тот, где реально есть значение.
  const exactEntry = payload.find((p) => p.dataKey === 'value_exact');
  const forecastEntry = payload.find((p) => p.dataKey === 'value_forecast');
  const entry = estimatable
    ? (exactEntry && exactEntry.value !== null && exactEntry.value !== undefined ? exactEntry : forecastEntry)
    : payload[0];
  const value = entry ? entry.value : undefined;
  const isForecast = estimatable && entry === forecastEntry && (!exactEntry || exactEntry.value === null || exactEntry.value === undefined);
  const isMissing = value === null || value === undefined;

  return (
    <div style={{ background: '#1c2436', border: '1px solid #262f45', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
      <div style={{ color: '#6b7690', marginBottom: 4 }}>{formatDayLabel(label)}</div>
      {isMissing ? (
        <div style={{ color: '#6b7690' }}>нет данных за этот день</div>
      ) : (
        <div style={{ color: value < 0 ? '#ff6b6b' : '#e8ecf4', fontFamily: 'JetBrains Mono, monospace' }}>
          {isQuantity ? `${formatNumber(value)} шт` : formatMoney(value)}
          {isForecast && <span style={{ color: '#6b7690', fontFamily: 'inherit', marginLeft: 6 }}>(прогноз)</span>}
        </div>
      )}
    </div>
  );
}

export default function SalesChart({ data, dataKey = 'total_revenue', estimatable = false }) {
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

  // Если часть дней — прогноз (is_estimated), строим два параллельных ряда: "точный" рисуется
  // сплошной линией, "прогноз" — пунктиром. В прогнозный ряд добавляем ещё и последнюю точную
  // точку, чтобы пунктир визуально продолжал сплошную линию без разрыва между ними.
  const hasEstimated = estimatable && data.some((d) => d.is_estimated);
  let chartData = data;
  if (hasEstimated) {
    let lastExactIndex = -1;
    for (let i = data.length - 1; i >= 0; i -= 1) {
      const v = data[i][dataKey];
      if (!data[i].is_estimated && v !== null && v !== undefined) {
        lastExactIndex = i;
        break;
      }
    }
    chartData = data.map((d, i) => ({
      ...d,
      value_exact: d.is_estimated ? null : d[dataKey],
      value_forecast: (d.is_estimated || i === lastExactIndex) ? d[dataKey] : null,
    }));
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={chartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
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
        <Tooltip content={<CustomTooltip isQuantity={isQuantity} estimatable={hasEstimated} />} />
        {hasEstimated ? (
          <>
            <Area type="monotone" dataKey="value_exact" stroke="#6e8bff" strokeWidth={2} fill="url(#revenueFill)" connectNulls={false} />
            <Area type="monotone" dataKey="value_forecast" stroke="#6e8bff" strokeWidth={2} strokeDasharray="6 4" fill="url(#revenueFill)" fillOpacity={0.4} connectNulls={false} />
          </>
        ) : (
          <Area type="monotone" dataKey={dataKey} stroke="#6e8bff" strokeWidth={2} fill="url(#revenueFill)" connectNulls={false} />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}
