import React, { useEffect, useRef, useState } from 'react';
import MetricLineChart from './MetricLineChart.jsx';
import { formatMoney, formatNumber, percentChange, shiftDays, toISODate, daysAgo } from './dateUtils.js';
import { useBodyScrollLock } from './useBodyScrollLock.js';
import { useClosing } from './useClosing.js';
import Odometer from './Odometer.jsx';

// Мобильная "Главная". На компьютере это блок "вчера/сегодня", полоса периодов, пять карточек
// показателей в ряд, график и таблица товаров. На телефоне карточки встают в столбик, и
// страница вырастает до 1873px — 2,3 экрана, из которых первый почти целиком шапка, а график
// начинается только после ~900px прокрутки (замер 2026-09-07).
//
// Владелец выбрала вариант "один показатель крупно": сверху выбранный показатель большой цифрой
// и его график, остальные — маленькими плитками; тап переключает и цифру, и линию графика.
// Кнопка "Обновить сейчас", все пять показателей, обе сноски (свёрнуты) и карточка товара —
// на месте. Единственное, что сознательно сокращено, — полоса периодов: вместо восьми чипсов
// пять (2026-09-09, см. PRESETS ниже), а всё остальное живёт в модалке "Выбрать период".

// Пять кнопок и ровно в этом порядке — так попросила владелец 2026-09-09: восемь чипсов
// (7/14/30/90 дней и всё остальное) занимали две строки, а нажимала она из них три.
// Всё, что убрали, доступно через "Свой период": там же выбор месяца целиком.
const PRESETS = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'month', label: 'С начала месяца' },
  { key: '30days', label: '30 дней' },
];

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// Последние 12 месяцев, свежий — справа (как в приложении банка со скриншота, который
// показала владелец). Для прошлых лет к названию добавляется год, иначе "Сентябрь" 2025-го
// и 2026-го выглядели бы одинаково.
function lastMonths(count = 12) {
  const today = toISODate(daysAgo(0));
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const list = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const m = ((month - 1 - i) % 12 + 12) % 12;
    const y = year + Math.floor((month - 1 - i) / 12);
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    list.push({ key, label: y === year ? MONTH_NAMES[m] : `${MONTH_NAMES[m]} ${String(y).slice(2)}` });
  }
  return list;
}

// Границы месяца. Конец обрезаем сегодняшним днём: у текущего месяца "по 30 сентября" — это
// период, которого ещё не было, и в графике он дал бы пустой хвост.
function monthRange(key) {
  const today = toISODate(daysAgo(0));
  const [y, m] = key.split('-').map(Number);
  const first = `${key}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${key}-${String(lastDay).padStart(2, '0')}`;
  return { from: first, to: last > today ? today : last };
}

