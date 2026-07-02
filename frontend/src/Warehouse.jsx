import React, { useEffect, useState } from 'react';
import { fetchWarehouse } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';

export default function Warehouse({ password }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [warehouseFilter, setWarehouseFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetchWarehouse(password)
      .then((res) => setProducts(res.products))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password]);

  function toggleExpand(key) {
    setExpanded((prev) => (prev === key ? null : key));
  }

  const filtered = warehouseFilter ? products.filter((p) => p.warehouse === warehouseFilter) : products;

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Склад <span>остатков</span></h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="batches-toolbar">
        <select
          className="toolbar-select"
          value={warehouseFilter}
          onChange={(e) => setWarehouseFilter(e.target.value)}
        >
          <option value="">Все склады</option>
          <option value="Алматы">Алматы</option>
          <option value="Астана">Астана</option>
        </select>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Пока нет данных — сначала добавьте партии на странице «Поставки»</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Склад</th>
                  <th className="num">Поставлено</th>
                  <th className="num">Продано</th>
                  <th className="num">Остаток</th>
                  <th className="num">Себестоимость (FIFO)</th>
                  <th className="num">Стоимость остатка</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const rowKey = `${p.product_id}::${p.warehouse}`;
                  return (
                    <React.Fragment key={rowKey}>
                      <tr onClick={() => toggleExpand(rowKey)}>
                        <td>
                          {p.product_name}
                          {p.oversold_qty > 0 && (
                            <span className="warehouse-warning" title="Продано больше, чем известно поставок на этом складе — добавьте недостающие партии">
                              ⚠ продано на {formatNumber(p.oversold_qty)} шт больше поставок
                            </span>
                          )}
                        </td>
                        <td>{p.warehouse}</td>
                        <td className="num">{formatNumber(p.total_supplied)}</td>
                        <td className="num">{formatNumber(p.total_sold)}</td>
                        <td className="num">{formatNumber(p.remaining)}</td>
                        <td className="num">{p.current_cost_price !== null ? formatMoney(p.current_cost_price) : '—'}</td>
                        <td className="num">{formatMoney(p.remaining_value)}</td>
                      </tr>
                      {expanded === rowKey && p.batches.length > 0 && (
                        <tr>
                          <td colSpan={7} className="warehouse-batches-cell">
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-note">
        Остаток считается по методу FIFO отдельно для каждого склада: партии Алматы списываются только продажами, отгруженными из Алматы, партии Астаны — только
        продажами из Астаны (город отгрузки Kaspi присылает в каждом заказе). Строка «Не определён» — заказы, по которым Kaspi не прислал город отгрузки.
        Нажмите на строку товара, чтобы увидеть разбивку по партиям.
      </div>
    </div>
  );
}
