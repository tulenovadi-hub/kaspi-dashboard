import React, { useEffect, useMemo, useState } from 'react';
import { fetchExpenses, fetchExpensesMonthly, syncExpenses } from './api.js';
import { formatMoney, formatMonthLabel, formatDateDMY, formatRecords } from './dateUtils.js';
import ExpensesMobile from './ExpensesMobile.jsx';
import { useIsMobile } from './useIsMobile.js';
import { useAppRefresh } from './useAppRefresh.js';

export default function Expenses({ password, active = true, isOnline = true }) {
  const [expenses, setExpenses] = useState([]);
  const [months, setMonths] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [syncWarnings, setSyncWarnings] = useState([]);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState('');
  const isMobile = useIsMobile();

  function loadData() {
    setLoading(true);
    setError('');
    Promise.all([fetchExpenses(password), fetchExpensesMonthly(password)])
      .then(([expRes, monthsRes]) => {
        setExpenses(expRes.expenses);
        setMonths(monthsRes.months);
        setCategories(monthsRes.categories);
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

  // Кнопки "Обновить" на странице больше нет (убрана 2026-09-09): гугл-таблица подтягивается
  // сама при каждом открытии страницы и при свайпе вниз. Синхронизация идёт ПАРАЛЛЕЛЬНО с
  // чтением базы, а не до него: показать уже сохранённые расходы можно сразу, а поход в Google
  // (~0,5 с на скачивание листа) не должен задерживать страницу. Перечитываем базу только
  // если синхронизация реально что-то изменила — иначе страница зря мигнёт.
  useEffect(() => {
    if (!active) return;
    loadData();
    if (isOnline) syncFromSheet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshTick]);

  // На телефоне страница показывает ОДИН месяц, пункта "все месяцы" там нет — поэтому, как
  // только сводка загрузилась, встаём на самый свежий месяц. На компьютере фильтр по умолчанию
  // пустой ("Все месяцы"), и трогать его не надо.
  useEffect(() => {
    if (!isMobile || monthFilter || months.length === 0) return;
    setMonthFilter(months.reduce((a, b) => (a.month > b.month ? a : b)).month);
  }, [isMobile, months, monthFilter]);

  function syncFromSheet() {
    setSyncing(true);
    setSyncMessage('');
    setSyncWarnings([]);
    setSyncError('');
    syncExpenses(password)
      .then((res) => {
        // Раньше здесь всегда писали "Обновлено расходов: 330" — при автоматической
        // синхронизации это была бы строка на каждое открытие страницы ни о чём. Теперь
        // сообщение появляется, только если в таблице действительно что-то поменялось.
        const parts = [];
        if (res.inserted) parts.push(`добавлено ${formatRecords(res.inserted)}`);
        if (res.updated) parts.push(`изменено ${formatRecords(res.updated)}`);
        if (res.removed) parts.push(`удалено ${formatRecords(res.removed)}`);
        setSyncMessage(parts.length > 0 ? `Из гугл-таблицы: ${parts.join(', ')}` : '');

        // Две вещи, которые раньше ломались молча: строка с непонятной датой выпадает и из сводки
        // по месяцам, и из "Отчёта"; незнакомая категория не попадает ни в "прочие затраты",
        // ни в "упаковку" отчёта. Показываем обе прямо здесь, чтобы это было видно сразу.
        const warnings = [];
        if (res.withoutDate > 0) {
          warnings.push(
            `Строк с нераспознанной датой: ${res.withoutDate}. Они не попадут ни в сводку по месяцам, ` +
            'ни в «Отчёт» — проверьте формат даты в таблице (нужен ДД.ММ.ГГГГ).'
          );
        }
        if (res.unknownCategories && res.unknownCategories.length > 0) {
          const list = res.unknownCategories.map((c) => `«${c.name}» (${c.count})`).join(', ');
          warnings.push(
            `Незнакомые категории: ${list}. В «Отчёте» они не учитываются. Ожидаются: ` +
            'Прочие затраты, Товар, Вывод, Упаковка, Логистика.'
          );
        }
        setSyncWarnings(warnings);

        // `changed` присылает только новый бэкенд; если его нет (страница открыта, пока
        // катится деплой) — перечитываем на всякий случай, как делали раньше.
        if (res.changed !== 0) loadData();
      })
      // Неудачная синхронизация не должна прятать уже загруженные расходы — своя строка,
      // отдельно от ошибки загрузки, чтобы было видно, что цифры на странице могут быть вчерашние.
      .catch((err) => setSyncError(`Не удалось обновить из гугл-таблицы: ${err.message}`))
      .finally(() => setSyncing(false));
  }

  const listCategories = useMemo(() => {
    return Array.from(new Set(expenses.map((e) => e.category).filter(Boolean))).sort();
  }, [expenses]);

  const availableMonths = useMemo(() => {
    return Array.from(new Set(expenses.map((e) => (e.expense_date || '').slice(0, 7)).filter(Boolean))).sort().reverse();
  }, [expenses]);

  const filtered = useMemo(() => {
    return expenses
      .filter((e) => !search || (e.name || '').toLowerCase().includes(search.toLowerCase()))
      .filter((e) => !categoryFilter || e.category === categoryFilter)
      .filter((e) => !monthFilter || (e.expense_date || '').slice(0, 7) === monthFilter);
  }, [expenses, search, categoryFilter, monthFilter]);

  const totalFiltered = filtered.reduce((sum, e) => sum + Number(e.amount), 0);

  // Телефон — отдельный компонент (сводка "месяц × 5 категорий" и таблица на 6 колонок в
  // 313px не помещаются), но данные, фильтры и синхронизация у него общие с компьютером.
  if (isMobile) {
    return (
      <>
        {error && <div className="error-banner">{error}</div>}
        {loading && !hasData ? (
          <div className="empty-state">Загрузка...</div>
        ) : (
          <ExpensesMobile
            months={months}
            categories={categories}
            filtered={filtered}
            filteredTotal={totalFiltered}
            search={search}
            categoryFilter={categoryFilter}
            monthFilter={monthFilter}
            onSearch={setSearch}
            onCategory={setCategoryFilter}
            onMonth={setMonthFilter}
            loading={loading}
            isOnline={isOnline}
            syncing={syncing}
            syncMessage={syncMessage}
            syncWarnings={syncWarnings}
            syncError={syncError}
          />
        )}
      </>
    );
  }

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Расходы</h1>
        <div className="sync-status">
          {syncing ? 'Обновляем из гугл-таблицы…' : 'Гугл-таблица, лист «Бизнес» — обновляется при открытии страницы'}
        </div>
      </div>

      {(syncMessage || syncWarnings.length > 0 || syncError) && (
        <div className="expenses-sync-notes">
          {syncMessage && <div className="report-upload-success">{syncMessage}</div>}
          {syncWarnings.map((w) => (
            <div key={w} className="expenses-sync-warning">{w}</div>
          ))}
          {syncError && <div className="error-banner">{syncError}</div>}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div style={{ opacity: (loading && hasData) || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
      <div className="section-title">По месяцам</div>
      <div className="card">
        {months.length === 0 ? (
          <div className="empty-state">Пока нет данных — расходы подтянутся из гугл-таблицы</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Месяц</th>
                  {categories.map((c) => (
                    <th key={c} className="num">{c}</th>
                  ))}
                  <th className="num">СУММА РАСХОДОВ</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    <td>{formatMonthLabel(m.month)}</td>
                    {categories.map((c) => (
                      <td key={c} className="num">{m.byCategory[c] ? formatMoney(m.byCategory[c]) : '—'}</td>
                    ))}
                    <td className="num expenses-total-cell">{formatMoney(m.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section-title">Все расходы</div>
      <div className="batches-toolbar">
        <input
          className="toolbar-input"
          type="text"
          placeholder="Поиск по названию..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="toolbar-select"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">Все категории</option>
          {listCategories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          className="toolbar-select"
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
        >
          <option value="">Все месяцы</option>
          {availableMonths.map((m) => (
            <option key={m} value={m}>{formatMonthLabel(m)}</option>
          ))}
        </select>
      </div>

      <div className="card">
        {loading && !hasData ? (
          <div className="empty-state">Загрузка...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Ничего не найдено</div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Название</th>
                    <th>Категория</th>
                    <th>Источник</th>
                    <th className="num">Сумма</th>
                    <th>Кто</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDateDMY(e.expense_date)}</td>
                      <td>{e.name || '—'}</td>
                      <td>{e.category || '—'}</td>
                      <td>{e.source || '—'}</td>
                      <td className="num">{formatMoney(e.amount)}</td>
                      <td className="batch-note-cell">{e.comment || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="expenses-total">
              Итого по отфильтрованному списку: <strong>{formatMoney(totalFiltered)}</strong> ({formatRecords(filtered.length)})
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
