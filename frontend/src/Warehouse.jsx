import React, { useEffect, useState } from 'react';
import { fetchWarehouse } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';

export default function Warehouse({ password }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchWarehouse(password)
      .then((res) => setProducts(res.products))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password]);

  function toggleExpand(productId) {
    setExpanded((prev) => (prev === productId ? null : productId));
  }

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Склад <span>остатков</span></h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">Пока нет данных — сначала добавьте партии на странице «Поставки»</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th className="num">Поставлено</th>
                  <th className="num">Продано</th>
                  <th className="num">Остаток</th>
                  <th className="num">Себестоимость (FIFO)</th>
                  <th className="num">Стоимость остатка</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <React.Fragment key={p.product_id}>
                    <tr onClick={() => toggleExpand(p.product_id)}>
                      <td>
                        {p.product_name}
                        {p.oversold_qty > 0 && (
                          <span className="warehouse-warning" title="Продано больше, чем известно поставок — добавьте недостающие партии">
                            ⚠ продано на {formatNumber(p.oversold_qty)} шт больше поставок
                          </span>
                        )}
                      </td>
                      <td className="num">{formatNumber(p.total_supplied)}</td>
                      <td className="num">{formatNumber(p.total_sold)}</td>
                      <td className="num">{formatNumber(p.remaining)}</td>
                      <td className="num">{p.current_cost_price !== null ? formatMoney(p.current_cost_price) : '—'}</td>
                      <td className="num">{formatMoney(p.remaining_value)}</td>
                    </tr>
                    {expanded === p.product_id && (
                      <tr>
                        <td colSpan={6} className="warehouse-batches-cell">
                          <table className="product-table warehouse-sub-table">
                            <thead>
                              <tr>
                                <th>Партия от</th>
                                <th className="num">Себестоимость</th>
                                <th className="num">Поставлено</th>
                                <th className="num">Остаток</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.batches.map((b) => (
                                <tr key={b.id}>
                                  <td>{b.received_date}</td>
                                  <td className="num">{formatMoney(b.cost_price)}</td>
                                  <td className="num">{formatNumber(b.quantity)}</td>
                                  <td className="num">{formatNumber(b.remaining)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-note">
        Остаток считается по методу FIFO: сначала списываются самые старые партии. Себестоимость в колонке «Себестоимость (FIFO)» — это цена той партии,
        с которой спишется следующая продажа. Нажмите на строку товара, чтобы увидеть разбивку по партиям.
      </div>
    </div>
  );
}
