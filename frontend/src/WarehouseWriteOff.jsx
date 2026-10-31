import React, { useEffect, useState } from 'react';
import { cancelWriteOff, createWriteOff, fetchWriteOffStock } from './api.js';
import { formatDateDMY, formatMoney, formatNumber } from './dateUtils.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';
import { useClosing } from './useClosing.js';

// Списание товара на странице "Склад": бартер блогерам, товар для контента, брак. Товар уходит
// без выручки, его себестоимость попадает в расход месяца. Окно собрано по образцу перемещения
// (WarehouseTransfer.jsx), что происходит с партиями — см. docs/CONTEXT.md, раздел про списание.

function newRow() {
  return { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, product_id: '', quantity: '' };
}

function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 10);
}

export function WriteOffHistory({ password, writeOffs, canCancel, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (writeOffs.length === 0) return null;

  function handleCancel(id) {
    setBusy(true);
    setError('');
    cancelWriteOff(password, id)
      .then(() => onChanged())
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }

  return (
    <section className="warehouse-history">
      <div className="section-title">История списаний</div>
      {error && <div className="error-banner">{error}</div>}
      {writeOffs.map((writeOff) => {
        const total = writeOff.items.reduce((sum, item) => sum + Number(item.value), 0);
        return (
          <details className="card warehouse-history-card" key={writeOff.id}>
            <summary className="warehouse-history-summary">
              <span>
                <b>{writeOff.reason} · {writeOff.from_warehouse}</b>
                <small>{formatMoney(total)}{writeOff.cancelled_at ? ' · отменено' : ''}</small>
              </span>
              <span className="warehouse-history-meta">
                {formatDateDMY(writeOff.effective_date)}
                {writeOff.created_by ? ` · ${writeOff.created_by}` : ''}
              </span>
            </summary>
            {writeOff.note && <div className="warehouse-history-note">{writeOff.note}</div>}
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
                  {writeOff.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.product_name}</td>
                      <td className="num">{formatNumber(item.quantity)}</td>
                      <td className="num">{formatMoney(item.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canCancel && !writeOff.cancelled_at && (
              <button className="sync-button warehouse-writeoff-cancel" type="button" disabled={busy} onClick={() => handleCancel(writeOff.id)}>
                Отменить списание
              </button>
            )}
          </details>
        );
      })}
    </section>
  );
}

export function WriteOffModal({ password, onClose, onSaved }) {
  const [stock, setStock] = useState([]);
  const [reasons, setReasons] = useState([]);
  const [warehouse, setWarehouse] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState(() => [newRow()]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey] = useState(() => (
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `write-off-${Date.now()}-${Math.random().toString(36).slice(2)}`
  ));

  useBodyScrollLock();
  const { closing, close } = useClosing(onClose);

  useEffect(() => {
    fetchWriteOffStock(password)
      .then((res) => {
        setStock(res.products);
        setReasons(res.reasons);
        setReason(res.reasons[0] || '');
        setWarehouse(res.products[0]?.warehouse || '');
      })
      .catch((err) => setError(err.message));
  }, [password]);

  const warehouses = [...new Set(stock.map((p) => p.warehouse))];
  const available = stock
    .filter((p) => p.warehouse === warehouse)
    .sort((a, b) => a.product_name.localeCompare(b.product_name, 'ru'));

  function updateRow(key, patch) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const seen = new Set();
    const items = [];
    for (const row of rows) {
      const product = available.find((p) => p.product_id === row.product_id);
      const quantity = Number(row.quantity);
      if (!product || !Number.isInteger(quantity) || quantity <= 0) {
        setError('У каждой строки выберите товар и укажите целое количество');
        return;
      }
      if (quantity > Number(product.remaining)) {
        setError(`«${product.product_name}»: на складе ${warehouse} доступно ${formatNumber(product.remaining)} шт.`);
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
      await createWriteOff(password, {
        idempotency_key: idempotencyKey,
        warehouse,
        reason,
        effective_date: date,
        note: note.trim() || null,
        items,
      });
      onSaved();
    } catch (err) {
      setError(err.message || 'Не удалось списать товар');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`modal-overlay${closing ? ' is-closing' : ''}`} onClick={saving ? undefined : close}>
      <div className="modal-box modal-box-wide warehouse-reconcile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Списание товара</h2>
          <button className="modal-close" type="button" onClick={close} disabled={saving}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="warehouse-reconcile-head">
            <label>
              <span>Склад</span>
              <select
                value={warehouse}
                onChange={(e) => {
                  setWarehouse(e.target.value);
                  setRows([newRow()]);
                }}
              >
                {warehouses.map((city) => <option value={city} key={city}>{city}</option>)}
              </select>
            </label>
            <label>
              <span>Причина</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                {reasons.map((item) => <option value={item} key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span>Дата, месяц расхода</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </label>
          </div>

          <div className="warehouse-reconcile-label">Товары</div>
          <div className="warehouse-reconcile-rows">
            {rows.map((row, index) => (
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
                  <span>Останется</span>
                  <b>
                    {row.product_id && row.quantity !== ''
                      ? `${formatNumber(Number(available.find((p) => p.product_id === row.product_id)?.remaining || 0) - Number(row.quantity))} шт.`
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
            ))}
          </div>

          <button className="secondary-button warehouse-reconcile-add" type="button" onClick={() => setRows((current) => [...current, newRow()])}>
            + Добавить товар
          </button>

          <label className="warehouse-reconcile-note">
            <span>Комментарий</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например, кому отдали" />
          </label>

          <div className="warehouse-reconcile-hint">
            Остаток уменьшится, а себестоимость попадёт в расход выбранного месяца в «Отчёте» и на «Главной».
          </div>

          <div className="warehouse-reconcile-actions">
            <button className="secondary-button" type="button" onClick={close} disabled={saving}>Отмена</button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? 'Списываем…' : 'Списать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
