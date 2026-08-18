import React, { useEffect, useMemo, useState } from 'react';
import { fetchBatchProducts, fetchBatches, addBatch, updateBatch, deleteBatch, markBatchReceived } from './api.js';
import { formatMoney, formatNumber, formatDateDMY, WAREHOUSES } from './dateUtils.js';

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

  // Калькулятор валюты: партия часто оплачивается в $ или ¥, а не в тенге.
  // Вводим сумму за всю партию + курс на момент оплаты — ниже пересчитывается
  // в себестоимость за 1 шт (сумма * курс / количество), но поле остаётся
  // редактируемым вручную, если нужно поправить итог. Сумма/валюта/курс сохраняются
  // в базе как справочная информация — только для партий, где калькулятор использовался.
  const [purchaseAmountForeign, setPurchaseAmountForeign] = useState(editingBatch?.purchase_amount_foreign != null ? String(editingBatch.purchase_amount_foreign) : '');
  const [purchaseCurrency, setPurchaseCurrency] = useState(editingBatch?.purchase_currency || 'KZT');
  const [purchaseRate, setPurchaseRate] = useState(editingBatch?.purchase_rate != null ? String(editingBatch.purchase_rate) : '');
  const [logisticsAmountForeign, setLogisticsAmountForeign] = useState(editingBatch?.logistics_amount_foreign != null ? String(editingBatch.logistics_amount_foreign) : '');
  const [logisticsCurrency, setLogisticsCurrency] = useState(editingBatch?.logistics_currency || 'KZT');
  const [logisticsRate, setLogisticsRate] = useState(editingBatch?.logistics_rate != null ? String(editingBatch.logistics_rate) : '');
  const [receivedDate, setReceivedDate] = useState(editingBatch ? String(editingBatch.received_date).slice(0, 10) : todayISO());
  const [status, setStatus] = useState(editingBatch ? editingBatch.status || 'received' : 'received');
  const [note, setNote] = useState(editingBatch ? editingBatch.note || '' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const costPrice = (Number(purchasePrice) || 0) + (Number(logisticsCost) || 0);

  useEffect(() => {
    const amount = Number(purchaseAmountForeign);
    const qty = Number(quantity);
    if (!amount || !qty) return;
    const rate = purchaseCurrency === 'KZT' ? 1 : Number(purchaseRate);
    if (!rate) return;
    setPurchasePrice(String(Math.round((amount * rate / qty) * 100) / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseAmountForeign, purchaseCurrency, purchaseRate, quantity]);

  useEffect(() => {
    const amount = Number(logisticsAmountForeign);
    const qty = Number(quantity);
    if (!amount || !qty) return;
    const rate = logisticsCurrency === 'KZT' ? 1 : Number(logisticsRate);
    if (!rate) return;
    setLogisticsCost(String(Math.round((amount * rate / qty) * 100) / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logisticsAmountForeign, logisticsCurrency, logisticsRate, quantity]);

  function handleSubmit(e) {
    e.preventDefault();

    if (!purchasePrice || Number(purchasePrice) <= 0) {
      setError('Заполните сумму закупки, валюту, курс и количество — цена за 1 шт ещё не рассчиталась');
      return;
    }

    const payload = {
      warehouse,
      purchase_price: purchasePrice,
      logistics_cost: logisticsCost || 0,
      note,
      quantity,
      received_date: receivedDate,
      status,
      purchase_currency: purchaseAmountForeign ? purchaseCurrency : null,
      purchase_amount_foreign: purchaseAmountForeign || null,
      purchase_rate: purchaseAmountForeign ? (purchaseCurrency === 'KZT' ? 1 : purchaseRate) : null,
      logistics_currency: logisticsAmountForeign ? logisticsCurrency : null,
      logistics_amount_foreign: logisticsAmountForeign || null,
      logistics_rate: logisticsAmountForeign ? (logisticsCurrency === 'KZT' ? 1 : logisticsRate) : null,
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

          <div className="batch-form-row">
            <div className="batch-form-field">
              <label>Сумма закупки за партию</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={purchaseAmountForeign}
                onChange={(e) => setPurchaseAmountForeign(e.target.value)}
                placeholder="Сколько заплатили всего"
              />
            </div>
            <div className="batch-form-field">
              <label>Валюта</label>
              <select
                className="product-select"
                value={purchaseCurrency}
                onChange={(e) => setPurchaseCurrency(e.target.value)}
              >
                <option value="KZT">₸ Тенге</option>
                <option value="USD">$ Доллар</option>
                <option value="CNY">¥ Юань</option>
              </select>
            </div>
            <div className="batch-form-field">
              <label>Курс</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={purchaseCurrency === 'KZT' ? '' : purchaseRate}
                onChange={(e) => setPurchaseRate(e.target.value)}
                disabled={purchaseCurrency === 'KZT'}
                placeholder={purchaseCurrency === 'KZT' ? '—' : 'напр. 466'}
              />
            </div>
          </div>

          <div className="batch-form-row">
            <div className="batch-form-field">
              <label>Логистика за партию</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={logisticsAmountForeign}
                onChange={(e) => setLogisticsAmountForeign(e.target.value)}
                placeholder="Сколько заплатили за логистику всего"
              />
            </div>
            <div className="batch-form-field">
              <label>Валюта</label>
              <select
                className="product-select"
                value={logisticsCurrency}
                onChange={(e) => setLogisticsCurrency(e.target.value)}
              >
                <option value="KZT">₸ Тенге</option>
                <option value="USD">$ Доллар</option>
              </select>
            </div>
            <div className="batch-form-field">
              <label>Курс</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={logisticsCurrency === 'KZT' ? '' : logisticsRate}
                onChange={(e) => setLogisticsRate(e.target.value)}
                disabled={logisticsCurrency === 'KZT'}
                placeholder={logisticsCurrency === 'KZT' ? '—' : 'напр. 466'}
              />
            </div>
          </div>

          <div className="batch-form-row-2">
            <div className="batch-form-field">
              <label>Закупочная цена за 1 шт, ₸</label>
              <div className="batch-computed-value">{purchasePrice ? formatMoney(purchasePrice) : '—'}</div>
            </div>
            <div className="batch-form-field">
              <label>Логистика за 1 шт, ₸</label>
              <div className="batch-computed-value">{logisticsCost ? formatMoney(logisticsCost) : '0 ₸'}</div>
            </div>
          </div>

          <div className="batch-cost-preview">
            Себестоимость за 1 шт: <strong>{costPrice.toLocaleString('ru-RU')} ₸</strong>
          </div>

          <div className="batch-form-row">
            <div className="batch-form-field">
              <label>Статус поставки</label>
              <select
                className="product-select"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="received">Прибыло</option>
                <option value="in_transit">В пути</option>
              </select>
            </div>
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
              <label>{status === 'in_transit' ? 'Ожидаемая дата поставки' : 'Дата поступления'}</label>
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

export default function Batches({ password, onClose, active = true, isOnline = true }) {
  const [products, setProducts] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
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
      .finally(() => {
        setLoading(false);
        setHasData(true);
      });
  }

  // active в зависимостях — перепроверяем данные каждый раз при возврате на этот раздел
  // (страницы не размонтируются при переключении, см. Dashboard.jsx).
  useEffect(() => {
    if (active) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function handleDelete(id) {
    if (!window.confirm('Удалить эту поставку?')) return;
    deleteBatch(password, id)
      .then(() => loadAll())
      .catch((err) => setError(err.message));
  }

  function handleMarkReceived(id) {
    markBatchReceived(password, id)
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

  const groupedByWarehouse = filtered.reduce((acc, b) => {
    const city = b.warehouse || 'Без склада';
    if (!acc[city]) acc[city] = [];
    acc[city].push(b);
    return acc;
  }, {});
  const cities = Object.keys(groupedByWarehouse).sort((a, b) => a.localeCompare(b, 'ru'));

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

      {loading && !hasData ? (
        <div className="card">
          <div className="empty-state">Загрузка...</div>
        </div>
      ) : (
      <div style={{ opacity: loading || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
      {filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">Поставок пока нет — нажмите «Создать новую поставку»</div>
        </div>
      ) : (
        cities.map((city) => (
          <React.Fragment key={city}>
            <div className="section-title">{city}</div>
            <div className="card">
              <div className="table-scroll">
                <table className="product-table">
                  <thead>
                    <tr>
                      <th>№ поставки</th>
                      <th>Товар</th>
                      <th>Статус</th>
                      <th>Дата поступления</th>
                      <th className="num">Себестоимость</th>
                      <th className="num">Заявлено</th>
                      <th>Примечание</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedByWarehouse[city].map((b) => {
                      const noLogistics = !b.logistics_cost || Number(b.logistics_cost) === 0;
                      const inTransit = b.status === 'in_transit';
                      return (
                        <tr key={b.id} className="batch-row" onClick={() => openEdit(b)}>
                          <td className="num">#{b.id}</td>
                          <td>
                            {b.product_name}
                            {noLogistics && (
                              <span className="batch-missing-logistics">⚠ логистика не внесена</span>
                            )}
                          </td>
                          <td>
                            <span className={`batch-status-pill${inTransit ? ' in-transit' : ''}`}>
                              {inTransit ? 'В пути' : 'Прибыло'}
                            </span>
                          </td>
                          <td>{formatDateDMY(b.received_date)}</td>
                          <td className="num">{formatMoney(b.cost_price)}</td>
                          <td className="num">{formatNumber(b.quantity)}</td>
                          <td className="batch-note-cell">{b.note || '—'}</td>
                          <td className="num">
                            <div className="batch-row-actions">
                              {inTransit && (
                                <button
                                  className="batch-receive"
                                  onClick={(e) => { e.stopPropagation(); handleMarkReceived(b.id); }}
                                  title="Отметить как прибывшую"
                                >
                                  Прибыло
                                </button>
                              )}
                              <button
                                className="batch-delete"
                                onClick={(e) => { e.stopPropagation(); handleDelete(b.id); }}
                                title="Удалить поставку"
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </React.Fragment>
        ))
      )}
      </div>
      )}

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
