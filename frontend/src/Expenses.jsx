import React, { useEffect, useMemo, useState } from 'react';
import { fetchExpenses, fetchExpensesMonthly, syncExpenses } from './api.js';
import { formatMoney, formatMonthLabel, formatDateDMY } from './dateUtils.js';

export default function Expenses({ password }) {
  const [expenses, setExpenses] = useState([]);
  const [months, setMonths] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState('');

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
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSync() {
    setSyncing(true);
    setSyncMessage('');
    setError('');
    syncExpenses(password)
      .then((res) => {
        setSyncMessage(`Обновлено расходов: ${res.processed}`);
        loadData();
      })
      .catch((err) => setError(err.message))
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

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Расходы</h1>
      </div>

      <div className="card">
        <div className="report-upload-row">
          <div>
            <div className="report-upload-title">Синхронизация с Google Таблицей</div>
            <div className="report-upload-hint">
              Данные подтягиваются напрямую из листа «Расход» вашей гугл-таблицы. Нажмите «Обновить», чтобы подтянуть свежие записи —
              вся таблица расходов на сайте перезапишется тем, что сейчас есть в гугл-таблице.
            </div>
          </div>
          <button className={`primary-button report-upload-btn${syncing ? ' disabled' : ''}`} onClick={handleSync} disabled={syncing}>
            {syncing ? 'Обновляем...' : 'Обновить из Google Таблицы'}
          </button>
        </div>
        {syncMessage && <div className="report-upload-success">{syncMessage}</div>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="section-title">По месяцам</div>
      <div className="card">
        {months.length === 0 ? (
          <div className="empty-state">Пока нет данных — нажмите «Обновить из Google Таблицы» выше</div>
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
        {loading ? (
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
                    <th>Комментарий</th>
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
              Итого по отфильтрованному списку: <strong>{formatMoney(totalFiltered)}</strong> ({filtered.length} записей)
            </div>
          </>
        )}
      </div>
    </div>
  );
}
