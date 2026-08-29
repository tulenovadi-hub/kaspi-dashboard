import React, { useEffect, useMemo, useState } from 'react';
import { fetchAbcXyz } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';

const EMPTY = { products: [], matrix: [], totals: null, weeks: 0, thresholds: null, estimatedRevenueShare: 0 };

const WAREHOUSE_MODES = [
  { key: 'main', label: 'Основной магазин' },
  { key: 'selfbuy', label: 'Самовыкупы' },
];

const BASIS = [
  { key: 'profit', label: 'По прибыли' },
  { key: 'revenue', label: 'По выручке' },
];

const ABC_ROWS = ['A', 'B', 'C'];
const XYZ_COLS = ['X', 'Y', 'Z'];

// Что делать с товаром из каждой клетки. Это и есть весь смысл матрицы: ABC говорит,
// сколько товар приносит, XYZ — можно ли на него рассчитывать.
const ADVICE = {
  AX: 'Кормильцы со стабильным спросом. Не допускать нулевых остатков — их отсутствие бьёт по прибыли сильнее всего.',
  AY: 'Приносят много, спрос гуляет. Держать запас с поправкой на колебания.',
  AZ: 'Много прибыли при рваном спросе — самый рискованный угол. Закупать мелкими партиями и чаще.',
  BX: 'Середняки со стабильным спросом. Обычный режим пополнения.',
  BY: 'Середняки с колебаниями. Следить за остатком, но без фанатизма.',
  BZ: 'Середняки с непредсказуемым спросом. Не замораживать в них деньги.',
  CX: 'Мало приносят, но продаются стабильно. Хороший кандидат на автозаказ маленькими партиями.',
  CY: 'Мало приносят и нестабильны. Пересмотреть цену или закупочную партию.',
  CZ: 'Мало приносят, спрос случайный. Первые кандидаты на вымывание из матрицы.',
};

