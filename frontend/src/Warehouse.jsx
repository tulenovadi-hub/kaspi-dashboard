import React, { useEffect, useState } from 'react';
import { fetchWarehouse, fetchWarehouseReconciliations, reconcileWarehouse, fetchInventoryValue, fetchProductImages, uploadProductImage, deleteProductImage } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';
import WarehouseMobile from './WarehouseMobile.jsx';
import { useIsMobile } from './useIsMobile.js';
import { useAppRefresh } from './useAppRefresh.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';
import { useClosing } from './useClosing.js';

// Сжимаем картинку на клиенте перед отправкой — это просто маленькая иконка-превью на
// "Складе", полное разрешение исходного фото не нужно, а без сжатия загрузка была бы
// заметно медленнее (и тяжелее для базы, где картинки хранятся как data URL).
function resizeImageFile(file, maxDim = 320, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Не удалось обработать изображение'));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Не удалось обработать изображение'));
            return;
          }
          resolve(new File([blob], 'product.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Сводка "сколько денег лежит в товаре". Стоит наверху "Склада", потому что здесь же лежат
// все остальные цифры про остатки, а "Итого" под каждым городом остаётся детализацией.
// Важное отличие от этих "Итого": сводка считается по ВСЕМ складам, включая самовыкупные
// (Явленка, Юбилейное, Талдыкорган, Атырау) — на странице их не показывают, но деньги в
// лежащем там товаре точно такие же.
function InventorySummary({ inventory }) {
  const {
    stock_value: stockValue,
    stock_by_warehouse: stockByWarehouse = [],
    in_transit_value: transitValue,
    in_transit_purchase: transitPurchase,
    in_transit_extra: transitExtra,
    in_transit_quantity: transitQuantity,
    deposits_value: depositsValue,
    total,
  } = inventory;

  return (
    <>
      <div className="section-title">Деньги в товаре</div>
      <div className="stats-row-3 inventory-summary">
        <div className="stat-card">
          <div className="stat-label">На складе</div>
          <div className="stat-value">{formatMoney(stockValue)}</div>
          <div className="stat-card-hint">
            {stockByWarehouse.length > 0
              ? stockByWarehouse.map((w) => `${w.warehouse} — ${formatMoney(w.value)}`).join(' · ')
              : 'Остатков нет'}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-label">В пути</div>
          <div className="stat-value">{formatMoney(transitValue)}</div>
          <div className="stat-card-hint">
            {formatNumber(transitQuantity)} шт · закупка {formatMoney(transitPurchase)} + логистика и прочее {formatMoney(transitExtra)}
            {depositsValue > 0 && <> · в том числе депозиты и авансы: {formatMoney(depositsValue)}</>}
          </div>
        </div>

        <div className="stat-card inventory-summary-total">
          <div className="stat-label">Всего в товаре</div>
          <div className="stat-value">{formatMoney(total)}</div>
          <div className="stat-card-hint">
            Всё, что вложено в товар: себестоимость остатка на складах плюс закупка, логистика и прочие расходы
            по партиям, которые ещё едут.
          </div>
        </div>
      </div>
    </>
  );
}

function createEmptyFilters() {
  return {
    productName: '',
  };
}

function formatReconciliationTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function signedQuantity(value) {
  const number = Number(value) || 0;
  if (number > 0) return `+${formatNumber(number)}`;
  if (number < 0) return `−${formatNumber(Math.abs(number))}`;
  return '0';
}

function ReconciliationHistory({ reconciliations }) {
  return (
    <section className="warehouse-history">
      <div className="section-title">История сверок остатков</div>
      {reconciliations.length === 0 ? (
        <div className="card"><div className="empty-state">Контрольных сверок пока не было</div></div>
      ) : reconciliations.map((reconciliation, index) => (
        <details className="card warehouse-history-card" key={reconciliation.id} open={index === 0}>
          <summary className="warehouse-history-summary">
            <span>
              <b>{reconciliation.source}</b>
              <small>снимок на {formatReconciliationTime(reconciliation.source_captured_at)}</small>
            </span>
            <span className="warehouse-history-meta">
              внесено {formatReconciliationTime(reconciliation.created_at)}
              {reconciliation.created_by ? ` · ${reconciliation.created_by}` : ''}
            </span>
          </summary>
          {reconciliation.note && <div className="warehouse-history-note">{reconciliation.note}</div>}
          <div className="table-scroll">
            <table className="product-table warehouse-history-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Склад</th>
                  <th className="num">Было в расчёте</th>
                  <th className="num">Факт партнёра</th>
                  <th className="num">Изменение</th>
                </tr>
              </thead>
              <tbody>
                {reconciliation.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name}</td>
                    <td>{item.warehouse}</td>
                    <td className="num">{formatNumber(item.quantity_before)}</td>
                    <td className="num">{formatNumber(item.target_quantity)}</td>
                    <td className={`num warehouse-history-change${item.display_change > 0 ? ' is-up' : item.display_change < 0 ? ' is-down' : ''}`}>
                      {signedQuantity(item.display_change)}
                    </td>
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

function localDateTimeValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function newRow() {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    product_id: '',
    warehouse: 'Алматы',
    target_quantity: '',
  };
}

function ReconciliationModal({ password, products, onClose, onSaved }) {
  const [source, setSource] = useState('Wonder Fulfillment');
  const [capturedAt, setCapturedAt] = useState(localDateTimeValue);
  const [note, setNote] = useState('');
  const [rows, setRows] = useState(() => [newRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey] = useState(() => (
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `warehouse-${Date.now()}-${Math.random().toString(36).slice(2)}`
  ));

  useBodyScrollLock();
  const { closing, close } = useClosing(onClose);

  const productOptions = Array.from(
    products.reduce((map, product) => {
      if (!map.has(product.product_id)) map.set(product.product_id, product.product_name);
      return map;
    }, new Map()),
    ([product_id, product_name]) => ({ product_id, product_name })
  ).sort((a, b) => a.product_name.localeCompare(b.product_name, 'ru'));

  function updateRow(key, patch) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function currentFor(row) {
    return products.find((product) => product.product_id === row.product_id && product.warehouse === row.warehouse);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const prepared = rows.filter((row) => row.product_id || row.target_quantity !== '');
    if (prepared.length === 0) {
      setError('Добавьте хотя бы один товар');
      return;
    }

    const seen = new Set();
    const items = [];
    for (const row of prepared) {
      const product = productOptions.find((option) => option.product_id === row.product_id);
      const target = Number(row.target_quantity);
      if (!product || !Number.isInteger(target) || target < 0) {
        setError('У каждого товара выберите склад и укажите целый фактический остаток');
        return;
      }
      const key = `${row.product_id}::${row.warehouse}`;
      if (seen.has(key)) {
        setError(`Товар «${product.product_name}» на складе ${row.warehouse} добавлен дважды`);
        return;
      }
      seen.add(key);
      items.push({
        product_id: product.product_id,
        product_name: product.product_name,
        warehouse: row.warehouse,
        target_quantity: target,
      });
    }

    const capturedDate = new Date(capturedAt);
    if (Number.isNaN(capturedDate.getTime())) {
      setError('Укажите время сверки');
      return;
    }

    setSaving(true);
    try {
      await reconcileWarehouse(password, {
        idempotency_key: idempotencyKey,
        source: source.trim() || 'Ручная сверка',
        source_captured_at: capturedDate.toISOString(),
        note: note.trim() || null,
        items,
      });
      await onSaved();
    } catch (err) {
      setError(err.message || 'Не удалось сохранить сверку');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`modal-overlay${closing ? ' is-closing' : ''}`} onClick={saving ? undefined : close}>
      <div className="modal-box modal-box-wide warehouse-reconcile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Новая сверка остатков</h2>
          <button className="modal-close" type="button" onClick={close} disabled={saving}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="warehouse-reconcile-head">
            <label>
              <span>Источник</span>
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Например, Wonder Fulfillment" required />
            </label>
            <label>
              <span>Время сверки</span>
              <input type="datetime-local" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} required />
            </label>
          </div>

          <div className="warehouse-reconcile-label">Товары</div>
          <div className="warehouse-reconcile-rows">
            {rows.map((row, index) => {
              const current = currentFor(row);
              const currentQty = current ? Number(current.remaining) : 0;
              const target = row.target_quantity === '' ? null : Number(row.target_quantity);
              const difference = target !== null && Number.isFinite(target) ? target - currentQty : null;
              return (
                <div className="warehouse-reconcile-row" key={row.key}>
                  <label className="warehouse-reconcile-product">
                    <span>Товар</span>
                    <select value={row.product_id} onChange={(e) => updateRow(row.key, { product_id: e.target.value })} required>
                      <option value="">Выберите товар</option>
                      {productOptions.map((product) => (
                        <option value={product.product_id} key={product.product_id}>{product.product_name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Склад</span>
                    <select value={row.warehouse} onChange={(e) => updateRow(row.key, { warehouse: e.target.value })}>
                      <option value="Алматы">Алматы</option>
                      <option value="Астана">Астана</option>
                    </select>
                  </label>
                  <label>
                    <span>Фактически</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      value={row.target_quantity}
                      onChange={(e) => updateRow(row.key, { target_quantity: e.target.value })}
                      required
                    />
                  </label>
                  <div className="warehouse-reconcile-preview">
                    <span>Изменение</span>
                    <b className={difference > 0 ? 'is-up' : difference < 0 ? 'is-down' : ''}>
                      {row.product_id && difference !== null
                        ? `${formatNumber(currentQty)} → ${formatNumber(target)} (${signedQuantity(difference)})`
                        : '—'}
                    </b>
                  </div>
                  <button
                    className="warehouse-reconcile-remove"
                    type="button"
                    aria-label={`Удалить строку ${index + 1}`}
                    onClick={() => setRows((currentRows) => currentRows.filter((item) => item.key !== row.key))}
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
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Причина сверки или примечание" rows="3" />
          </label>

          <div className="warehouse-reconcile-hint">
            Поставки и заказы не изменятся. В историю попадёт одна общая сверка со всеми строками.
          </div>

          <div className="warehouse-reconcile-actions">
            <button className="secondary-button" type="button" onClick={close} disabled={saving}>Отмена</button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? 'Сохраняем…' : 'Сохранить сверку'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Warehouse({ password, role, active = true, isOnline = true }) {
  const [products, setProducts] = useState([]);
  const [images, setImages] = useState({});
  const [cutoffDate, setCutoffDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [filters, setFilters] = useState(createEmptyFilters);
  const [imageBusy, setImageBusy] = useState(null); // product_id, который сейчас загружается/удаляется
  const [inventory, setInventory] = useState(null); // сводка "деньги в товаре" — считается отдельным роутом
  const [reconciliations, setReconciliations] = useState([]);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);

  // На телефоне вместо широкой таблицы рисуются карточки товаров (WarehouseMobile.jsx):
  // 799px таблицы в 313px экрана не помещаются никаким способом.
  const isMobile = useIsMobile();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [mobileCity, setMobileCity] = useState('');

  function loadAll() {
    setLoading(true);
    setError('');
    // Сводка по деньгам грузится параллельно и независимо: она считается по ВСЕМ складам,
    // включая самовыкупные, которых нет в таблицах ниже.
    fetchInventoryValue(password)
      .then(setInventory)
      .catch(() => {}); // блок со сводкой — не повод ронять всю страницу
    fetchWarehouseReconciliations(password)
      .then((res) => setReconciliations(res.reconciliations || []))
      .catch(() => {}); // история не должна мешать открыть сам склад

    fetchWarehouse(password)
      .then((res) => {
        setProducts(res.products);
        setCutoffDate(res.cutoff_date || '');

        const uniqueIds = Array.from(new Set(res.products.map((p) => p.product_id)));
        if (uniqueIds.length > 0) {
          fetchProductImages(password, uniqueIds)
            .then((imgRes) => setImages(imgRes.images || {}))
            .catch(() => {}); // картинки — это украшение, не критично, если не подтянулись
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        setLoading(false);
        setHasData(true);
      });
  }

  // Свайп вниз по странице просит перезапросить данные, не размонтируя её: содержимое
  // остаётся на месте и просто тускнеет, как в офлайне (см. useAppRefresh.js).
  const refreshTick = useAppRefresh(active);

  useEffect(() => {
    if (active) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, password, refreshTick]);

  function toggleExpand(key) {
    setExpanded((prev) => (prev === key ? null : key));
  }

  async function handleImageChange(productId, e) {
    const file = e.target.files[0];
    e.target.value = ''; // чтобы можно было выбрать тот же файл ещё раз
    if (!file) return;

    setImageBusy(productId);
    setError('');
    try {
      const resized = await resizeImageFile(file);
      const res = await uploadProductImage(password, productId, resized);
      setImages((prev) => ({ ...prev, [productId]: res.image_url }));
    } catch (err) {
      setError(err.message || 'Не удалось загрузить картинку');
    } finally {
      setImageBusy(null);
    }
  }

  async function handleImageRemove(productId, e) {
    e.preventDefault();
    e.stopPropagation();
    setImageBusy(productId);
    setError('');
    try {
      await deleteProductImage(password, productId);
      setImages((prev) => {
        const next = { ...prev };
        delete next[productId];
        return next;
      });
    } catch (err) {
      setError(err.message || 'Не удалось удалить картинку');
    } finally {
      setImageBusy(null);
    }
  }

  const filtered = products.filter((p) => {
    if (filters.productName && !p.product_name.toLowerCase().includes(filters.productName.toLowerCase())) return false;
    return true;
  });

  const groupedByWarehouse = filtered.reduce((acc, p) => {
    const city = p.warehouse || 'Без склада';
    if (!acc[city]) acc[city] = [];
    acc[city].push(p);
    return acc;
  }, {});
  const cities = Object.keys(groupedByWarehouse).sort((a, b) => a.localeCompare(b, 'ru'));

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Склад <span>остатков</span></h1>
        {role === 'admin' && (
          <button className="primary-button warehouse-reconcile-open" type="button" onClick={() => setReconciliationOpen(true)}>
            Сверить остатки
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {inventory && !isMobile && <InventorySummary inventory={inventory} />}

      {!loading && products.length > 0 && (
        <div className="batches-toolbar">
          <input
            className="toolbar-input"
            type="text"
            placeholder="Поиск по товару..."
            value={filters.productName}
            onChange={(e) => setFilters((f) => ({ ...f, productName: e.target.value }))}
          />
        </div>
      )}

      {loading && !hasData ? (
        <div className="card">
          <div className="empty-state">Загрузка...</div>
        </div>
      ) : (
      <div style={{ opacity: loading || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
      {products.length === 0 ? (
        <div className="card">
          <div className="empty-state">Пока нет данных — сначала добавьте партии на странице «Поставки»</div>
        </div>
      ) : cities.length === 0 ? (
        <div className="card">
          <div className="empty-state">Ничего не найдено по заданным фильтрам</div>
        </div>
      ) : isMobile ? (
        <WarehouseMobile
          products={filtered}
          cities={cities}
          images={images}
          imageBusy={imageBusy}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onImageChange={handleImageChange}
          onImageRemove={handleImageRemove}
          inventory={inventory}
          summaryOpen={summaryOpen}
          onToggleSummary={() => setSummaryOpen((v) => !v)}
          activeCity={mobileCity || cities[0]}
          onSelectCity={setMobileCity}
        />
      ) : (
        cities.map((city) => {
          const cityProducts = groupedByWarehouse[city];
          const cityTotal = cityProducts.reduce((sum, p) => sum + Number(p.remaining_value || 0), 0);
          return (
            <React.Fragment key={city}>
              <div className="section-title">{city}</div>
              <div className="card">
                <div className="table-scroll">
                  <table className="product-table">
                    <thead>
                      <tr>
                        <th>Товар</th>
                        <th className="num">Остаток</th>
                        <th className="num">Поставлено</th>
                        <th className="num">Продано</th>
                        <th className="num">В обработке</th>
                        <th className="num">Возвраты покупателей</th>
                        <th className="num">Возвращается</th>
                        <th className="num">Себестоимость (FIFO)</th>
                        <th className="num">Стоимость остатка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cityProducts.map((p) => {
                        const rowKey = `${p.product_id}::${p.warehouse}`;
                        const busy = imageBusy === p.product_id;
                        return (
                          <React.Fragment key={rowKey}>
                            <tr onClick={() => toggleExpand(rowKey)}>
                              <td>
                                <div className="warehouse-product-cell">
                                  <label
                                    className="warehouse-thumb-wrap"
                                    onClick={(e) => e.stopPropagation()}
                                    title="Нажмите, чтобы загрузить свою картинку"
                                  >
                                    {images[p.product_id] ? (
                                      <img className="warehouse-thumb" src={images[p.product_id]} alt={p.product_name} />
                                    ) : (
                                      <div className="warehouse-thumb warehouse-thumb-empty" />
                                    )}
                                    <div className="warehouse-thumb-overlay">
                                      {busy ? '…' : '✎'}
                                    </div>
                                    {images[p.product_id] && !busy && (
                                      <button
                                        type="button"
                                        className="warehouse-thumb-remove"
                                        title="Удалить картинку"
                                        onClick={(e) => handleImageRemove(p.product_id, e)}
                                      >
                                        ×
                                      </button>
                                    )}
                                    <input
                                      type="file"
                                      accept="image/*"
                                      className="warehouse-thumb-input"
                                      disabled={busy}
                                      onChange={(e) => handleImageChange(p.product_id, e)}
                                    />
                                  </label>
                                  <div>
                                    {p.product_name}
                                    {p.oversold_qty > 0 && (
                                      <span className="warehouse-warning" title="Продано больше, чем известно поставок на этом складе — добавьте недостающие партии">
                                        ⚠ продано на {formatNumber(p.oversold_qty)} шт больше поставок
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="num">{formatNumber(p.remaining)}</td>
                              <td className="num">{formatNumber(p.total_supplied)}</td>
                              <td className="num">{formatNumber(p.total_sold)}</td>
                              <td className="num">{formatNumber(p.in_progress)}</td>
                              <td className="num" title="Оформленные покупательские возвраты остаются списанными и не возвращаются в доступный остаток автоматически">
                                {p.customer_returns > 0 ? formatNumber(p.customer_returns) : '—'}
                              </td>
                              <td className="num" title={p.returning > 0 ? 'Отменено при доставке и едет обратно на склад. Из остатка вычтено — вернётся в остаток, когда трекинг Kaspi подтвердит приём на складе' : undefined}>
                                {p.returning > 0 ? formatNumber(p.returning) : '—'}
                              </td>
                              <td className="num">{p.current_cost_price !== null ? formatMoney(p.current_cost_price) : '—'}</td>
                              <td className="num">{formatMoney(p.remaining_value)}</td>
                            </tr>
                            {expanded === rowKey && p.batches.length > 0 && (
                              <tr>
                                <td colSpan={9} className="warehouse-batches-cell">
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
                    <tfoot>
                      <tr className="warehouse-total-row">
                        <td colSpan={8} className="num">Итого:</td>
                        <td className="num">{formatMoney(cityTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </React.Fragment>
          );
        })
      )}
      </div>
      )}

      <ReconciliationHistory reconciliations={reconciliations} />

      <div className="report-note">
        Остаток считается по методу FIFO отдельно для каждого склада, и учитывает только заказы {cutoffDate ? `с ${cutoffDate} и позже` : 'после даты отсечки'} —
        так партии, введённые с учётом остатков на эту дату, не задваиваются со старыми продажами. «Продано» — завершённые заказы (COMPLETED), «В обработке» —
        заказы, которые уже приняты в работу, но ещё не завершены (актуально для рассрочки). «Возвраты покупателей» остаются списанными и не добавляются
        в доступный остаток автоматически. Заказ, который хотя бы раз был выдан покупателю, остаётся списанным при любом следующем статусе.
        Обратно можно добавить только отменённый при доставке заказ кнопкой «+ в остаток». Нажмите на строку товара, чтобы увидеть разбивку по партиям.
        Наведите на картинку товара, чтобы загрузить свою (или удалить уже загруженную) — картинки автоматически не подтягиваются, только вручную.
      </div>

      {reconciliationOpen && (
        <ReconciliationModal
          password={password}
          products={products}
          onClose={() => setReconciliationOpen(false)}
          onSaved={async () => {
            setReconciliationOpen(false);
            loadAll();
          }}
        />
      )}
    </div>
  );
}
