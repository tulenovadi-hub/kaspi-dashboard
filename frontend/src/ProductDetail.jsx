import React, { useEffect, useState } from 'react';
import SalesChart from './SalesChart.jsx';
import { fetchProductStats } from './api.js';
import { formatMoney, formatNumber, percentChange } from './dateUtils.js';

export default function ProductDetail({ password, product, from, to, onClose }) {
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    fetchProductStats(password, product.product_id, from, to)
      .then((data) => {
        if (!cancelled) setDays(data.days);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [password, product.product_id, from, to]);

  const half = Math.floor(days.length / 2);
  const firstHalfRevenue = days.slice(0, half).reduce((sum, d) => sum + Number(d.total_revenue), 0);
  const secondHalfRevenue = days.slice(half).reduce((sum, d) => sum + Number(d.total_revenue), 0);
  const trend = percentChange(secondHalfRevenue, firstHalfRevenue);

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>{product.product_name}</div>
          <div style={{ color: '#6b7690', fontSize: 13, marginTop: 4 }}>
            Продано за период: {formatNumber(product.total_quantity)} шт на {formatMoney(product.total_revenue)}
          </div>
        </div>
        <button className="sync-button" onClick={onClose}>Назад к списку</button>
      </div>

      {trend !== null && days.length > 1 && (
        <div style={{ marginBottom: 16, fontSize: 13, color: trend >= 0 ? '#3ddc97' : '#ff6b6b' }}>
          {trend >= 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}% — вторая половина периода против первой
        </div>
      )}

      {loading && <div className="empty-state">Загрузка...</div>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && <SalesChart data={days} dataKey="total_revenue" />}
    </div>
  );
}
