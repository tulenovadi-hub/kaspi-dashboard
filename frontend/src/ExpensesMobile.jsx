import React, { useState } from 'react';
import { formatMoney, formatMonthLabel, formatRecords } from './dateUtils.js';

// Мобильные "Расходы". На компьютере это две таблицы: сводка "месяц × 5 категорий" и список
// всех расходов на 6 колонок (дата, название, категория, источник, сумма, кто). Владелец
// выбрала из двух макетов (2026-09-09) вариант "месяц целиком": страница показывает ОДИН
// месяц — его сумму, разбивку по категориям и его расходы. Второй вариант (вся история
// полосками + сплошной список) отклонён.
//
// ГЛАВНАЯ ПРАВКА ПОСЛЕ МАКЕТА: по макету было непонятно, что категорию можно НАЖАТЬ, чтобы
// отфильтровать список ниже. Поэтому строка категории теперь выглядит нажимаемой: рамка,
// стрелка справа, а у выбранной — цвет бренда и крестик вместо стрелки; над списком стоит
// отдельный чипс "Вывод ✕", чтобы было видно, что список сужен, даже если разбивка уехала
// за экран.
//
// Фильтры (месяц, категория, поиск) живут в `Expenses.jsx` и общие с компьютерной версией.

const CATEGORY_COLORS = ['var(--cat-0)', 'var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)'];