function shortMoney(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(2).replace('.', ',')} млн ₸`;
  return formatMoney(v);
}

function dayLabel(iso) {
  const d = String(iso).slice(0, 10);
  return `${d.slice(8, 10)}.${d.slice(5, 7)}`;
}

// Модалка выбора периода — по образцу приложения, которое показала владелец: сверху месяцы
// целиком, ниже свои даты, внизу одна кнопка "Применить". Отличие от прежней раскрывашки:
// даты меняются в ЧЕРНОВИКЕ и применяются одной кнопкой, поэтому страница не перезагружает
// данные на каждое касание календаря (раньше правка "с" уже уходила в запрос, и пока не
// поправишь "по", грузился бессмысленный диапазон).
function PeriodSheet({ from, to, onApply, onClose }) {
  const { closing, close } = useClosing(onClose);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const monthsRef = useRef(null);
  const toRef = useRef(null);
  // Фон под модалкой не должен прокручиваться (см. useBodyScrollLock.js).
  useBodyScrollLock();

  const months = lastMonths();
  const activeMonth = months.find((m) => {
    const r = monthRange(m.key);
    return r.from === draftFrom && r.to === draftTo;
  });
  const invalid = draftFrom > draftTo;

  // Полоса месяцев идёт от старых к свежим, и при открытии она упиралась в левый край —
  // владелец видела октябрь прошлого года, а нужен последний месяц. Порядок не меняем
  // (так попросила), просто перематываем к правому краю: если выбран конкретный месяц —
  // ставим его по центру, иначе показываем самый свежий.
  useEffect(() => {
    const strip = monthsRef.current;
    if (!strip) return;
    const active = activeMonth ? strip.querySelector('[aria-pressed="true"]') : null;
    strip.scrollLeft = active
      ? Math.max(0, active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2)
      : strip.scrollWidth;
    // Один раз при открытии: дальше полосу листает пользователь, и перематывать её
    // на каждый выбор месяца — значит выдёргивать её у него из-под пальца.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Выбрали дату начала — сразу открываем второй календарь: раньше приходилось закрывать
  // первый и отдельно нажимать на поле "По". showPicker есть в Safari 16+, но на всякий
  // случай остаётся focus(). Пауза нужна, чтобы первый календарь успел закрыться, иначе
  // айфон игнорирует открытие второго.
  function handleFromChange(value) {
    setDraftFrom(value);
    // Начало уехало за конец — подтягиваем конец, чтобы период не был "вывернутым",
    // пока пользователь не выбрал дату окончания.
    if (value && value > draftTo) setDraftTo(value);
    if (!value) return;
    setTimeout(() => {
      const el = toRef.current;
      if (!el) return;
      el.focus();
      if (typeof el.showPicker === 'function') {
        try { el.showPicker(); } catch { /* браузер не дал открыть — поле просто в фокусе */ }
      }
    }, 150);
  }

  return (
    <div className={`svm-sheet-overlay${closing ? ' is-closing' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="svm-sheet" role="dialog" aria-label="Выбрать период">
        <div className="svm-sheet-head">
          <button className="svm-sheet-close" onClick={close} aria-label="Закрыть">×</button>
          <div className="svm-sheet-title">Выбрать период</div>
          <span className="svm-sheet-spacer" />
        </div>

        <div className="svm-sheet-label">Месяц целиком</div>
        <div className="svm-sheet-months" ref={monthsRef}>
          {months.map((m) => (
            <button
              key={m.key}
              className="svm-month"
              aria-pressed={activeMonth ? activeMonth.key === m.key : false}
              onClick={() => {
                const r = monthRange(m.key);
                setDraftFrom(r.from);
                setDraftTo(r.to);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="svm-sheet-label">Свой период</div>
        {/* Поля в столбик, а не рядом: на айфоне нативное поле даты рисует "31 авг. 2026 г."
            во всю свою ширину, и в двух колонках по 160px текст налезал на рамку. */}
        <div className="svm-sheet-dates">
          <label>
            <span>С</span>
            <input
              type="date"
              value={draftFrom}
              onChange={(e) => handleFromChange(e.target.value)}
            />
          </label>
          <label>
            <span>По</span>
            <input
              ref={toRef}
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
            />
          </label>
        </div>
        {invalid && <div className="svm-sheet-error">Начало периода позже конца — поменяйте даты местами</div>}

        <button
          className="svm-sheet-apply"
          disabled={invalid}
          onClick={() => { onApply(draftFrom, draftTo); close(); }}
        >
          Применить
        </button>
      </div>
    </div>
  );
}

export default function SalesViewMobile({
  days, profitDays, products, todayRevenue, yesterdayRevenue, prevTotals,
  totalRevenue, totalOrders, avgOrder, avgOrdersPerDay, periodNetProfit,
  inventoryTotal, usedEstimate, showMarketingNote,
  from, to, presetKey, onPeriodChange, onCustomDates,
  showSync, syncing, onSync, syncResult, onSelectProduct,
}) {
  const [metric, setMetric] = useState('revenue');
  const [showPeriod, setShowPeriod] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const labels = days.map((d) => dayLabel(d.day));

  // Показатели — те же пять карточек, что на компьютере. series есть у тех, кого сервер
  // отдаёт по дням; у "Денег в товаре" его нет и быть не может — это снимок на сейчас.
  const METRICS = [
    {
      key: 'revenue', label: 'Сумма продаж', value: totalRevenue, format: formatMoney,
      prev: prevTotals ? prevTotals.revenue : null,
      series: days.map((d) => Number(d.total_revenue) || 0),
      seriesLabels: labels,
    },
    {
      key: 'orders', label: 'Количество заказов', value: totalOrders, format: formatNumber,
      hint: `⌀ ${avgOrdersPerDay}/день`,
      prev: prevTotals ? prevTotals.orders : null,
      series: days.map((d) => Number(d.orders_count) || 0),
      seriesLabels: labels,
    },
    {
      key: 'avg', label: 'Средний чек', value: avgOrder, format: formatMoney,
      prev: prevTotals ? prevTotals.avg : null,
      series: days.map((d) => (Number(d.orders_count) ? Number(d.total_revenue) / Number(d.orders_count) : 0)),
      seriesLabels: labels,
    },
    {
      key: 'profit', label: 'Чистая прибыль', value: periodNetProfit, format: formatMoney,
      tone: periodNetProfit < 0 ? 'down' : 'up',
      prev: prevTotals ? prevTotals.profit : null,
      // Прибыль приходит отдельным запросом (/summary-profit) и может покрывать не те же дни,
      // что выручка, — поэтому и подписи для подсказки берём из её собственного ряда.
      series: profitDays.length ? profitDays.map((d) => Number(d.net_profit) || 0) : null,
      seriesLabels: profitDays.map((d) => dayLabel(d.day)),
    },
    ...(inventoryTotal !== null ? [{
      key: 'inventory', label: 'Деньги в товаре сейчас', value: inventoryTotal, format: formatMoney,
      short: shortMoney(inventoryTotal), snapshot: true,
      note: 'Остаток складов плюс оплаченное в пути — подробности на «Складе»',
    }] : []),
  ];

  const current = METRICS.find((m) => m.key === metric) || METRICS[0];
  // Сравниваем то же самое с тем же самым: показатель за выбранный период против него же за
  // предыдущий период такой же длины (см. previousRange в SalesView.jsx).
  //
  // Проверка prevTotals.to === день перед from обязательна: итоги двух периодов грузятся
  // разными запросами и приходят вразнобой. Без неё в момент смены периода процент успевает
  // посчитаться от СТАРОЙ текущей цифры к УЖЕ НОВОЙ предыдущей — на "Сегодня" мелькало
  // +845,7%, потому что месячная выручка делилась на вчерашнюю.
  const prevMatchesPeriod = !!prevTotals && prevTotals.to === shiftDays(from, -1);
  const currentDelta = current.snapshot || !prevMatchesPeriod || current.prev === null || current.prev === undefined
    ? null
    : percentChange(current.value, current.prev);
  const color = current.key === 'profit'
    ? (periodNetProfit < 0 ? 'var(--accent-down)' : 'var(--accent-up)')
    : 'var(--accent-brand)';

  function applyPreset(key) {
    onPeriodChange(key);
  }

  return (
    <div className="svm">
      <div className="svm-head">
        {syncResult && <span className="sync-result">{syncResult}</span>}
        {showSync && (
          <button className="sync-button" onClick={onSync} disabled={syncing}>
            {syncing ? 'Обновляем...' : 'Обновить сейчас'}
          </button>
        )}
      </div>

      <div className="svm-chips">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className="svm-chip"
            aria-pressed={presetKey === p.key}
            onClick={() => applyPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          className="svm-chip"
          aria-pressed={presetKey === 'custom'}
          onClick={() => setShowPeriod(true)}
        >
          Свой период
        </button>
      </div>

      {/* Под чипсами — какой диапазон сейчас показан. Раньше даты всегда висели в двух полях,
          теперь они в модалке, и без этой строки было бы непонятно, за что цифры. */}
      <div className="svm-range">{dayLabel(from)} — {dayLabel(to)}</div>

      <div className="svm-big">
        <div className="svm-big-row">
          <div>
            <div className="svm-big-label">
              {current.label}{current.snapshot ? ' · на сейчас' : ' · за период'}
            </div>
            <div className={`svm-big-value${current.tone === 'up' ? ' svm-up' : current.tone === 'down' ? ' svm-down' : ''}`}>
              <Odometer value={current.value} format={current.format} />
            </div>
          </div>
          {/* Процент — по ВЫБРАННОМУ показателю и к предыдущему периоду такой же длины.
              У "Денег в товаре" его нет: это снимок на сейчас, сравнивать не с чем. */}
          {!current.snapshot && (
            <div className={`svm-delta ${currentDelta === null ? 'flat' : currentDelta > 0 ? 'up' : currentDelta < 0 ? 'down' : 'flat'}`}>
              {currentDelta === null ? '…' : `${currentDelta > 0 ? '+' : ''}${currentDelta.toFixed(1)}%`}
            </div>
          )}
        </div>
        <div className="svm-big-sub">
          {current.snapshot
            ? 'снимок на сейчас — сравнивать не с чем'
            : prevMatchesPeriod
              ? `${prevTotals.days} дн. до этого (${dayLabel(prevTotals.from)} — ${dayLabel(prevTotals.to)}): ${current.format(current.prev)}`
              : 'считаем предыдущий период…'}
        </div>
        <div className="svm-big-sub">
          сегодня {formatMoney(todayRevenue)} · вчера {formatMoney(yesterdayRevenue)}
          {current.hint ? ` · ${current.hint}` : ''}
        </div>

        {current.series ? (
          <MetricLineChart
            values={current.series}
            labels={current.seriesLabels || labels}
            color={color}
            format={current.format}
          />
        ) : (
          <div className="svm-no-chart">
            {current.snapshot
              ? 'Снимок на сейчас — по дням периода не разбивается'
              : 'За этот период дневных данных нет'}
          </div>
        )}
        {current.note && <div className="svm-metric-note">{current.note}</div>}

        <div className="svm-minis">
          {METRICS.map((m) => (
            <button
              key={m.key}
              className="svm-mini"
              aria-pressed={m.key === metric}
              onClick={() => setMetric(m.key)}
            >
              <div className="svm-mini-label">{m.label}</div>
              <div className={`svm-mini-value${m.tone === 'up' ? ' svm-up' : m.tone === 'down' ? ' svm-down' : ''}`}>
                {m.short || m.format(m.value)}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Обе сноски с компьютера — текста на треть экрана, поэтому свёрнуты. */}
      {(usedEstimate || showMarketingNote) && (
        <>
          <button className="svm-notes-toggle" onClick={() => setShowNotes((v) => !v)} aria-expanded={showNotes}>
            {showNotes ? 'Скрыть примечания' : 'Как считается прибыль'}
          </button>
          <div className={`wm-collapsible${showNotes ? ' is-open' : ''}`}>
            <div>
              <div className="svm-notes">
                {usedEstimate && (
                  <p>
                    По части заказов ещё не загружен свежий Excel-отчёт Kaspi Pay — их чистая прибыль
                    оценена примерно, по среднему проценту прибыли уже посчитанных заказов с тем же товаром.
                  </p>
                )}
                {showMarketingNote && (
                  <p>
                    Из чистой прибыли также вычтены расходы на маркетинг (реклама, бонусы от продавца,
                    бонусы за отзыв) за выбранный период — только то, что фактически загружено, без
                    прогноза за недостающие дни.
                  </p>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {showPeriod && (
        <PeriodSheet
          from={from}
          to={to}
          onApply={onCustomDates}
          onClose={() => setShowPeriod(false)}
        />
      )}

      <div className="svm-sec-title">Продажи по товарам</div>
      <div className="card svm-products">
        {products.length === 0 ? (
          <div className="empty-state">За выбранный период продаж по товарам не было</div>
        ) : products.map((p) => {
          const maxRevenue = Math.max(...products.map((x) => Number(x.total_revenue) || 0), 1);
          const revenue = Number(p.total_revenue) || 0;
          return (
            <button
              key={p.product_id || p.product_name}
              className="svm-prod"
              onClick={() => onSelectProduct(p)}
            >
              <div className="svm-prod-name">{p.product_name}</div>
              <div className="svm-prod-sum">{formatMoney(revenue)}</div>
              <div className="svm-prod-meta">{formatNumber(p.total_quantity)} шт</div>
              <div className="svm-prod-meta svm-right">
                {totalRevenue > 0 ? `${Math.round((revenue / totalRevenue) * 100)}% выручки` : ''}
              </div>
              <div className="svm-prod-bar"><i style={{ width: `${(revenue / maxRevenue) * 100}%` }} /></div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
