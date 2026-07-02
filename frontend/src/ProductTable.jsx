import React from 'react';
import { formatMoney, formatNumber } from './dateUtils.js';

export default function ProductTable({ products, onSelectProduct }) {
  if (!products || products.length === 0) {
    return <div className="empty-state">За выбранный период продаж по товарам не было</div>;
  }

  return (
    <div className="table-scroll">
      <table className="product-table">
        <thead>
          <tr>
            <th>Товар</th>
            <th className="num">Продано, шт</th>
            <th className="num">Сумма</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.product_id || p.product_name} onClick={() => onSelectProduct(p)}>
              <td>{p.product_name}</td>
              <td className="num">{formatNumber(p.total_quantity)}</td>
              <td className="num">{formatMoney(p.total_revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
