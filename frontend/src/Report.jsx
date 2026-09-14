import React, { useEffect, useRef, useState } from 'react';
import { uploadKaspiPayReport, fetchMonthlyReport, fetchMonthProductBreakdown } from './api.js';
import { formatMoney, formatMonthLabel, formatPercent } from './dateUtils.js';
import ReportMobile from './ReportMobile.jsx';
import { useIsMobile } from './useIsMobile.js';
import {
  GENERAL_COLUMNS, MAIN_COLUMNS, PRODUCT_COLUMNS, SELF_BUY_COLUMNS,
  GREEN_KEYS, RED_KEYS, YELLOW_KEYS, PERCENT_OF_NET_REVENUE_KEYS, PERCENT_VALUE_KEYS,
} from './reportColumns.js';
import { useAppRefresh } from './useAppRefresh.js';

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixColor(hexFrom, hexTo, t) {
  const a = hexToRgb(hexFrom);
  const b = hexToRgb(hexTo);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

// Градиент для Маржи/ROI: 0% и ниже — тёмно-красный, max% и выше — зелёный, между ними — линейно
function gradientColor(value, max) {
  if (value === null || value === undefined || Number.isNaN(value)) return undefined;
  const t = Math.max(0, Math.min(1, value / max));
  return mixColor('#7f1d1d', '#3ddc97', t);
}

// columns — массив { key, label }. key === 'month'/'product_name' форматируется отдельно (название
// месяца/товара), остальные — через formatMoney, кроме margin/roi (через formatPercent).
// Значение undefined (например, "Прочие расходы" в разбивке по товарам, где эта колонка
// принципиально не считается) всегда рисуется прочерком, а не "0 ₸".
// showExpensePercentages — под расходом показывает его долю от чистой выручки после возвратов:
// это та же база, от которой считается маржа. Справочная себестоимость возвратов сюда не входит.
function renderRowCells(columns, row, colorize, showExpensePercentages) {
  return columns.map((col) => {
    if (col.key === 'month') return <td key={col.key}>{formatMonthLabel(row.month)}</td>;
    if (col.key === 'product_name') return <td key={col.key}>{row.product_name}</td>;

    const value = row[col.key];

    if (PERCENT_VALUE_KEYS.has(col.key)) {
      const style = colorize ? { color: gradientColor(value, col.key === 'margin' ? 30 : 50) } : undefined;
      return <td key={col.key} className="num" style={style}>{value === undefined ? '—' : formatPercent(value)}</td>;
    }

    let cellClassName = 'num';
    if (colorize && GREEN_KEYS.has(col.key)) cellClassName += ' report-cell-green';
    else if (colorize && RED_KEYS.has(col.key)) cellClassName += ' report-cell-red';
    else if (colorize && YELLOW_KEYS.has(col.key)) cellClassName += ' report-cell-yellow';

    const marginBase = row.net_revenue !== undefined
      ? Number(row.net_revenue)
      : Number(row.revenue || 0) - Number(row.returns || 0);
    const showPct = showExpensePercentages
      && PERCENT_OF_NET_REVENUE_KEYS.has(col.key)
      && value !== undefined
      && marginBase;
    if (showPct) {
      return (
        <td key={col.key} className={cellClassName}>
          {formatMoney(value)}
          <div className="report-percent-sub">{(value / marginBase * 100).toFixed(1)}%</div>
        </td>
      );
    }

    return <td key={col.key} className={cellClassName}>{value === undefined ? '—' : formatMoney(value)}</td>;
  });
}

function sumProductRows(products) {
  const moneyKeys = PRODUCT_COLUMNS
    .map((col) => col.key)
    .filter((key) => !['product_name', 'margin', 'roi'].includes(key));
  const total = { product_name: 'Итого' };
  for (const key of moneyKeys) {
    total[key] = products.reduce((sum, product) => sum + Number(product[key] || 0), 0);
  }
  const netRevenue = total.revenue - total.returns;
  total.net_revenue = netRevenue;
  const investments = total.cost_of_goods
    + total.marketing_ads
    + total.marketing_bonuses
    + total.marketing_reviews
    + total.packaging
    + total.other_expenses;
  total.margin = netRevenue !== 0 ? (total.net_profit / netRevenue) * 100 : null;
  total.roi = investments !== 0 ? (total.net_profit / investments) * 100 : null;
  return total;
}

// colorize — включает раскраску выручки/расходов и градиент маржи/ROI (только для "Основного отчёта").
// showExpensePercentages — под суммой показывает долю от чистой выручки после возвратов:
// в строке месяца от чистой выручки месяца, в разбивке — от чистой выручки товара.
// expandable — если true, клик по строке месяца разворачивает под ней разбивку по товарам
// (данные подгружаются лениво через onToggleMonth и кэшируются в productBreakdowns на уровне Report).
// scope — какая из двух разворачиваемых таблиц ('all' — все склады, 'main' — Алматы + Астана).
// Кэши разбивок общие на весь Report, поэтому ключ в них составной: "scope:month". Без этого
// таблицы делили бы один кэш и в верхней показывались бы товары нижней.
// subtitle — пояснение под заголовком: у двух похожих таблиц должно быть сразу видно, чем они
// отличаются, иначе одинаковые колонки с разными числами читаются как ошибка.
function MonthlyTable({
  title, subtitle, months, columns, className, colorize, showExpensePercentages,
  expandable, scope, expandedMonth, onToggleMonth, productBreakdowns, productLoading, productError,
}) {
  return (
    <div className={className}>
      <div className="section-title">{title}</div>
      {subtitle && <div className="report-table-subtitle">{subtitle}</div>}
      <div className="card">
        {months.length === 0 ? (
          <div className="empty-state">Нет данных за загруженный период</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col.key} className={col.key === 'month' ? '' : 'num'}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {months.map((m) => {
                  const cacheKey = `${scope}:${m.month}`;
                  return (
                  <React.Fragment key={m.month}>
                    <tr onClick={expandable ? () => onToggleMonth(scope, m.month) : undefined}>
                      {renderRowCells(columns, m, colorize, showExpensePercentages)}
                    </tr>
                    {expandable && expandedMonth === m.month && (
                      <tr>
                        <td colSpan={columns.length} className="warehouse-batches-cell">
                          {productLoading[cacheKey] ? (
                            <div className="empty-state">Загрузка...</div>
                          ) : productError[cacheKey] ? (
                            <div className="error-banner">{productError[cacheKey]}</div>
                          ) : !productBreakdowns[cacheKey] || productBreakdowns[cacheKey].length === 0 ? (
                            <div className="empty-state">Нет данных по товарам за этот месяц</div>
                          ) : (
                            <table className="product-table warehouse-sub-table">
                              <thead>
                                <tr>
                                  {PRODUCT_COLUMNS.map((col) => (
                                    <th key={col.key} className={col.key === 'product_name' ? '' : 'num'}>{col.label}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {productBreakdowns[cacheKey].map((p) => (
                                  <tr key={p.product_id}>
                                    {renderRowCells(PRODUCT_COLUMNS, p, colorize, showExpensePercentages)}
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr>
                                  {renderRowCells(
                                    PRODUCT_COLUMNS,
                                    sumProductRows(productBreakdowns[cacheKey]),
                                    colorize,
                                    showExpensePercentages
                                  )}
                                </tr>
                              </tfoot>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Report({ password, active = true, isOnline = true }) {
  const [months, setMonths] = useState([]);
  const [monthsAll, setMonthsAll] = useState([]);
  const [monthsMainCities, setMonthsMainCities] = useState([]);
  const [monthsSelfBuyCities, setMonthsSelfBuyCities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const fileInputRef = useRef(null);

  // Разворачивать месяцы можно в обеих полных таблицах независимо друг от друга, поэтому
  // раскрытый месяц хранится по таблице ({ all: '2026-08', main: null }), а кэши разбивок —
  // по составному ключу "scope:month".
  const [expandedMonth, setExpandedMonth] = useState({});
  const [productBreakdowns, setProductBreakdowns] = useState({});
  const [productLoading, setProductLoading] = useState({});
  const [productError, setProductError] = useState({});

  // На телефоне вместо двух широких таблиц рисуется ReportMobile — другая раскладка, а не
  // другая вёрстка той же (см. комментарий в ReportMobile.jsx).
  const isMobile = useIsMobile();

  // Ленивая загрузка разбивки по товарам. Вынесена из обработчика клика отдельно, потому что
  // мобильной версии нужно просто "загрузи для этого месяца", без переключения раскрытой строки.
  // Кэш общий на обе версии — ключ тот же составной "scope:month".
  function loadProductBreakdown(scope, month) {
    const key = `${scope}:${month}`;
    if (productBreakdowns[key] || productLoading[key]) return;

    setProductLoading((prev) => ({ ...prev, [key]: true }));
    setProductError((prev) => ({ ...prev, [key]: '' }));
    fetchMonthProductBreakdown(password, month, scope)
      .then((res) => setProductBreakdowns((prev) => ({ ...prev, [key]: res.products })))
      .catch((err) => setProductError((prev) => ({ ...prev, [key]: err.message })))
      .finally(() => setProductLoading((prev) => ({ ...prev, [key]: false })));
  }

  function handleToggleMonth(scope, month) {
    const opening = expandedMonth[scope] !== month;
    setExpandedMonth((prev) => ({ ...prev, [scope]: opening ? month : null }));
    if (opening) loadProductBreakdown(scope, month);
  }

  function loadReport() {
    setLoading(true);
    setError('');
    fetchMonthlyReport(password)
      .then((res) => {
        setMonths(res.months);
        setMonthsAll(res.monthsAll || []);
        setMonthsMainCities(res.monthsMainCities);
        setMonthsSelfBuyCities(res.monthsSelfBuyCities);
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
    if (active) loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshTick]);

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    setUploadMessage('');
    setError('');

    uploadKaspiPayReport(password, file)
      .then((res) => {
        setUploadMessage(`Загружено операций: ${res.processed}`);
        loadReport();
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      });
  }

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Отчёт <span>по прибыли</span></h1>
      </div>

      <div className="card">
        <div className="report-upload-row">
          <div>
            <div className="report-upload-title">Загрузить отчёт Kaspi Pay</div>
            <div className="report-upload-hint">
              Личный кабинет продавца → Аналитика/Отчёты → выгрузите «Детальная информация по операциям» в .xlsx и загрузите сюда.
              Комиссии и стоимость доставки подтянутся автоматически.
            </div>
          </div>
          <label className={`primary-button report-upload-btn${uploading ? ' disabled' : ''}`}>
            {uploading ? 'Загружаем...' : 'Выбрать файл .xlsx'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={handleFileChange}
              disabled={uploading}
              style={{ display: 'none' }}
            />
          </label>
        </div>
        {uploadMessage && <div className="report-upload-success">{uploadMessage}</div>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && !hasData ? (
        <div className="empty-state">Загрузка...</div>
      ) : (
        <div style={{ opacity: (loading && hasData) || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
          {isMobile ? (
            <ReportMobile
              monthsAll={monthsAll}
              monthsMainCities={monthsMainCities}
              onLoadProducts={loadProductBreakdown}
              productBreakdowns={productBreakdowns}
              productLoading={productLoading}
              productError={productError}
            />
          ) : (
            <>
              <MonthlyTable
                title="Основной отчёт (все склады)"
                subtitle="Все склады и все заказы, включая самовыкупы и заказы с нераспознанной точкой продаж"
                months={monthsAll}
                columns={MAIN_COLUMNS}
                colorize
                showExpensePercentages
                expandable
                scope="all"
                expandedMonth={expandedMonth.all || null}
                onToggleMonth={handleToggleMonth}
                productBreakdowns={productBreakdowns}
                productLoading={productLoading}
                productError={productError}
              />
              <MonthlyTable
                title="Основной отчёт (Алматы, Астана)"
                subtitle="Только продажи со складов основного магазина — без самовыкупов"
                months={monthsMainCities}
                columns={MAIN_COLUMNS}
                colorize
                showExpensePercentages
                expandable
                scope="main"
                expandedMonth={expandedMonth.main || null}
                onToggleMonth={handleToggleMonth}
                productBreakdowns={productBreakdowns}
                productLoading={productLoading}
                productError={productError}
              />
            </>
          )}
          <div className="report-row">
            <MonthlyTable title="Общий отчёт" months={months} columns={GENERAL_COLUMNS} className="report-col" />
            <MonthlyTable title="Самовыкупы (Юбилейное, Талдыкорган)" months={monthsSelfBuyCities} columns={SELF_BUY_COLUMNS} className="report-col" />
          </div>
        </div>
      )}

      {/* Справка "как считаются цифры" одна и та же, но на телефоне она свёрнута:
          текста тут на несколько экранов, и развёрнутым он отодвигает всё остальное. */}
      {isMobile ? (
        <details className="report-note report-note-details">
          <summary>Как считаются цифры</summary>
          <div>
        ⚠️ Наверху две одинаковые по колонкам таблицы, и различаются они только набором заказов. «Основной отчёт (все склады)» берёт ВСЕ операции
        Kaspi Pay без фильтра по городу отгрузки: туда входят Алматы и Астана, все склады самовыкупов, а также заказы, у которых точка продаж не
        распозналась или которых вообще нет в данных заказов Kaspi (в отчёт по городам такие не попадают ни в одну из таблиц). Именно поэтому выручка
        и налог в верхней таблице ближе всего к тому, что уходит в декларацию. Две оговорки: во-первых, в неё входят самовыкупы — это ваши собственные
        покупки, они поднимают и выручку, и «прибыль», поэтому для оценки реального заработка смотрите вторую таблицу; во-вторых, себестоимость (FIFO
        по партиям) считается только по заказам с известным складом — у заказа с нераспознанной точкой продаж списывать товар не с чего, так что его
        выручка в верхнюю таблицу попадёт, а себестоимость — нет, и прибыль по нему окажется завышенной. «Основной отчёт (Алматы, Астана)» —
        прежний отчёт по складам основного магазина, он не изменился.
        Налог считается упрощённо: 3% с чистого оборота (выручка минус возвраты). Себестоимость считается по методу FIFO на основе партий на «Поставках»,
        и только по тем заказам, которые реально есть в загруженном Excel-отчёте Kaspi Pay со статусом «Покупка». «Себестоимость возвратов» — справочная
        колонка (приближённая оценка по текущей активной партии товара), в расчёт чистой прибыли она не входит — себестоимость возвращённого товара уже
        разово списана в момент продажи и повторно не вычитается. «Прочие расходы» в основном отчёте — это сумма категории «Прочие затраты» из раздела
        «Расходы» (Google Таблица) за тот же месяц; категория «Товар» туда не входит — она уже учтена через себестоимость, а «Вывод» не входит, так как это
        не операционный расход бизнеса. Таблицы по городам определяются по номеру заказа: он совпадает и в Excel-отчёте Kaspi Pay, и в данных заказов Kaspi.
        «Маркетинг» в «Основном отчёте» — сумма трёх источников продвижения товара за тот же месяц: реклама товаров, бонусы от продавца и бонусы за отзыв
        (все три заливаются Tampermonkey-скриптом со страниц marketing.kaspi.kz); ни один из них не привязан к городу отгрузки, поэтому считаются по всему
        магазину целиком, а не только по Алматы и Астане. «Упаковка» — сумма категории «Упаковка» из раздела «Расходы» (Google Таблица) за тот же месяц;
        вносится туда вручную, тоже считается по всему магазину целиком.
        Клик по строке месяца в «Основном отчёте» разворачивает разбивку по товарам: себестоимость там точная (та же FIFO), а комиссия, доставка и сумма
        возвратов у Kaspi Pay привязаны только к заказу целиком — если в заказе несколько разных товаров, эти три величины делятся между ними пропорционально
        выручке. Единый «Маркетинг» здесь раскрыт на три отдельные колонки — «Реклама товаров», «Бонусы от продавца» и «Бонусы за отзыв» — все три считаются
        через привязку кампании к товару (если кампания продвигает сразу несколько товаров — её расход делится между ними поровну; кампании без сохранённой
        привязки к товару в разбивку не попадают). «Прочие расходы» и «Упаковка» на уровне товара не считаются — это расходы всего бизнеса, а не конкретного
        товара, поэтому в разбивке там прочерк.
        Число под суммой в каждой расходной колонке — доля этой статьи от выручки: в строке месяца от выручки за этот месяц, а в разбивке по товарам —
        от выручки самого товара (сколько из 100% его выручки уходит именно сюда). Поэтому доли товара и доли месяца не обязаны совпадать: у дорогого
        товара своя структура расходов. «Прочие расходы» и «Упаковка» на уровне товара не считаются, там прочерк и доли нет.
</div>
        </details>
      ) : (
        <div className="report-note">
        ⚠️ Наверху две одинаковые по колонкам таблицы, и различаются они только набором заказов. «Основной отчёт (все склады)» берёт ВСЕ операции
        Kaspi Pay без фильтра по городу отгрузки: туда входят Алматы и Астана, все склады самовыкупов, а также заказы, у которых точка продаж не
        распозналась или которых вообще нет в данных заказов Kaspi (в отчёт по городам такие не попадают ни в одну из таблиц). Именно поэтому выручка
        и налог в верхней таблице ближе всего к тому, что уходит в декларацию. Две оговорки: во-первых, в неё входят самовыкупы — это ваши собственные
        покупки, они поднимают и выручку, и «прибыль», поэтому для оценки реального заработка смотрите вторую таблицу; во-вторых, себестоимость (FIFO
        по партиям) считается только по заказам с известным складом — у заказа с нераспознанной точкой продаж списывать товар не с чего, так что его
        выручка в верхнюю таблицу попадёт, а себестоимость — нет, и прибыль по нему окажется завышенной. «Основной отчёт (Алматы, Астана)» —
        прежний отчёт по складам основного магазина, он не изменился.
        Налог считается упрощённо: 3% с чистого оборота (выручка минус возвраты). Себестоимость считается по методу FIFO на основе партий на «Поставках»,
        и только по тем заказам, которые реально есть в загруженном Excel-отчёте Kaspi Pay со статусом «Покупка». «Себестоимость возвратов» — справочная
        колонка (приближённая оценка по текущей активной партии товара), в расчёт чистой прибыли она не входит — себестоимость возвращённого товара уже
        разово списана в момент продажи и повторно не вычитается. «Прочие расходы» в основном отчёте — это сумма категории «Прочие затраты» из раздела
        «Расходы» (Google Таблица) за тот же месяц; категория «Товар» туда не входит — она уже учтена через себестоимость, а «Вывод» не входит, так как это
        не операционный расход бизнеса. Таблицы по городам определяются по номеру заказа: он совпадает и в Excel-отчёте Kaspi Pay, и в данных заказов Kaspi.
        «Маркетинг» в «Основном отчёте» — сумма трёх источников продвижения товара за тот же месяц: реклама товаров, бонусы от продавца и бонусы за отзыв
        (все три заливаются Tampermonkey-скриптом со страниц marketing.kaspi.kz); ни один из них не привязан к городу отгрузки, поэтому считаются по всему
        магазину целиком, а не только по Алматы и Астане. «Упаковка» — сумма категории «Упаковка» из раздела «Расходы» (Google Таблица) за тот же месяц;
        вносится туда вручную, тоже считается по всему магазину целиком.
        Клик по строке месяца в «Основном отчёте» разворачивает разбивку по товарам: себестоимость там точная (та же FIFO), а комиссия, доставка и сумма
        возвратов у Kaspi Pay привязаны только к заказу целиком — если в заказе несколько разных товаров, эти три величины делятся между ними пропорционально
        выручке. Единый «Маркетинг» здесь раскрыт на три отдельные колонки — «Реклама товаров», «Бонусы от продавца» и «Бонусы за отзыв» — все три считаются
        через привязку кампании к товару (если кампания продвигает сразу несколько товаров — её расход делится между ними поровну; кампании без сохранённой
        привязки к товару в разбивку не попадают). «Прочие расходы» и «Упаковка» на уровне товара не считаются — это расходы всего бизнеса, а не конкретного
        товара, поэтому в разбивке там прочерк.
        Число под суммой в каждой расходной колонке — доля этой статьи от выручки: в строке месяца от выручки за этот месяц, а в разбивке по товарам —
        от выручки самого товара (сколько из 100% его выручки уходит именно сюда). Поэтому доли товара и доли месяца не обязаны совпадать: у дорогого
        товара своя структура расходов. «Прочие расходы» и «Упаковка» на уровне товара не считаются, там прочерк и доли нет.
</div>
      )}
    </div>
  );
}
