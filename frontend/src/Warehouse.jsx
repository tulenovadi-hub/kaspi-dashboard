import React, { useEffect, useMemo, useState } from 'react';
import { fetchWarehouse, fetchProductImages, uploadProductImage, deleteProductImage } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';
import FilterHeader from './FilterHeader.jsx';

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

function createEmptyFilters() {
  return {
    productName: '',
    warehouseExcluded: new Set(),
  };
}

export default function Warehouse({ password }) {
  const [products, setProducts] = useState([]);
  const [images, setImages] = useState({});
  const [cutoffDate, setCutoffDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [filters, setFilters] = useState(createEmptyFilters);
  const [imageBusy, setImageBusy] = useState(null); // product_id, который сейчас загружается/удаляется

  useEffect(() => {
    setLoading(true);
    setError('');
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
      .finally(() => setLoading(false));
  }, [password]);

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

  const warehouses = useMemo(
    () => Array.from(new Set(products.map((p) => p.warehouse).filter(Boolean))).sort(),
    [products]
  );

  const toggleWarehouse = (w) => {
    setFilters((f) => {
      const next = new Set(f.warehouseExcluded);
      if (next.has(w)) next.delete(w);
      else next.add(w);
      return { ...f, warehouseExcluded: next };
    });
  };

  const filtered = products.filter((p) => {
    if (filters.warehouseExcluded.has(p.warehouse)) return false;
    if (filters.productName && !p.product_name.toLowerCase().includes(filters.productName.toLowerCase())) return false;
    return true;
  });
  const totalRemainingValue = filtered.reduce((sum, p) => sum + Number(p.remaining_value || 0), 0);

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Склад <span>остатков</span></h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : products.length === 0 ? (
          <div className="empty-state">Пока нет данных — сначала добавьте партии на странице «Поставки»</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>
                    <FilterHeader label="Товар" active={!!filters.productName}>
                      <input
                        className="filter-popover-input"
                        type="text"
                        placeholder="Поиск..."
                        value={filters.productName}
                        onChange={(e) => setFilters((f) => ({ ...f, productName: e.target.value }))}
                        autoFocus
                      />
                      <button className="filter-popover-clear" onClick={() => setFilters((f) => ({ ...f, productName: '' }))}>Очистить</button>
                    </FilterHeader>
                  </th>
                  <th>
                    <FilterHeader label="Склад" active={filters.warehouseExcluded.size > 0}>
                      <div className="filter-popover-list">
                        {warehouses.map((w) => (
                          <label key={w} className="filter-popover-checkbox">
                            <input
                              type="checkbox"
                              checked={!filters.warehouseExcluded.has(w)}
                              onChange={() => toggleWarehouse(w)}
                            />
                            <span>{w}</span>
                          </label>
                        ))}
                      </div>
                      <div className="filter-popover-actions">
                        <button onClick={() => setFilters((f) => ({ ...f, warehouseExcluded: new Set() }))}>Все</button>
                        <button onClick={() => setFilters((f) => ({ ...f, warehouseExcluded: new Set(warehouses) }))}>Ничего</button>
                      </div>
                    </FilterHeader>
                  </th>
                  <th className="num">Поставлено</th>
                  <th className="num">Продано</th>
                  <th className="num">В обработке</th>
                  <th className="num">Остаток</th>
                  <th className="num">Себестоимость (FIFO)</th>
                  <th className="num">Стоимость остатка</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="empty-state">Ничего не найдено по заданным фильтрам</td>
                  </tr>
                ) : (
                  filtered.map((p) => {
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
                          <td>{p.warehouse}</td>
                          <td className="num">{formatNumber(p.total_supplied)}</td>
                          <td className="num">{formatNumber(p.total_sold)}</td>
                          <td className="num">{formatNumber(p.in_progress)}</td>
                          <td className="num">{formatNumber(p.remaining)}</td>
                          <td className="num">{p.current_cost_price !== null ? formatMoney(p.current_cost_price) : '—'}</td>
                          <td className="num">{formatMoney(p.remaining_value)}</td>
                        </tr>
                        {expanded === rowKey && p.batches.length > 0 && (
                          <tr>
                            <td colSpan={8} className="warehouse-batches-cell">
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
                  })
                )}
              </tbody>
              <tfoot>
                <tr className="warehouse-total-row">
                  <td colSpan={7} className="num">Итого:</td>
                  <td className="num">{formatMoney(totalRemainingValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="report-note">
        Остаток считается по методу FIFO отдельно для каждого склада, и учитывает только заказы {cutoffDate ? `с ${cutoffDate} и позже` : 'после даты отсечки'} —
        так партии, введённые с учётом остатков на эту дату, не задваиваются со старыми продажами. «Продано» — завершённые заказы (COMPLETED), «В обработке» —
        заказы, которые уже приняты в работу, но ещё не завершены (актуально для рассрочки). Нажмите на строку товара, чтобы увидеть разбивку по партиям.
        Наведите на картинку товара, чтобы загрузить свою (или удалить уже загруженную) — картинки автоматически не подтягиваются, только вручную.
      </div>
    </div>
  );
}
