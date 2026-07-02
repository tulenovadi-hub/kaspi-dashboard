import React, { useEffect, useMemo, useState } from 'react';
import { fetchBatchProducts, fetchBatches, addBatch, deleteBatch } from './api.js';
import { formatMoney, formatNumber, WAREHOUSES } from './dateUtils.js';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function AddBatchModal({ password, products, onClose, onSaved }) {
  const [productId, setProductId] = useState('');
  const [warehouse, setWarehouse] = useState('Алматы');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [logisticsCost, setLogisticsCost] = useState('');
  const [quantity, setQuantity] = useState('');
  const [receivedDate, setReceivedDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const costPrice = (Number(purchasePrice) || 0) + (Number(logisticsCost) || 0);

  function handleSubmit(e) {
    e.preventDefault();
    const product = products.find((p) => p.product_id === productId);
    if (!product) {
      setError('Выберите товар из списка');
      return;
    }
    setSaving(true);
    setError('');
    addBatch(password, {
      product_id: product.product_id,
      product_name: product.product_name,
      warehouse,
      purchase_price: purchasePrice,
      logistics_cost: logisticsCost || 0,
      note,
      quantity,
      received_date: receivedDate,
    })
      .then(() => onSaved())
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Новая поставка</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="batch-form-row-2">
            <div className="batch-form-field">
              <label>Товар</label>
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
            {saving ? 'Сохраняем...' : 'Создать поставку'}
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
          <option value="Алматы">Алматы</option>
          <option value="Астана">Астана</option>
          <option value="Талдыкорган">Талдыкорган</option>
          <option value="Юбилейное">Юбилейное</option>
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
        <button className="primary-button toolbar-create" onClick={() => setShowModal(true)}>
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
              {filtered.map((b) => (
                <tr key={b.id}>
                  <td className="num">#{b.id}</td>
                  <td>{b.product_name}</td>
                  <td>{b.warehouse}</td>
                  <td>{b.received_date}</td>
                  <td className="num">{formatMoney(b.cost_price)}</td>
                  <td className="num">{formatNumber(b.quantity)}</td>
                  <td className="num">{formatNumber(b.remaining_quantity)}</td>
                  <td className="batch-note-cell">{b.note || '—'}</td>
                  <td className="num">
                    <button className="batch-delete" onClick={() => handleDelete(b.id)} title="Удалить поставку">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <AddBatchModal
          password={password}
          products={products}
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
