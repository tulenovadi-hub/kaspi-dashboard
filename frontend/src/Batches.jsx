import React, { useEffect, useMemo, useState } from 'react';
import { fetchBatchProducts, fetchBatches, addBatch, updateBatch, deleteBatch, markBatchReceived } from './api.js';
import { formatMoney, formatNumber, formatDateDMY } from './dateUtils.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Строки "прочих расходов" можно удалять из середины списка, поэтому индекс массива
// не годится как React-key (после удаления React переиспользовал бы поля не от той строки
// и введённые значения "переехали" бы). Выдаём каждой строке свой стабильный id.
let nextExpenseKey = 0;
function makeExpenseRow(saved) {
  return {
    key: `expense-${nextExpenseKey++}`,
    name: saved?.name || '',
    amount: saved?.amount != null ? String(saved.amount) : '',
    currency: saved?.currency || 'KZT',
    // Для тенге курс не показываем и не храним — он всегда 1.
    rate: saved?.rate != null && saved.currency !== 'KZT' ? String(saved.rate) : '',
  };
}

// editingBatch === null -> режим создания. editingBatch объект -> режим редактирования (товар и склад
// продукта не меняются, только цена/логистика/количество/дата/примечание/склад отгрузки).
function BatchModal({ password, products, warehouses, editingBatch, onClose, onSaved }) {
  const isEdit = Boolean(editingBatch);

  useBodyScrollLock();

  const [productId, setProductId] = useState(editingBatch ? editingBatch.product_id : '');
  // Новый товар: карточка на Kaspi уже создана, партия едет, но продаж ещё не было — значит
  // в выпадающем списке его нет. Тогда артикул и название вводятся руками.
  const [manualProduct, setManualProduct] = useState(false);
  const [manualProductId, setManualProductId] = useState('');
  const [manualProductName, setManualProductName] = useState('');
  const matchedManualProduct = manualProduct
    ? products.find((p) => p.product_id === manualProductId.trim() && p.from_sales !== false)
    : null;
  const [warehouse, setWarehouse] = useState(editingBatch ? editingBatch.warehouse : (warehouses[0] || ''));
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
  // Прочие расходы на партию (сертификаты, НДС, растаможка...) — произвольный список,
  // названия пользователь пишет сам. Суммы указываются за ВСЮ партию, как закупка и логистика.
  const [extraExpenses, setExtraExpenses] = useState(() =>
    Array.isArray(editingBatch?.extra_expenses) ? editingBatch.extra_expenses.map(makeExpenseRow) : []
  );
  const [note, setNote] = useState(editingBatch ? editingBatch.note || '' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Условия отбора строк должны совпадать с normalizeExtraExpenses на бэкенде,
  // иначе предпросмотр себестоимости разойдётся с тем, что реально сохранится.
  const filledExpenses = extraExpenses.filter((e) => e.name.trim() && e.amount !== '' && Number(e.amount) >= 0);
  const extraTotalKzt = filledExpenses.reduce(
    (sum, e) => sum + (Number(e.amount) || 0) * (e.currency === 'KZT' ? 1 : (Number(e.rate) || 1)),
    0
  );
  const extraPerUnit = Number(quantity) ? extraTotalKzt / Number(quantity) : 0;

  const costPrice = (Number(purchasePrice) || 0) + (Number(logisticsCost) || 0) + extraPerUnit;

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

  function updateExpense(key, field, value) {
    setExtraExpenses((rows) => rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function addExpense() {
    setExtraExpenses((rows) => [...rows, makeExpenseRow()]);
  }

  function removeExpense(key) {
    setExtraExpenses((rows) => rows.filter((r) => r.key !== key));
  }

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
      // key — чисто клиентское поле для React, на сервер его не отправляем.
      extra_expenses: filledExpenses.map((exp) => ({
        name: exp.name.trim(),
        amount: Number(exp.amount),
        currency: exp.currency,
        rate: exp.currency === 'KZT' ? 1 : (Number(exp.rate) || 1),
      })),
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

    let chosen;
    if (manualProduct) {
      const id = manualProductId.trim();
      const name = manualProductName.trim();
      if (!id || !name) {
        setError('Для нового товара заполните артикул и название');
        setSaving(false);
        return;
      }
      // Если такой артикул уже есть в продажах — берём название оттуда: оно от Kaspi
      // и точно совпадает с тем, что будет приходить в заказах.
      const known = products.find((p) => p.product_id === id);
      chosen = { product_id: id, product_name: known ? known.product_name : name };
    } else {
      chosen = products.find((p) => p.product_id === productId);
      if (!chosen) {
        setError('Выберите товар из списка');
        setSaving(false);
        return;
      }
    }
    addBatch(password, {
      product_id: chosen.product_id,
      product_name: chosen.product_name,
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
          {/* Форма длинная (14 полей), поэтому разбита на смысловые блоки с подписями —
              иначе на телефоне это сплошная лента полей, в которой легко потеряться.
              Порядок блоков = порядок мыслей: что везём → сколько штук → сколько заплатили
              за товар → сколько за доставку → что в итоге вышло за штуку. */}
          <div className="form-section">
            <div className="form-section-title">Товар</div>

            <div className="batch-form-row-2">
              <div className="batch-form-field">
                <label>Товар</label>
                {isEdit ? (
                  <input type="text" value={editingBatch.product_name} disabled />
                ) : manualProduct ? (
                  <input
                    type="text"
                    value={manualProductName}
                    onChange={(e) => setManualProductName(e.target.value)}
                    placeholder="Название товара"
                    maxLength={200}
                  />
                ) : (
                  <select
                    className="product-select"
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                    required
                  >
                    <option value="" disabled>Выберите товар...</option>
                    {products.map((p) => (
                      <option key={p.product_id} value={p.product_id}>
                        {p.product_name}{p.from_sales === false ? ' — продаж ещё нет' : ''}
                      </option>
                    ))}
                  </select>
                )}
                {!isEdit && (
                  <button
                    type="button"
                    className="batch-manual-toggle"
                    onClick={() => {
                      setManualProduct(!manualProduct);
                      setError('');
                    }}
                  >
                    {manualProduct ? '← Выбрать из списка' : 'Товара нет в списке — ввести вручную'}
                  </button>
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
                  {warehouses.map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Артикул — единственное, что связывает партию с продажами при FIFO-списании.
                Ошибка в нём не даст никакой ошибки при сохранении: партия просто ляжет в базу
                и никогда ни с чем не свяжется, себестоимость по товару так и не спишется.
                Поэтому поле идёт отдельной строкой во всю ширину и с подписью, откуда его взять. */}
            {!isEdit && manualProduct && (
              <div className="batch-form-field batch-form-field-full">
                <label>Артикул (код товара)</label>
                <input
                  type="text"
                  value={manualProductId}
                  onChange={(e) => setManualProductId(e.target.value)}
                  placeholder="например, 305435303"
                  maxLength={100}
                />
                {matchedManualProduct ? (
                  <span className="batch-field-hint batch-field-hint-ok">
                    Такой артикул уже есть в продажах: «{matchedManualProduct.product_name}» — возьмём это название
                  </span>
                ) : (
                  <span className="batch-field-hint">
                    Артикул из карточки товара на Kaspi (в кабинете продавца — «Артикул»),
                    символ в символ. Проверить просто: после первой продажи товар должен
                    пропасть из списка с пометкой «продаж ещё нет». Если пометка осталась —
                    артикул не совпал, и партию нужно завести заново с правильным.
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Количество стоит ВЫШЕ блоков с суммами намеренно: обе суммы делятся именно на
              него, поэтому сначала логично указать, сколько штук в партии. */}
          <div className="form-section">
            <div className="form-section-title">Партия</div>
            <div className="form-section-hint">Сколько штук привезли и когда — на это количество делятся суммы ниже</div>

            <div className="batch-form-row">
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
                <label>{status === 'in_transit' ? 'Ожидаемая дата' : 'Дата поступления'}</label>
                <input
                  type="date"
                  value={receivedDate}
                  onChange={(e) => setReceivedDate(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Закупка</div>
            <div className="form-section-hint">Сколько всего заплатили поставщику за всю партию</div>

            <div className="batch-form-row">
              <div className="batch-form-field">
                <label>Сумма за партию</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={purchaseAmountForeign}
                  onChange={(e) => setPurchaseAmountForeign(e.target.value)}
                  placeholder="0"
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
                <label>Курс на день оплаты</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={purchaseCurrency === 'KZT' ? '' : purchaseRate}
                  onChange={(e) => setPurchaseRate(e.target.value)}
                  disabled={purchaseCurrency === 'KZT'}
                  placeholder={purchaseCurrency === 'KZT' ? 'не нужен' : 'напр. 466'}
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Логистика</div>
            <div className="form-section-hint">Сколько всего заплатили за доставку этой партии</div>

            <div className="batch-form-row">
              <div className="batch-form-field">
                <label>Сумма за партию</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={logisticsAmountForeign}
                  onChange={(e) => setLogisticsAmountForeign(e.target.value)}
                  placeholder="0"
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
                <label>Курс на день оплаты</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={logisticsCurrency === 'KZT' ? '' : logisticsRate}
                  onChange={(e) => setLogisticsRate(e.target.value)}
                  disabled={logisticsCurrency === 'KZT'}
                  placeholder={logisticsCurrency === 'KZT' ? 'не нужен' : 'напр. 466'}
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Прочие расходы</div>
            <div className="form-section-hint">
              Всё остальное, что вошло в стоимость партии — сертификаты, НДС, растаможка и т.п.
              Название придумываете сами, сумма указывается за всю партию
            </div>

            {extraExpenses.map((exp) => (
              <div className="expense-row" key={exp.key}>
                <div className="batch-form-field expense-name">
                  <label>Название</label>
                  <input
                    type="text"
                    value={exp.name}
                    onChange={(e) => updateExpense(exp.key, 'name', e.target.value)}
                    placeholder="Например, Сертификаты"
                    maxLength={60}
                  />
                </div>
                <div className="batch-form-field expense-amount">
                  <label>Сумма за партию</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={exp.amount}
                    onChange={(e) => updateExpense(exp.key, 'amount', e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="batch-form-field expense-currency">
                  <label>Валюта</label>
                  <select
                    className="product-select"
                    value={exp.currency}
                    onChange={(e) => updateExpense(exp.key, 'currency', e.target.value)}
                  >
                    <option value="KZT">₸ Тенге</option>
                    <option value="USD">$ Доллар</option>
                    <option value="CNY">¥ Юань</option>
                  </select>
                </div>
                <div className="batch-form-field expense-rate">
                  <label>Курс на день оплаты</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={exp.currency === 'KZT' ? '' : exp.rate}
                    onChange={(e) => updateExpense(exp.key, 'rate', e.target.value)}
                    disabled={exp.currency === 'KZT'}
                    placeholder={exp.currency === 'KZT' ? 'не нужен' : 'напр. 466'}
                  />
                </div>
                <button
                  type="button"
                  className="expense-remove"
                  onClick={() => removeExpense(exp.key)}
                  title="Удалить этот расход"
                  aria-label="Удалить этот расход"
                >
                  ✕
                </button>
              </div>
            ))}

            <button type="button" className="expense-add" onClick={addExpense}>
              + Добавить расход
            </button>
          </div>

          <div className="form-section form-section-result">
            <div className="form-section-title">Себестоимость за 1 шт</div>
            <div className="form-section-hint">Считается сама: сумма × курс ÷ количество. Вручную не редактируется</div>

            <div className="batch-result-row">
              <div className="batch-form-field">
                <label>Закупка</label>
                <div className="batch-computed-value">{purchasePrice ? formatMoney(purchasePrice) : '—'}</div>
              </div>
              <div className="batch-form-field">
                <label>Логистика</label>
                <div className="batch-computed-value">{logisticsCost ? formatMoney(logisticsCost) : '0 ₸'}</div>
              </div>
              {filledExpenses.length > 0 && (
                <div className="batch-form-field">
                  <label>Прочие</label>
                  <div className="batch-computed-value">{formatMoney(extraPerUnit)}</div>
                </div>
              )}
              <div className="batch-form-field">
                <label>Итого за 1 шт</label>
                <div className="batch-computed-value batch-computed-total">{formatMoney(costPrice)}</div>
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Примечание</div>

            <div className="batch-form-field">
              <textarea
                className="batch-note-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Необязательно — например, номер поставщика или комментарий"
                rows={3}
              />
            </div>
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
  // Склады приходят с сервера (единый справочник backend/warehouseMapping.js), а не задаются здесь
  const [warehouses, setWarehouses] = useState([]);
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
        setWarehouses(batchesRes.warehouses || []);
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
          {warehouses.map((w) => (
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
          warehouses={warehouses}
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
