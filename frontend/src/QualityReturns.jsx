import React, { useCallback, useEffect, useState } from 'react';
import {
  addQualityReturn,
  fetchQualityReturns,
  saveQualityMetricSnapshot,
  updateQualityReturn,
} from './api.js';
import CopyableOrderNumber from './CopyableOrderNumber.jsx';
import { useAppRefresh } from './useAppRefresh.js';

function formatDate(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

function formatMoney(value) {
  return `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₸`;
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function pluralReturns(value) {
  const number = Math.abs(Number(value));
  const last = number % 10;
  const lastTwo = number % 100;
  if (last === 1 && lastTwo !== 11) return `${number} возврат`;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${number} возврата`;
  return `${number} возвратов`;
}

export default function QualityReturns({ password, active = true, isOnline = true, onOpenReport }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingOrder, setSavingOrder] = useState(null);
  const [showReconcile, setShowReconcile] = useState(false);
  const [issuedInput, setIssuedInput] = useState('');
  const [periodEndInput, setPeriodEndInput] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newReturn, setNewReturn] = useState({
    order_number: '', return_date: '', product_name: '', amount: '', reason: '',
  });
  const refreshTick = useAppRefresh(active);

  const loadData = useCallback(() => {
    setLoading(true);
    setError('');
    fetchQualityReturns(password)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [password]);

  useEffect(() => {
    if (active) loadData();
  }, [active, loadData, refreshTick]);

  function saveReturn(item, patch) {
    setSavingOrder(item.order_number);
    setError('');
    updateQualityReturn(password, item.order_number, {
      counts_as_quality: item.counts_as_quality,
      reason: item.reason || null,
      ...patch,
    })
      .then(loadData)
      .catch((err) => setError(err.message))
      .finally(() => setSavingOrder(null));
  }

  function openReconcile() {
    setIssuedInput(String(data.summary.issued_orders || ''));
    setPeriodEndInput(data.period.end);
    setShowReconcile(true);
  }

  function submitReconcile(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    saveQualityMetricSnapshot(password, {
      period_end: periodEndInput,
      issued_orders: Number(issuedInput),
    }).then(() => {
      setShowReconcile(false);
      loadData();
    }).catch((err) => {
      setError(err.message);
      setLoading(false);
    });
  }

  function submitNewReturn(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    addQualityReturn(password, { ...newReturn, amount: Number(newReturn.amount || 0) })
      .then(() => {
        setShowAdd(false);
        setNewReturn({ order_number: '', return_date: '', product_name: '', amount: '', reason: '' });
        loadData();
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }

  if (loading && !data) return <div className="empty-state">Считаю возвраты…</div>;
  if (!data) return <div className="error-banner">{error || 'Не удалось загрузить данные'}</div>;

  const { summary, period, returns, products, expiry_schedule: expirySchedule } = data;
  const stale = !data.data_through || data.data_through < period.end;
  const progress = Math.min(100, (summary.rate / data.rules.limit_percent) * 100);

  return (
    <div className={`quality-page${loading || !isOnline ? ' is-dimmed' : ''}`}>
      <div className="app-header quality-header">
        <div>
          <h1 className="app-title">Возвраты</h1>
          <div className="quality-subtitle">Контроль возвратов по качеству по правилам Kaspi</div>
        </div>
        <div className="quality-header-actions">
          <button className="sync-button" onClick={openReconcile} disabled={loading || !isOnline}>Сверить с Kaspi</button>
          <button className="sync-button" onClick={loadData} disabled={loading || !isOnline}>
            {loading ? 'Обновляю…' : 'Обновить'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showReconcile && (
        <form className="quality-inline-form" onSubmit={submitReconcile}>
          <div><label>Последний день периода</label><input type="date" required value={periodEndInput} onChange={(e) => setPeriodEndInput(e.target.value)} /></div>
          <div><label>Выдано заказов</label><input type="number" min="0" required value={issuedInput} onChange={(e) => setIssuedInput(e.target.value)} /></div>
          <button className="sync-button" type="submit">Сохранить</button>
          <button className="sync-button" type="button" onClick={() => setShowReconcile(false)}>Отмена</button>
          <p>Возьмите дату и число из формулы на странице «Возвраты по качеству» в кабинете Kaspi.</p>
        </form>
      )}

      {stale && (
        <div className="quality-data-warning">
          <div>
            <b>Нужна свежая детализация Kaspi Pay.</b>
            <span>
              Данные загружены по {formatDate(data.data_through)}, а показатель нужен по {formatDate(period.end)}.
            </span>
          </div>
          {onOpenReport && <button onClick={onOpenReport}>Перейти в отчёт</button>}
        </div>
      )}

      <section className={`quality-hero quality-hero-${summary.state}`}>
        <div className="quality-hero-main">
          <div className="quality-kicker">Показатель за {formatDate(period.start)}–{formatDate(period.end)}</div>
          <div className="quality-rate-row">
            <strong>{formatPercent(summary.rate)}</strong>
            <span className={`quality-state quality-state-${summary.state}`}>{summary.state_label}</span>
          </div>
          <div className="quality-formula">
            {pluralReturns(summary.quality_returns)} из {summary.issued_orders.toLocaleString('ru-RU')} выданных заказов
          </div>
          <div className="quality-progress" aria-label={`Заполнено ${Math.round(progress)}% до лимита`}>
            <div style={{ width: `${progress}%` }} />
            <span>0%</span><span>лимит 2%</span>
          </div>
        </div>
        <div className="quality-hero-aside">
          <span>Запас до лимита</span>
          <strong>{pluralReturns(summary.capacity)}</strong>
          <small>
            Ещё один возврат: примерно {formatPercent(summary.projected_rate_one_more)}
          </small>
        </div>
      </section>

      <div className="quality-advice-grid">
        <section className="quality-advice quality-advice-primary">
          <div className="quality-advice-icon" aria-hidden="true">✓</div>
          <div>
            <h2>Когда принимать возврат</h2>
            <p>
              Сразу после проверки товара и обязательно до срока в заявке. Kaspi запрещает намеренно
              затягивать решение ради показателя — просрочка всё равно приведёт к автоматическому возврату.
            </p>
          </div>
        </section>
        <section className="quality-advice">
          <div className="quality-advice-icon quality-advice-icon-blue" aria-hidden="true">↘</div>
          <div>
            <h2>Когда доля снизится сама</h2>
            {expirySchedule.length > 0 ? (
              <p>
                Ближайшее улучшение ожидается <b>{formatDate(expirySchedule[0].date)}</b> — из 30‑дневного
                окна выйдет {pluralReturns(expirySchedule[0].count)}. Это прогноз, а не повод задерживать решение.
              </p>
            ) : <p>В текущем окне нет возвратов, которым скоро исполнится 30 дней.</p>}
          </div>
        </section>
      </div>

      <div className="quality-columns">
        <section className="quality-panel">
          <div className="quality-panel-heading">
            <div>
              <h2>Возвраты в расчёте</h2>
              <p>Kaspi Pay не передаёт причину — сверяйте её с кабинетом Kaspi.</p>
            </div>
            <div className="quality-panel-tools">
              {data.needs_review > 0 && <em>{data.needs_review} нужно сверить</em>}
              <button onClick={() => setShowAdd((value) => !value)}>+ Добавить</button>
              <span>{returns.length}</span>
            </div>
          </div>

          {showAdd && (
            <form className="quality-add-form" onSubmit={submitNewReturn}>
              <input aria-label="Номер заказа" inputMode="numeric" required placeholder="Номер заказа" value={newReturn.order_number} onChange={(e) => setNewReturn((v) => ({ ...v, order_number: e.target.value.replace(/\D/g, '') }))} />
              <input aria-label="Дата возврата" type="date" required value={newReturn.return_date} onChange={(e) => setNewReturn((v) => ({ ...v, return_date: e.target.value }))} />
              <input aria-label="Товар" required placeholder="Название товара" value={newReturn.product_name} onChange={(e) => setNewReturn((v) => ({ ...v, product_name: e.target.value }))} />
              <input aria-label="Сумма возврата" type="number" min="0" placeholder="Сумма, ₸" value={newReturn.amount} onChange={(e) => setNewReturn((v) => ({ ...v, amount: e.target.value }))} />
              <select aria-label="Причина Kaspi" required value={newReturn.reason} onChange={(e) => setNewReturn((v) => ({ ...v, reason: e.target.value }))}>
                <option value="">Причина Kaspi</option>
                {data.rules.reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
              </select>
              <button className="sync-button" type="submit">Добавить возврат</button>
            </form>
          )}

          {returns.length === 0 ? (
            <div className="quality-empty">За этот период денежных возвратов нет</div>
          ) : (
            <div className="quality-return-list">
              {returns.map((item) => (
                <article key={item.order_number} className={`quality-return${item.counts_as_quality ? '' : ' is-excluded'}`}>
                  <div className="quality-return-top">
                    <div>
                      <CopyableOrderNumber value={item.order_number} />
                      <span>{formatDate(item.return_date)}</span>
                    </div>
                    <strong>{formatMoney(item.amount)}</strong>
                  </div>
                  <div className="quality-return-product">{item.product_name || 'Товар не указан'}</div>
                  <div className="quality-return-controls">
                    <label className="quality-check">
                      <input
                        type="checkbox"
                        checked={item.counts_as_quality}
                        disabled={savingOrder === item.order_number}
                        onChange={(event) => saveReturn(item, { counts_as_quality: event.target.checked })}
                      />
                      <span>Учитывается Kaspi</span>
                    </label>
                    {!item.reviewed && <span className="quality-review-badge">Нужно сверить</span>}
                    <select
                      aria-label={`Причина возврата ${item.order_number}`}
                      value={item.reason || ''}
                      disabled={!item.counts_as_quality || savingOrder === item.order_number}
                      onChange={(event) => saveReturn(item, {
                        reason: event.target.value || null,
                        counts_as_quality: Boolean(event.target.value),
                      })}
                    >
                      <option value="">Причина не сверена</option>
                      {data.rules.reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                    </select>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="quality-conservative-note">
            Денежный возврат без подтверждённой причины не попадает в показатель. Сверьте его с
            кабинетом Kaspi и включите только одну из четырёх причин по качеству.
          </div>
        </section>

        <aside className="quality-side-stack">
          <section className="quality-panel">
            <div className="quality-panel-heading">
              <div>
                <h2>Товары под риском</h2>
                <p>С чего начать проверку карточки и качества.</p>
              </div>
            </div>
            {products.length === 0 ? <div className="quality-empty">Рисковых товаров нет</div> : products.map((product) => (
              <div className="quality-product" key={product.product_name}>
                <div><strong>{product.product_name}</strong><span>{product.quality_returns} из {product.issued_orders}</span></div>
                <div className="quality-product-bar"><i style={{ width: `${Math.min(100, (product.rate / 2) * 100)}%` }} /></div>
                <small>{formatPercent(product.rate)}</small>
              </div>
            ))}
          </section>

          <section className="quality-panel quality-rules">
            <h2>Что улучшить</h2>
            <ul>
              <li>Сверьте фото, комплектацию и характеристики карточки с реальным товаром.</li>
              <li>Проверяйте включение, комплект и корпус перед упаковкой.</li>
              <li>Разбирайте повторяющиеся причины по товару, а не только общую долю.</li>
              <li>Не просите клиента менять причину и не откладывайте законный возврат.</li>
            </ul>
          </section>
        </aside>
      </div>

      {expirySchedule.length > 1 && (
        <section className="quality-panel quality-calendar">
          <div className="quality-panel-heading">
            <div><h2>Как будет разгружаться 30‑дневное окно</h2><p>Дата, когда событие перестанет отображаться в утреннем показателе.</p></div>
          </div>
          <div className="quality-calendar-row">
            {expirySchedule.map((item) => (
              <div key={item.date}><strong>{formatDate(item.date)}</strong><span>−{pluralReturns(item.count)}</span></div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