// Стрелка/крестик рисуем svg, а не символом: ▶ и × на айфоне подменяются цветным эмодзи
// и выбиваются из стиля страницы (та же причина, что у Chevron в WarehouseMobile).
function Chevron() {
  return (
    <svg viewBox="0 0 8 12" width="7" height="10" aria-hidden="true" focusable="false">
      <path d="M1.6 1.4 6 6l-4.4 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function shortMoney(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(2).replace('.', ',')} млн ₸`;
  if (Math.abs(v) >= 100000) return `${Math.round(v / 1000)} тыс ₸`;
  return formatMoney(v);
}

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function monthShort(key) {
  return `${MONTH_SHORT[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
}

function dayMonth(value) {
  const d = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '—';
}

function fullDate(value) {
  const d = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '—';
}

export default function ExpensesMobile({
  months, categories, filtered, filteredTotal,
  search, categoryFilter, monthFilter,
  onSearch, onCategory, onMonth,
  loading, isOnline, syncing, syncMessage, syncWarnings, syncError,
}) {
  const [openId, setOpenId] = useState(null);

  // Сводка приходит от сервера от свежего месяца к старому — на всякий случай сортируем сами:
  // от порядка зависит и полоса месяцев, и то, с чем сравнивается выбранный месяц.
  const sorted = months.slice().sort((a, b) => (a.month < b.month ? 1 : -1));
  const index = sorted.findIndex((m) => m.month === monthFilter);
  const current = index >= 0 ? sorted[index] : null;
  const previous = index >= 0 ? sorted[index + 1] : null;
  // Расходы: рост — это плохо, поэтому "+" красится красным, а "−" зелёным (наоборот
  // относительно выручки на Главной).
  const delta = current && previous && previous.total
    ? ((current.total - previous.total) / previous.total) * 100
    : null;

  const catRows = categories
    .map((c, i) => ({
      name: c,
      value: current && current.byCategory[c] ? Number(current.byCategory[c]) : 0,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }))
    .sort((a, b) => b.value - a.value);

  const colorOf = (name) => {
    const i = categories.indexOf(name);
    return i < 0 ? 'var(--text-muted)' : CATEGORY_COLORS[i % CATEGORY_COLORS.length];
  };

  return (
    <div className="em">
      {/* Кнопки "Обновить" здесь больше нет: гугл-таблица подтягивается сама при открытии
          страницы и при свайпе вниз (см. Expenses.jsx). Пока идёт синхронизация — одна тихая
          строка, чтобы было видно, что цифры сейчас могут доехать. */}
      {syncing && <div className="em-sync-line">Обновляем из гугл-таблицы…</div>}
      {syncMessage && <div className="report-upload-success">{syncMessage}</div>}
      {syncWarnings.map((w) => (
        <div key={w} className="expenses-sync-warning">{w}</div>
      ))}
      {syncError && <div className="error-banner">{syncError}</div>}

      <div style={{ opacity: loading || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        {sorted.length === 0 ? (
          <div className="empty-state">Пока нет данных — расходы подтянутся из гугл-таблицы</div>
        ) : (
          <>
            <div className="em-months">
              {sorted.map((m) => (
                <button
                  key={m.month}
                  className="em-month"
                  aria-pressed={m.month === monthFilter}
                  onClick={() => onMonth(m.month)}
                >
                  <span className="em-month-name">{monthShort(m.month)}</span>
                  <span className="em-month-sum">{shortMoney(m.total)}</span>
                </button>
              ))}
            </div>

            {current && (
              <div className="em-total">
                <div className="em-total-label">
                  {formatMonthLabel(current.month)} · {formatRecords(current.records_count)}
                </div>
                <div className="em-total-row">
                  <div className="em-total-value">{shortMoney(current.total)}</div>
                  {delta !== null && (
                    <div className={`em-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
                      {delta > 0 ? '+' : ''}{delta.toFixed(1)}%
                    </div>
                  )}
                </div>
                {previous && (
                  <div className="em-total-sub">
                    {formatMonthLabel(previous.month)}: {shortMoney(previous.total)}
                  </div>
                )}
              </div>
            )}

            <div className="em-sec">
              <span>По категориям</span>
              <span className="em-sec-hint">нажмите — отфильтрует список</span>
            </div>
            <div className="em-cats">
              {catRows.map((row) => {
                const selected = categoryFilter === row.name;
                const share = current && current.total ? (row.value / current.total) * 100 : 0;
                return (
                  <button
                    key={row.name}
                    className="em-cat"
                    aria-pressed={selected}
                    onClick={() => onCategory(selected ? '' : row.name)}
                  >
                    <span className="em-cat-name">
                      <i className="em-cat-dot" style={{ background: row.color }} />
                      {row.name}
                    </span>
                    <span className="em-cat-sum">{row.value ? shortMoney(row.value) : '—'}</span>
                    <span className="em-cat-arrow">{selected ? <Cross /> : <Chevron />}</span>
                    <span className="em-cat-share">{share.toFixed(1).replace('.', ',')}%</span>
                    <span className="em-cat-bar">
                      <i style={{ width: `${share}%`, background: row.color }} />
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="em-sec"><span>Расходы месяца</span></div>
            {categoryFilter && (
              <button className="em-active-filter" onClick={() => onCategory('')}>
                <i className="em-cat-dot" style={{ background: colorOf(categoryFilter) }} />
                {categoryFilter}
                <Cross />
              </button>
            )}
            <input
              className="em-search"
              type="search"
              placeholder="Поиск по названию"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />

            <div className="em-list">
              {filtered.length === 0 ? (
                <div className="empty-state">Ничего не найдено</div>
              ) : filtered.map((e) => {
                const isOpen = openId === e.id;
                return (
                  <button
                    key={e.id}
                    className="em-row"
                    aria-expanded={isOpen}
                    onClick={() => setOpenId((prev) => (prev === e.id ? null : e.id))}
                  >
                    <span className="em-row-name">{e.name || '—'}</span>
                    <span className="em-row-sum">{formatMoney(e.amount)}</span>
                    <span className="em-row-meta">
                      {dayMonth(e.expense_date)}
                      <i className="em-cat-dot" style={{ background: colorOf(e.category) }} />
                      {e.category || '—'}
                    </span>
                    <span />
                    {isOpen && (
                      <span className="em-row-detail">
                        <span className="em-line"><span>Дата</span><span>{fullDate(e.expense_date)}</span></span>
                        <span className="em-line"><span>Категория</span><span>{e.category || '—'}</span></span>
                        <span className="em-line"><span>Источник</span><span>{e.source || '—'}</span></span>
                        <span className="em-line"><span>Кто</span><span>{e.comment || '—'}</span></span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {filtered.length > 0 && (
              <div className="em-sum">
                <span>Итого показано · {formatRecords(filtered.length)}</span>
                <b>{formatMoney(filteredTotal)}</b>
              </div>
            )}
          </>
        )}
      </div>

      <div className="report-note">
        Данные подтягиваются из листа «Бизнес» гугл-таблицы. Строки с нераспознанной датой не
        попадают ни в сводку по месяцам, ни в «Отчёт»; незнакомые категории не учитываются в «Отчёте».
      </div>
    </div>
  );
}
