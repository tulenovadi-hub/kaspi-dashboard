import React from 'react';
import { formatMoney, formatNumber, formatPercent } from './dateUtils.js';

export default function ProductTable({ products, profitProducts, onSelectProduct }) {
  if (!products || products.length === 0) {
    return <div className="empty-state">За выбранный период продаж по товарам не было</div>;
  }

  const profitById = new Map((profitProducts || []).map((p) => [p.product_id, p]));
  const totals = products.reduce((sum, product) => {
    const profit = Number(profitById.get(product.product_id)?.net_profit) || 0;
    sum.quantity += Number(product.total_quantity) || 0;
    sum.revenue += Number(product.total_revenue) || 0;
    sum.profit += profit;
    return sum;
  }, { quantity: 0, revenue: 0, profit: 0 });

  return (
    <div className="table-scroll">
      <table className="product-table product-profit-table">
        <thead>
          <tr>
            <th>Товар</th>
            <th className="num">Продано, шт</th>
            <th className="num">Сумма</th>
            <th className="num">Чистая прибыль</th>
            <th className="num">Маржа</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => {
            const profit = Number(profitById.get(p.product_id)?.net_profit) || 0;
            const revenue = Number(p.total_revenue) || 0;
            const margin = revenue > 0 ? (profit / revenue) * 100 : null;
            return (
              <tr key={p.product_id || p.product_name} onClick={() => onSelectProduct(p)}>
                <td>{p.product_name}</td>
                <td className="num">{formatNumber(p.total_quantity)}</td>
                <td className="num">{formatMoney(revenue)}</td>
                <td className={`num ${profit < 0 ? 'profit-negative' : 'profit-positive'}`}>{formatMoney(profit)}</td>
                <td className={`num ${margin !== null && margin < 0 ? 'profit-negative' : 'profit-positive'}`}>{formatPercent(margin)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Итого</td>
            <td className="num">{formatNumber(totals.quantity)}</td>
            <td className="num">{formatMoney(totals.revenue)}</td>
            <td className={`num ${totals.profit < 0 ? 'profit-negative' : 'profit-positive'}`}>{formatMoney(totals.profit)}</td>
            <td className={`num ${totals.profit < 0 ? 'profit-negative' : 'profit-positive'}`}>
              {formatPercent(totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : null)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
