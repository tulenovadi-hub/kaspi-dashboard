import React, { useState } from 'react';
import { transferWarehouseStock } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';
import { useClosing } from './useClosing.js';

// Перемещение товара между складами на странице "Склад". Окно собрано по образцу "Новой сверки
// остатков": те же поля и те же стили. Что происходит с партиями — см. backend/warehouseTransfer.js.

function formatTime(value) {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function newRow() {
  return { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, product_id: '', quantity: '' };
}

export function TransferHistory({ transfers }) {
  if (transfers.length === 0) return null;
  return (
    <section className="warehouse-history">
      <div className="section-title">История перемещений</div>
      {transfers.map((transfer, index) => (
        <details className="card warehouse-history-card" key={transfer.id} open={index === 0}>
          <summary className="warehouse-history-summary">
            <span><b>{transfer.from_warehouse} → {transfer.to_warehouse}</b></span>
            <span className="warehouse-history-meta">
              {formatTime(transfer.created_at)}
              {transfer.created_by ? ` · ${transfer.created_by}` : ''}
            </span>
          </summary>
          {transfer.note && <div className="warehouse-history-note">{transfer.note}</div>}
          <div className="table-scroll">
            <table className="product-table warehouse-history-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th className="num">Количество</th>
                  <th className="num">Себестоимость</th>
                </tr>
              </thead>
              <tbody>
                {transfer.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name}</td>
                    <td className="num">{formatNumber(item.quantity)}</td>
                    <td className="num">{formatMoney(item.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </section>
  );
}

export function TransferModal({ password, products, cities, onClose, onSaved }) {
  const sources = cities.filter((city) => products.some((p) => p.warehouse === city && Number(p.remaining) > 0));
  const [from, setFrom] = useState(sources[0] || '');
  const [to, setTo] = useState(cities.find((city) => city !== sources[0]) || '');
  const [rows, setRows] = useState(() => [newRow()]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey] = useState(() => (
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`
  ));

  useBodyScrollLock();
  const { closing, close } = useClosing(onClose);

  const available = products
    .filter((p) => p.warehouse === from && Number(p.remaining) > 0)
    .sort((a, b) => a.product_name.localeCompare(b.product_name, 'ru'));

  const stockAt = (warehouse, productId) => {
    const product = products.find((p) => p.warehouse === warehouse && p.product_id === productId);
    return product ? Number(product.remaining) : 0;
  };

  function updateRow(key, patch) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  // Товары выбраны со склада-отправителя: при его смене старый выбор уже ничего не значит.
  function changeFrom(city) {
    setFrom(city);
    if (city === to) setTo(from);
    setRows([newRow()]);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const prepared = rows.filter((row) => row.product_id || row.quantity !== '');
    if (prepared.length === 0) {
      setError('Добавьте хотя бы один товар');
      return;
    }
    if (from === to) {
      setError('Выберите два разных склада');
      return;
    }

    const seen = new Set();
    const items = [];
    for (const row of prepared) {
      const product = available.find((p) => p.product_id === row.product_id);
      const quantity = Number(row.quantity);
      if (!product || !Number.isInteger(quantity) || quantity <= 0) {
        setError('У каждой строки выберите товар и укажите целое количество');
        return;
      }
      if (quantity > Number(product.remaining)) {
        setError(`«${product.product_name}»: на складе ${from} доступно ${formatNumber(product.remaining)} шт.`);
        return;
      }
      if (seen.has(row.product_id)) {
        setError(`Товар «${product.product_name}» добавлен дважды`);
        return;
      }
      seen.add(row.product_id);
      items.push({ product_id: product.product_id, product_name: product.product_name, quantity });
    }

    setSaving(true);
    try {
      await transferWarehouseStock(password, {
        idempotency_key: idempotencyKey,
        from_warehouse: from,
        to_warehouse: to,
        note: note.trim() || null,
        items,
      });
      onSaved();
    } catch (err) {
      setError(err.message || 'Не удалось переместить товар');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`modal-overlay${closing ? ' is-closing' : ''}`} onClick={saving ? undefined : close}>
      <div className="modal-box modal-box-wide warehouse-reconcile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Перемещение товара</h2>
          <button className="modal-close" type="button" onClick={close} disabled={saving}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="warehouse-reconcile-head">
            <label>
              <span>Откуда</span>
              <select value={from} onChange={(e) => changeFrom(e.target.value)}>
                {sources.map((city) => <option value={city} key={city}>{city}</option>)}
              </select>
            </label>
            <label>
              <span>Куда</span>
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {cities.filter((city) => city !== from).map((city) => <option value={city} key={city}>{city}</option>)}
              </select>
            </label>
          </div>

          <div className="warehouse-reconcile-label">Товары</div>
          <div className="warehouse-reconcile-rows">
            {rows.map((row, index) => {
              const quantity = row.quantity === '' ? null : Number(row.quantity);
              const sourceStock = stockAt(from, row.product_id);
              const targetStock = stockAt(to, row.product_id);
              const valid = row.product_id && quantity !== null && Number.isFinite(quantity);
              return (
                <div className="warehouse-reconcile-row warehouse-transfer-row" key={row.key}>
                  <label className="warehouse-reconcile-product">
                    <span>Товар</span>
                    <select value={row.product_id} onChange={(e) => updateRow(row.key, { product_id: e.target.value })} required>
                      <option value="">Выберите товар</option>
                      {available.map((product) => (
                        <option value={product.product_id} key={product.product_id}>
                          {product.product_name} ({formatNumber(product.remaining)} шт.)
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Количество</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      inputMode="numeric"
                      value={row.quantity}
                      onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
                      required
                    />
                  </label>
                  <div className="warehouse-reconcile-preview">
                    <span>Станет</span>
                    <b>
                      {valid
                        ? `${from} ${formatNumber(sourceStock - quantity)} · ${to} ${formatNumber(targetStock + quantity)}`
                        : '—'}
                    </b>
                  </div>
                  <button
                    className="warehouse-reconcile-remove"
                    type="button"
                    aria-label={`Удалить строку ${index + 1}`}
                    onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
                    disabled={rows.length === 1}
                  >✕</button>
                </div>
              );
            })}
          </div>

          <button className="secondary-button warehouse-reconcile-add" type="button" onClick={() => setRows((current) => [...current, newRow()])}>
            + Добавить товар
          </button>

          <label className="warehouse-reconcile-note">
            <span>Комментарий</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например, номер накладной" />
          </label>

          <div className="warehouse-reconcile-hint">
            Товар сразу спишется с первого склада и появится на втором с той же себестоимостью. В поставке изменится
            распределение по городам, продажи и прибыль прошлых месяцев не изменятся.
          </div>

          <div className="warehouse-reconcile-actions">
            <button className="secondary-button" type="button" onClick={close} disabled={saving}>Отмена</button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? 'Перемещаем…' : 'Переместить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
