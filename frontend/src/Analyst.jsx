import React, { useEffect, useState } from 'react';
import { fetchAnalystReport, fetchAnalystReportsList, fetchAnalystReportById, deleteAnalystReport } from './api.js';
import { toISODate, daysAgo, startOfMonth, formatDateDMY } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Простой рендер markdown-ответа Claude в JSX — без внешних библиотек, покрывает то, что
// реально встречается в таком отчёте: заголовки (# ## ###), жирный текст (**...**),
// маркированные списки (- / *) и обычные абзацы.
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>;
  });
}

function MarkdownReport({ text }) {
  const lines = text.split('\n');
  const blocks = [];
  let listBuffer = [];

  function flushList(key) {
    if (listBuffer.length > 0) {
      blocks.push(
        <ul key={`list-${key}`} style={{ margin: '4px 0 14px', paddingLeft: 20 }}>
          {listBuffer.map((item, i) => (
            <li key={i} style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>{renderInline(item, `li-${key}-${i}`)}</li>
          ))}
        </ul>
      );
      listBuffer = [];
    }
  }

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) {
      flushList(idx);
      return;
    }
    const headerMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (headerMatch) {
      flushList(idx);
      const level = headerMatch[1].length;
      const style = level === 1
        ? { fontSize: 18, fontWeight: 700, margin: '20px 0 8px' }
        : level === 2
          ? { fontSize: 16, fontWeight: 700, margin: '18px 0 6px', color: 'var(--accent-brand)' }
          : { fontSize: 14, fontWeight: 700, margin: '14px 0 4px' };
      blocks.push(<div key={idx} style={style}>{renderInline(headerMatch[2], `h-${idx}`)}</div>);
      return;
    }
    const listMatch = line.match(/^[-*]\s+(.*)/);
    if (listMatch) {
      listBuffer.push(listMatch[1]);
      return;
    }
    flushList(idx);
    blocks.push(
      <p key={idx} style={{ margin: '0 0 12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {renderInline(line, `p-${idx}`)}
      </p>
    );
  });
  flushList('end');

  return <div>{blocks}</div>;
}

export default function Analyst({ password }) {
  const [from, setFrom] = useState(() => toISODate(startOfMonth()));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('month');
  const [report, setReport] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // История сохранённых отчётов — каждый успешно сгенерированный отчёт сохраняется на бэкенде
  // сам по себе (см. POST .../analyst/report), здесь только подгружаем список и умеем открыть/удалить.
  const [savedReports, setSavedReports] = useState([]);
  const [reportsError, setReportsError] = useState('');
  const [selectedReportId, setSelectedReportId] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  function loadSavedReports() {
    fetchAnalystReportsList(password)
      .then((res) => setSavedReports(res.reports))
      .catch((err) => setReportsError(err.message));
  }

  useEffect(() => {
    loadSavedReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  function handleGenerate() {
    setLoading(true);
    setError('');
    setReport('');
    setSelectedReportId(null);
    fetchAnalystReport(password, from, to)
      .then((res) => {
        if (!res.report) {
          setError('AI вернул пустой ответ. Попробуйте сформировать отчёт ещё раз.');
        } else {
          setReport(res.report);
          setSelectedReportId(res.id);
          setSavedReports((prev) => [{ id: res.id, period_from: from, period_to: to, created_at: res.created_at }, ...prev]);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  function handleOpenSaved(id) {
    setOpeningId(id);
    setError('');
    fetchAnalystReportById(password, id)
      .then((res) => {
        setReport(res.report_text);
        setSelectedReportId(res.id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setOpeningId(null));
  }

  function handleDeleteSaved(id, e) {
    e.stopPropagation();
    if (!window.confirm('Удалить этот отчёт?')) return;
    setDeletingId(id);
    deleteAnalystReport(password, id)
      .then(() => {
        setSavedReports((prev) => prev.filter((r) => r.id !== id));
        if (selectedReportId === id) {
          setReport('');
          setSelectedReportId(null);
        }
      })
      .catch((err) => setReportsError(err.message))
      .finally(() => setDeletingId(null));
  }

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">AI <span>Финансист</span></h1>
      </div>

      <PeriodSelector from={from} to={to} activePreset={presetKey} onChange={handlePeriodChange} />

      <div className="batches-toolbar">
        <button className="sync-button" onClick={handleGenerate} disabled={loading}>
          {loading ? 'Анализирую данные (может занять минуту)...' : 'Сформировать отчёт'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!report && !loading && !error && (
        <div className="empty-state">
          Нажмите «Сформировать отчёт» — ИИ изучит помесячный отчёт, продажи по товарам, склад, рекламу и расходы
          за выбранный период, и даст короткую сводку с рекомендациями: какие товары наименее маржинальны,
          какую рекламу стоит отключить, где зависли остатки и с чего начать в первую очередь.
        </div>
      )}

      {report && (
        <div className="card" style={{ padding: 24 }}>
          <MarkdownReport text={report} />
        </div>
      )}

      <div className="section-title">История отчётов</div>
      <div className="card">
        {reportsError && <div className="error-banner">{reportsError}</div>}
        {savedReports.length === 0 ? (
          <div className="empty-state">Сохранённых отчётов пока нет</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Период</th>
                  <th>Сформирован</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {savedReports.map((r) => (
                  <tr key={r.id} className="batch-row" onClick={() => handleOpenSaved(r.id)}>
                    <td>{formatDateDMY(r.period_from)} – {formatDateDMY(r.period_to)}</td>
                    <td>{formatDateTime(r.created_at)}{openingId === r.id ? ' — открываю...' : ''}</td>
                    <td className="num">
                      <button
                        className="batch-delete"
                        onClick={(e) => handleDeleteSaved(r.id, e)}
                        disabled={deletingId === r.id}
                        title="Удалить отчёт"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-note">
        Отчёт формируется через Claude (Anthropic) на основе тех же данных, что видны на остальных страницах
        сайта — ничего дополнительно вводить не нужно. Себестоимость товаров в этом отчёте оценивается
        приблизительно (по цене последней поставки), без точного FIFO-расчёта — этого достаточно, чтобы увидеть
        общую картину по марже, но для точных цифр смотрите «Отчёт» и «Заказы». Каждое нажатие «Сформировать
        отчёт» расходует токены API — учитывайте это при частом использовании. Каждый сформированный отчёт
        сохраняется — «История отчётов» ниже позволяет открыть его позже без повторной генерации и удалить,
        если больше не нужен.
      </div>
    </div>
  );
}