function Chips({ options, value, onChange }) {
  return (
    <div className="geo-chips">
      {options.map((o) => (
        <button key={o.key} className={`period-chip ${value === o.key ? 'active' : ''}`} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Badge({ value }) {
  if (!value) return <span className="abc-badge abc-badge-none">—</span>;
  return <span className={`abc-badge abc-badge-${value}`}>{value}</span>;
}

export default function AbcXyz({ password, active = true, isOnline = true }) {
  // Период по умолчанию — 90 дней: на коротком отрезке стабильность спроса считать не по чему.
  const [from, setFrom] = useState(() => toISODate(daysAgo(89)));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('90days');
  const [warehouseMode, setWarehouseMode] = useState('main');
  const [basis, setBasis] = useState('profit');
  const [selectedCell, setSelectedCell] = useState(null); // 'AX' | 'C-' и т.п.
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    setError('');
    fetchAbcXyz(password, from, to, warehouseMode, basis)
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [active, password, from, to, warehouseMode, basis]);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  const cellByKey = useMemo(() => {
    const map = {};
    for (const cell of data.matrix) map[`${cell.abc}${cell.xyz || '-'}`] = cell;
    return map;
  }, [data.matrix]);

  const maxCellProfit = useMemo(
    () => Math.max(1, ...data.matrix.map((c) => Math.abs(c.profit))),
    [data.matrix]
  );

  const hasNoDataColumn = data.matrix.some((c) => c.xyz === null);

  const visibleProducts = useMemo(() => {
    if (!selectedCell) return data.products;
    const abc = selectedCell[0];
    const xyz = selectedCell[1] === '-' ? null : selectedCell[1];
    return data.products.filter((p) => p.abc === abc && p.xyz === xyz);
  }, [data.products, selectedCell]);

  const totals = data.totals;
  const t = data.thresholds;

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">ABC/XYZ <span>что закупать в первую очередь</span></h1>
      </div>

      <PeriodSelector from={from} to={to} activePreset={presetKey} onChange={handlePeriodChange} />
      <div className="abc-toolbar">
        <Chips options={WAREHOUSE_MODES} value={warehouseMode} onChange={setWarehouseMode} />
        <Chips options={BASIS} value={basis} onChange={setBasis} />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {data.estimatedRevenueShare > 0.2 && (
        <div className="geo-notice">
          По {Math.round(data.estimatedRevenueShare * 100)}% выручки за период отчёт Kaspi Pay ещё
          не загружен — прибыль по этим продажам оценена по среднему проценту того же товара,
          а не посчитана точно. Чем свежее период, тем больше такой оценки.
        </div>
      )}

      <div
        style={{
          opacity: loading || !isOnline ? 0.55 : 1,
          transition: 'opacity 0.25s ease',
          pointerEvents: loading ? 'none' : 'auto',
        }}
      >
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-label">Товаров в анализе</div>
            <div className="stat-value">{totals ? formatNumber(totals.products) : '—'}</div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {data.weeks ? `${data.weeks} недель в периоде` : ''}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Группа A</div>
            <div className="stat-value">
              {totals ? formatNumber(totals.aProducts) : '—'}
              <span className="geo-stat-hint"> {totals && totals.aProducts === 1 ? 'товар' : 'товаров'}</span>
            </div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {totals ? `дают ${totals.aShare.toFixed(1)}% ${basis === 'profit' ? 'прибыли' : 'выручки'}` : ''}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Убыточные товары</div>
            <div className="stat-value" style={{ color: totals && totals.lossProducts > 0 ? 'var(--accent-down)' : undefined }}>
              {totals ? formatNumber(totals.lossProducts) : '—'}
            </div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {totals && totals.lossProducts > 0 ? `съедают ${formatMoney(Math.abs(totals.lossAmount))}` : 'таких нет'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Без оценки стабильности</div>
            <div className="stat-value">{totals ? formatNumber(totals.noDataProducts) : '—'}</div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {t ? `мало данных: нужно от ${t.minUnits} шт и ${t.minWeeks} недель` : ''}
            </div>
          </div>
        </div>

        <div className="section-title">Матрица</div>
        <div className="card">
          <div className="table-scroll">
            <table className="abc-matrix">
              <thead>
                <tr>
                  <th />
                  <th>X <span>стабильный спрос</span></th>
                  <th>Y <span>спрос колеблется</span></th>
                  <th>Z <span>спрос рваный</span></th>
                  {hasNoDataColumn && <th>— <span>мало данных</span></th>}
                </tr>
              </thead>
              <tbody>
                {ABC_ROWS.map((abc) => (
                  <tr key={abc}>
                    <th className="abc-matrix-row-head">
                      {abc}
                      <span>
                        {abc === 'A' ? `первые ${t ? t.abcA : 80}%` : abc === 'B' ? `следующие ${t ? t.abcB - t.abcA : 15}%` : 'хвост'}
                      </span>
                    </th>
                    {[...XYZ_COLS, ...(hasNoDataColumn ? ['-'] : [])].map((xyz) => {
                      const key = `${abc}${xyz}`;
                      const cell = cellByKey[key];
                      const isSelected = selectedCell === key;
                      const intensity = cell ? Math.abs(cell.profit) / maxCellProfit : 0;
                      return (
                        <td
                          key={xyz}
                          className={`abc-cell${cell ? ' has-products' : ''}${isSelected ? ' selected' : ''}${cell && cell.profit < 0 ? ' loss' : ''}`}
                          style={cell ? { background: `rgba(110, 139, 255, ${(0.08 + 0.5 * intensity).toFixed(3)})` } : undefined}
                          onClick={() => cell && setSelectedCell(isSelected ? null : key)}
                          title={ADVICE[key] || ''}
                        >
                          {cell ? (
                            <>
                              <div className="abc-cell-count">{cell.products}</div>
                              <div className="abc-cell-sub">{formatMoney(cell.profit)}</div>
                            </>
                          ) : (
                            <div className="abc-cell-empty">—</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="abc-legend">
            {selectedCell && ADVICE[selectedCell] ? (
              <p><b>{selectedCell}.</b> {ADVICE[selectedCell]}</p>
            ) : (
              <p>
                По строкам — вклад в {basis === 'profit' ? 'прибыль' : 'выручку'}:
                <b> A</b> — товары, дающие первые {t ? t.abcA : 80}%,
                <b> B</b> — следующие {t ? t.abcB - t.abcA : 15}%,
                <b> C</b> — весь хвост. По столбцам — насколько ровно товар продаётся по неделям:
                <b> X</b> — разброс до {t ? Math.round(t.xyzX * 100) : 25}%,
                <b> Y</b> — до {t ? Math.round(t.xyzY * 100) : 50}%, <b>Z</b> — больше.
                Нажмите на клетку, чтобы отфильтровать таблицу и увидеть, что с этими товарами делать.
              </p>
            )}
          </div>
        </div>

        <div className="section-title">
          Товары
          {selectedCell && (
            <button className="abc-reset" onClick={() => setSelectedCell(null)}>
              показаны только {selectedCell.replace('-', ' без класса')} — показать все
            </button>
          )}
        </div>
        <div className="card">
          {visibleProducts.length === 0 ? (
            <div className="empty-state">За период нет продаж</div>
          ) : (
            <div className="table-scroll">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>Товар</th>
                    <th className="num">ABC</th>
                    <th className="num">XYZ</th>
                    <th className="num">Продано</th>
                    <th className="num">Выручка</th>
                    <th className="num">Прибыль</th>
                    <th className="num">Маржа</th>
                    <th className="num">Доля</th>
                    <th className="num">Накопл.</th>
                    <th className="num">Недель с продажами</th>
                    <th className="num">Разброс</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.map((p) => (
                    <tr key={p.productId || p.name}>
                      <td>{p.name}</td>
                      <td className="num"><Badge value={p.abc} /></td>
                      <td className="num"><Badge value={p.xyz} /></td>
                      <td className="num">{formatNumber(p.quantity)}</td>
                      <td className="num">{formatMoney(p.revenue)}</td>
                      <td className={`num${p.profit < 0 ? ' report-cell-red' : ''}`}>{formatMoney(p.profit)}</td>
                      <td className="num">{p.margin.toFixed(1)}%</td>
                      <td className="num">{p.share.toFixed(1)}%</td>
                      <td className="num">{p.cumulativeShare.toFixed(1)}%</td>
                      <td className="num">{p.weeksWithSales} из {p.weeksTotal}</td>
                      <td className="num">{p.cv === null ? '—' : `${Math.round(p.cv * 100)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
