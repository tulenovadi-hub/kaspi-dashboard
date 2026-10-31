import React, { useEffect, useState } from 'react';
import { addManualSale, fetchBatchProducts, fetchManualSales, removeManualSale } from './api.js';
import { formatDateDMY, formatMoney, formatNumber } from './dateUtils.js';
import { useAppRefresh } from './useAppRefresh.js';
import { useWarehouseCities } from './useWarehouseCities.js';

// Карточка на "Заказах": продажи из Kaspi Pay без заказа в магазине (счёт на удалённую оплату).
// Kaspi не сообщает по ним ни товар, ни склад, поэтому их указывает владелец. Как такая продажа
// попадает в учёт — см. backend/routes/manualSales.js. onChanged перечитывает список заказов.

function PendingSale({ sale, products, cities, saving, onLink }) {
  const [productId, setProductId] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [quantity, setQuantity] = useState('1');

  function handleSubmit(e) {
    e.preventDefault();
    const product = products.find((p) => p.product_id === productId);
    onLink({
      order_number: sale.order_number,
      product_id: productId,
      product_name: product ? product.product_name : productId,
      warehouse,
      quantity: Number(quantity),
    });
  }

  return (
    <form className="manual-sale" onSubmit={handleSubmit}>
      <div className="manual-sale-head">
        <span>№ {sale.order_number} · {formatDateDMY(sale.date)}{sale.details ? ` · ${sale.details}` : ''}</span>
        <b>{formatMoney(sale.amount)}</b>
      </div>
      <div className="manual-sale-fields">
        <label>
          <span>Товар</span>
          <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
            <option value="">Выберите товар</option>
            {products.map((p) => <option value={p.product_id} key={p.product_id}>{p.product_name}</option>)}
          </select>
        </label>
        <label>
          <span>Склад</span>
          <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} required>
            <option value="">Выберите склад</option>
            {cities.map((city) => <option value={city} key={city}>{city}</option>)}
          </select>
        </label>
        <label>
          <span>Количество</span>
          <input type="number" min="1" step="1" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
        </label>
        <button className="primary-button" type="submit" disabled={saving}>Привязать</button>
      </div>
    </form>
  );
}

export default function ManualSales({ password, active = true, onChanged }) {
  const [pending, setPending] = useState([]);
  const [linked, setLinked] = useState([]);
  const [products, setProducts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const cities = useWarehouseCities(password, active);
  const refreshTick = useAppRefresh(active);

  function load() {
    return fetchManualSales(password)
      .then((res) => {
        setPending(res.pending);
        setLinked(res.linked);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    if (!active) return;
    load();
    fetchBatchProducts(password).then((res) => setProducts(res.products)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshTick]);

  function run(action) {
    setSaving(true);
    setError('');
    return action()
      .then(() => load())
      .then(() => onChanged())
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  if (pending.length === 0 && linked.length === 0 && !error) return null;

  return (
    <div className="card manual-sales">
      <div className="section-title">Продажи вне магазина Kaspi</div>
      {pending.length > 0 && (
        <div className="manual-sales-hint">
          Оплата по счёту, Kaspi не сообщает товар и склад. Пока продажа не привязана, она не уменьшает остаток,
          а в «Отчёте» идёт без себестоимости.
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {pending.map((sale) => (
        <PendingSale
          key={sale.order_number}
          sale={sale}
          products={products}
          cities={cities.all}
          saving={saving}
          onLink={(payload) => run(() => addManualSale(password, payload))}
        />
      ))}
      {linked.length > 0 && (
        <details className="manual-sales-linked">
          <summary>Привязанные продажи: {formatNumber(linked.length)}</summary>
          {linked.map((sale) => (
            <div className="manual-sale-row" key={sale.order_number}>
              <span>
                № {sale.order_number} · {formatDateDMY(sale.date)} · {sale.product_name} · {sale.warehouse} ·{' '}
                {formatNumber(sale.quantity)} шт · {formatMoney(sale.amount)}
              </span>
              <button
                className="sync-button"
                type="button"
                disabled={saving}
                onClick={() => run(() => removeManualSale(password, sale.order_number))}
              >
                Снять привязку
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
