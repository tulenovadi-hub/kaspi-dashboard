import React, { useEffect, useState } from 'react';
import SalesChart from './SalesChart.jsx';
import { fetchProductStats } from './api.js';
import { formatMoney, formatNumber, percentChange } from './dateUtils.js';

export default function ProductDetail({ password, product, from, to, mode = 'main', onClose }) {
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [metric, setMetric] = useState('total_revenue');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    fetchProductStats(password, product.product_id, from, to, mode)
      .then((data) => { if (!cancelled) setDays(data.days); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [password, product.product_id, from, to, mode]);

  const half = Math.floor(days.length / 2);
  const key = metric;
  const firstHalf = days.slice(0, half).reduce((sum, d) => sum + Number(d[key]), 0);
  const secondHalf = days.slice(half).reduce((sum, d) => sum + Number(d[key]), 0);
  const trend = percentChange(secondHalf, firstHalf);

  // Среднее количество заказов в день по этому товару
  const totalQty = days.reduce((sum, d) => sum + Number(d.total_quantity || 0), 0);
  const daysCount = days.length || 1;
  const avgQtyPerDay = (totalQty / daysCount).toFixed(1);

  // Сумма чистой прибыли за весь период — только по дням, где она вообще посчитана
  // (для дней без данных из Excel-отчёта net_profit = null, их просто пропускаем при суммировании).
  const knownProfitDays = days.filter((d) => d.net_profit !== null && d.net_profit !== undefined);
  const totalNetProfit = knownProfitDays.reduce((sum, d) => sum + Number(d.net_profit), 0);
  const hasMissingProfitDays = days.length > 0 && knownProfitDays.length < days.length;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>{product.product_name}</div>
          <div style={{ color: '#6b7690', fontSize: 13, marginTop: 4 }}>
            Продано за период: {formatNumber(product.total_quantity)} шт на {formatMoney(product.total_revenue)}
            {' '}
            (Чистая прибыль:{' '}
            <span style={{ color: totalNetProfit < 0 ? '#ff6b6b' : '#3ddc97', fontWeight: 600 }}>
              {formatMoney(totalNetProfit)}
            </span>
            {hasMissingProfitDays && (
              <span title="Не по всем дням периода есть данные из Excel-отчёта Kaspi Pay — сумма посчитана только по дням, где они загружены"> *</span>
            )}
            )
          </div>
        </div>
        <button className="sync-button" onClick={onClose}>Назад к списку</button>
      </div>

      {/* Переключатель метрики */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`period-chip ${metric === 'total_revenue' ? 'active' : ''}`}
          onClick={() => setMetric('total_revenue')}
        >
          Выручка
        </button>
        <button
          className={`period-chip ${metric === 'total_quantity' ? 'active' : ''}`}
          onClick={() => setMetric('total_quantity')}
        >
          Количество продаж
        </button>
        <button
          className={`period-chip ${metric === 'net_profit' ? 'active' : ''}`}
          onClick={() => setMetric('net_profit')}
        >
          Чистая прибыль
        </button>
      </div>

      <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
        {trend !== null && days.length > 1 && (
          <div style={{ fontSize: 13, color: trend >= 0 ? '#3ddc97' : '#ff6b6b' }}>
            {trend >= 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}% — вторая половина периода против первой
          </div>
        )}
        <div style={{
          fontSize: 13,
          background: 'rgba(110, 139, 255, 0.15)',
          color: '#6e8bff',
          borderRadius: 8,
          padding: '2px 10px',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          ⌀ {avgQtyPerDay} шт/день
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!error && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
          {days.length === 0 && loading ? (
            <div className="empty-state">Загрузка...</div>
          ) : (
            <SalesChart data={days} dataKey={metric} />
          )}
        </div>
      )}
    </div>
  );
}
