import React, { useEffect, useMemo, useState } from 'react';
import { fetchBatchProducts, fetchBatches, addBatch, updateBatch, deleteBatch } from './api.js';
import { formatMoney, formatNumber, WAREHOUSES } from './dateUtils.js';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// editingBatch === null -> режим создания. editingBatch объект -> режим редактирования (товар и склад
// продукта не меняются, только цена/логистика/количество/дата/примечание/склад отгрузки).
function BatchModal({ password, products, editingBatch, onClose, onSaved }) {
  const isEdit = Boolean(editingBatch);

  const [productId, setProductId] = useState(editingBatch ? editingBatch.product_id : '');
  const [warehouse, setWarehouse] = useState(editingBatch ? editingBatch.warehouse : 'Алматы');
  const [purchasePrice, setPurchasePrice] = useState(editingBatch ? String(editingBatch.purchase_price) : '');
  const [logisticsCost, setLogisticsCost] = useState(editingBatch ? String(editingBatch.logistics_cost) : '');
  const [quantity, setQuantity] = useState(editingBatch ? String(editingBatch.quantity) : '');
  const [receivedDate, setReceivedDate] = useState(editingBatch ? editingBatch.received_date : todayISO());
  const [note, setNote] = useState(editingBatch ? editingBatch.note || '' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const costPrice = (Number(purchasePrice) || 0) + (Number(logisticsCost) || 0);

  function handleSubmit(e) {
    e.preventDefault();

    const payload = {
      warehouse,
      purchase_price: purchasePrice,
      logistics_cost: logisticsCost || 0,
      note,
      quantity,
      received_date: receivedDate,
    };

    setSaving(true);
    setError('');

    if (isEdit) {
      updateBatch(password, editingBatch.id, payload)
        .then(() => onSaved())
        .catch((err) => setError(err.message))
        .finally(() => setSaving(false));
      return;
    }

    const product = products.find((p) => p.product_id === productId);
    if (!product) {
      setError('Выберите товар из списка');
      setSaving(false);
      return;
    }
    addBatch(password, {
      product_id: product.product_id,
      product_name: product.product_name,
      ...payload,
    })
      .then(() => onSaved())
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isEdit ? `Поставка #${editingBatch.id} — ${editingBatch.product_name}` : 'Новая поставка'}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="batch-form-row-2">
            <div className="batch-form-field">
              <label>Товар</label>
              {isEdit ? (
                <input type="text" value={editingBatch.product_name} disabled />
              ) : (
                <select
                  className="product-select"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  required
                >
                  <option value="" disabled>Выберите товар...</option>
                  {products.map((p) => (
                    <option key={p.product_id} value={p.product_id}>{p.product_name}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="batch-form-field">
              <label>Склад</label>
              <select
                className="product-select"
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value)}
                required
              >
                {WAREHOUSES.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="batch-form-row-2">
            <div className="batch-form-field">
              <label>Закупочная цена за 1 шт, ₸</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
                required
              />
            </div>
            <div className="batch-form-field">
              <label>Логистика за 1 шт, ₸</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={logisticsCost}
                onChange={(e) => setLogisticsCost(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="batch-cost-preview">
            Себестоимость за 1 шт: <strong>{costPrice.toLocaleString('ru-RU')} ₸</strong>
          </div>

          <div className="batch-form-row-2">
            <div className="batch-form-field">
              <label>Количество, шт</label>
              <input
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
              {isEdit && (
                <span className="batch-field-hint">Сейчас остаток: {formatNumber(editingBatch.remaining_quantity)} шт</span>
              )}
            </div>
            <div className="batch-form-field">
              <label>Дата поступления</label>
              <input
                type="date"
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="batch-form-field">
            <label>Примечание</label>
            <textarea
              className="batch-note-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Необязательно — например, номер поставщика или комментарий"
              rows={3}
            />
          </div>

          <button className="primary-button batch-submit" type="submit" disabled={saving}>
            {saving ? 'Сохраняем...' : isEdit ? 'Сохранить изменения' : 'Создать поставку'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function Batches({ password, onClose }) {
  const [products, setProducts] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingBatch, setEditingBatch] = useState(null);

  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  function loadAll() {
    setLoading(true);
    setError('');
    Promise.all([fetchBatchProducts(password), fetchBatches(password)])
      .then(([productsRes, batchesRes]) => {
        setProducts(productsRes.products);
        setBatches(batchesRes.batches);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDelete(id) {
    if (!window.confirm('Удалить эту поставку?')) return;
    deleteBatch(password, id)
      .then(() => loadAll())
      .catch((err) => setError(err.message));
  }

  function openCreate() {
    setEditingBatch(null);
    setShowModal(true);
  }

  function openEdit(batch) {
    setEditingBatch(batch);
    setShowModal(true);
  }

  // Список отсортирован от новых поставок к старым — как записи в журнале поставок
  const filtered = useMemo(() => {
    return batches
      .filter((b) => !search || b.product_name.toLowerCase().includes(search.toLowerCase()))
      .filter((b) => !productFilter || b.product_id === productFilter)
      .filter((b) => !warehouseFilter || b.warehouse === warehouseFilter)
      .filter((b) => !dateFrom || b.received_date >= dateFrom)
      .filter((b) => !dateTo || b.received_date <= dateTo)
      .sort((a, b) => (a.received_date < b.received_date ? 1 : -1));
  }, [batches, search, productFilter, warehouseFilter, dateFrom, dateTo]);

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Поставки <span>товаров</span></h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="batches-toolbar">
        <input
          className="toolbar-input"
          type="text"
          placeholder="Поиск по товару..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="toolbar-select"
          value={productFilter}
          onChange={(e) => setProductFilter(e.target.value)}
        >
          <option value="">Все товары</option>
          {products.map((p) => (
            <option key={p.product_id} value={p.product_id}>{p.product_name}</option>
          ))}
        </select>
        <select
          className="toolbar-select"
          value={warehouseFilter}
          onChange={(e) => setWarehouseFilter(e.target.value)}
        >
          <option value="">Все склады</option>
          {WAREHOUSES.map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
        <input
          className="toolbar-input toolbar-date"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
        />
        <span className="toolbar-arrow">→</span>
        <input
          className="toolbar-input toolbar-date"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
        />
        <button className="primary-button toolbar-create" onClick={openCreate}>
          + Создать новую поставку
        </button>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Поставок пока нет — нажмите «Создать новую поставку»</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>№ поставки</th>
                  <th>Товар</th>
                  <th>Склад</th>
                  <th>Дата поступления</th>
                  <th className="num">Себестоимость</th>
                  <th className="num">Заявлено</th>
                  <th className="num">Остаток</th>
                  <th>Примечание</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => {
                  const noLogistics = !b.logistics_cost || Number(b.logistics_cost) === 0;
                  return (
                    <tr key={b.id} className="batch-row" onClick={() => openEdit(b)}>
                      <td className="num">#{b.id}</td>
                      <td>
                        {b.product_name}
                        {noLogistics && (
                          <span className="batch-missing-logistics">⚠ логистика не внесена</span>
                        )}
                      </td>
                      <td>{b.warehouse}</td>
                      <td>{b.received_date}</td>
                      <td className="num">{formatMoney(b.cost_price)}</td>
                      <td className="num">{formatNumber(b.quantity)}</td>
                      <td className="num">{formatNumber(b.remaining_quantity)}</td>
                      <td className="batch-note-cell">{b.note || '—'}</td>
                      <td className="num">
                        <button
                          className="batch-delete"
                          onClick={(e) => { e.stopPropagation(); handleDelete(b.id); }}
                          title="Удалить поставку"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <BatchModal
          password={password}
          products={products}
          editingBatch={editingBatch}
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            loadAll();
          }}
        />
      )}
    </div>
  );
}
