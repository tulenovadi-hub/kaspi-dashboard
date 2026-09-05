import React, { useEffect, useState } from 'react';
import { fetchWarehouse, fetchInventoryValue, fetchProductImages, uploadProductImage, deleteProductImage } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';

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

export default function Warehouse({ password, active = true, isOnline = true }) {
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

  function loadAll() {
    setLoading(true);
    setError('');
    // Сводка по деньгам грузится параллельно и независимо: она считается по ВСЕМ складам,
    // включая самовыкупные, которых нет в таблицах ниже.
    fetchInventoryValue(password)
      .then(setInventory)
      .catch(() => {}); // блок со сводкой — не повод ронять всю страницу

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

  useEffect(() => {
    if (active) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, password]);

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
      </div>

      {error && <div className="error-banner">{error}</div>}

      {inventory && <InventorySummary inventory={inventory} />}

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
                    <tfoot>
                      <tr className="warehouse-total-row">
                        <td colSpan={6} className="num">Итого:</td>
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

      <div className="report-note">
        Остаток считается по методу FIFO отдельно для каждого склада, и учитывает только заказы {cutoffDate ? `с ${cutoffDate} и позже` : 'после даты отсечки'} —
        так партии, введённые с учётом остатков на эту дату, не задваиваются со старыми продажами. «Продано» — завершённые заказы (COMPLETED), «В обработке» —
        заказы, которые уже приняты в работу, но ещё не завершены (актуально для рассрочки). Нажмите на строку товара, чтобы увидеть разбивку по партиям.
        Наведите на картинку товара, чтобы загрузить свою (или удалить уже загруженную) — картинки автоматически не подтягиваются, только вручную.
      </div>
    </div>
  );
}
