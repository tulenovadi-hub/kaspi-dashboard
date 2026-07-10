import React, { useState } from 'react';
import { fetchAnalystReport } from './api.js';
import { toISODate, daysAgo, startOfMonth } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';

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

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  function handleGenerate() {
    setLoading(true);
    setError('');
    setReport('');
    fetchAnalystReport(password, from, to)
      .then((res) => setReport(res.report))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
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

      <div className="report-note">
        Отчёт формируется через Claude (Anthropic) на основе тех же данных, что видны на остальных страницах
        сайта — ничего дополнительно вводить не нужно. Себестоимость товаров в этом отчёте оценивается
        приблизительно (по цене последней поставки), без точного FIFO-расчёта — этого достаточно, чтобы увидеть
        общую картину по марже, но для точных цифр смотрите «Отчёт» и «Заказы». Каждое нажатие «Сформировать
        отчёт» расходует токены API — учитывайте это при частом использовании.
      </div>
    </div>
  );
}
