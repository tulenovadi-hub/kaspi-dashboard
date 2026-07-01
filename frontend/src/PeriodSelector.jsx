import React from 'react';
import { toISODate, daysAgo } from './dateUtils.js';

const PRESETS = [
  { key: 'today', label: 'Сегодня', from: () => daysAgo(0), to: () => daysAgo(0) },
  { key: 'yesterday', label: 'Вчера', from: () => daysAgo(1), to: () => daysAgo(1) },
  { key: '7days', label: '7 дней', from: () => daysAgo(6), to: () => daysAgo(0) },
  { key: '30days', label: '30 дней', from: () => daysAgo(29), to: () => daysAgo(0) },
];

export default function PeriodSelector({ from, to, activePreset, onChange }) {
  function applyPreset(preset) {
    onChange({
      from: toISODate(preset.from()),
      to: toISODate(preset.to()),
      presetKey: preset.key,
    });
  }

  return (
    <div className="period-bar">
      {PRESETS.map((preset) => (
        <button
          key={preset.key}
          className={`period-chip ${activePreset === preset.key ? 'active' : ''}`}
          onClick={() => applyPreset(preset)}
        >
          {preset.label}
        </button>
      ))}
      <div className="date-inputs">
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => onChange({ from: e.target.value, to, presetKey: 'custom' })}
        />
        <span>—</span>
        <input
          type="date"
          value={to}
          min={from}
          max={toISODate(new Date())}
          onChange={(e) => onChange({ from, to: e.target.value, presetKey: 'custom' })}
        />
      </div>
    </div>
  );
}
