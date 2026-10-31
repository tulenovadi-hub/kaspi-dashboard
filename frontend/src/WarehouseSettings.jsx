import React, { useEffect, useState } from 'react';
import { fetchWarehouseSettings, addWarehouse, setWarehouseRole } from './api.js';
import { useAppRefresh } from './useAppRefresh.js';

// Блок "Склады" на странице "Настройки". Владелец выбрала из двух макетов (2026-11-01) вариант с
// переключателем в каждой строке. Склад без выбранного типа и точка из заказов, которой ещё нет
// в справочнике, стоят сверху с жёлтой рамкой: пока тип не выбран, продажи склада не входят ни
// в основную статистику, ни в самовыкупы.

const ROLE_LABELS = { main: 'Реальный', selfbuy: 'Самовыкуп' };

function confirmText(city, role) {
  return role === 'main'
    ? `${city} станет реальным складом. Вся его история продаж перейдёт на «Главную» и в основной «Отчёт», склад появится на странице «Склад».`
    : `${city} станет самовыкупным. Вся его история продаж уйдёт в «Самовыкупы», склад исчезнет со страницы «Склад».`;
}

function RoleSwitch({ warehouse, disabled, onPick }) {
  return (
    <div className="wh-set-seg">
      {['main', 'selfbuy'].map((role) => (
        <button
          key={role}
          type="button"
          className={`wh-set-seg-btn ${role}`}
          aria-pressed={warehouse.role === role}
          disabled={disabled}
          onClick={() => onPick(warehouse, role)}
        >
          {ROLE_LABELS[role]}
        </button>
      ))}
    </div>
  );
}

function AddWarehouseForm({ initialCode, saving, onSubmit, onCancel }) {
  const [code, setCode] = useState(initialCode);
  const [city, setCity] = useState('');

  return (
    <form
      className="wh-set-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code, city);
      }}
    >
      <label>
        <span>Код точки</span>
        <input className="toolbar-input" value={code} placeholder="PP10" onChange={(e) => setCode(e.target.value)} required />
      </label>
      <label>
        <span>Город</span>
        <input className="toolbar-input" value={city} placeholder="Шымкент" onChange={(e) => setCity(e.target.value)} required autoFocus />
      </label>
      <div className="wh-set-actions">
        <button type="button" className="wh-set-btn" onClick={onCancel}>Отмена</button>
        <button type="submit" className="wh-set-btn primary" disabled={saving}>{saving ? 'Добавляем…' : 'Добавить'}</button>
      </div>
    </form>
  );
}

export default function WarehouseSettings({ password, active = true, isOnline = true }) {
  const [warehouses, setWarehouses] = useState([]);
  const [unknownPoints, setUnknownPoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { code, role } — смена типа ждёт подтверждения
  const [addingCode, setAddingCode] = useState(null); // null — форма закрыта

  const refreshTick = useAppRefresh(active);

  function load() {
    setLoading(true);
    return fetchWarehouseSettings(password)
      .then((res) => {
        setWarehouses(res.warehouses);
        setUnknownPoints(res.unknownPoints);
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        setLoading(false);
        setHasData(true);
      });
  }

  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshTick]);

  function saveRole(code, role) {
    setSaving(true);
    setError('');
    setWarehouseRole(password, code, role)
      .then(() => {
        setPending(null);
        return load();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  // У склада без типа историю переносить некуда, поэтому подтверждать нечего.
  function pickRole(warehouse, role) {
    if (warehouse.role === role) return;
    if (warehouse.role === null) saveRole(warehouse.code, role);
    else setPending({ code: warehouse.code, role });
  }

  function submitAdd(code, city) {
    setSaving(true);
    setError('');
    addWarehouse(password, { code, city })
      .then(() => {
        setAddingCode(null);
        return load();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  const fresh = warehouses.filter((w) => w.role === null);
  const known = warehouses.filter((w) => w.role !== null);

  return (
    <>
      <div className="section-title">Склады</div>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ opacity: (loading && hasData) || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        {loading && !hasData ? (
          <div className="card"><div className="empty-state">Загрузка...</div></div>
        ) : (
          <div className="wh-set-list">
            {unknownPoints.map((point) => (
              <div className="wh-set-row is-new" key={point.code}>
                <div className="wh-set-head">
                  <span className="wh-set-city">Новая точка</span>
                  <span className="wh-set-code">{point.code} · заказов: {point.orders_count}</span>
                </div>
                <button type="button" className="wh-set-btn" onClick={() => setAddingCode(point.code)}>Добавить склад</button>
              </div>
            ))}

            {fresh.map((warehouse) => (
              <div className="wh-set-row is-new" key={warehouse.code}>
                <div className="wh-set-head">
                  <span className="wh-set-city">{warehouse.city}</span>
                  <span className="wh-set-code">{warehouse.code} · заказов: {warehouse.orders_count}</span>
                </div>
                <div className="wh-set-hint">Новый склад. Выберите тип, пока его продажи нигде не считаются.</div>
                <div className="wh-set-actions">
                  <button type="button" className="wh-set-btn" disabled={saving} onClick={() => pickRole(warehouse, 'main')}>Реальный</button>
                  <button type="button" className="wh-set-btn" disabled={saving} onClick={() => pickRole(warehouse, 'selfbuy')}>Самовыкуп</button>
                </div>
              </div>
            ))}

            {known.map((warehouse) => (
              <div className="wh-set-row" key={warehouse.code}>
                <div className="wh-set-line">
                  <div className="wh-set-head">
                    <span className="wh-set-city">{warehouse.city}</span>
                    <span className="wh-set-code">{warehouse.code}</span>
                  </div>
                  <RoleSwitch warehouse={warehouse} disabled={saving} onPick={pickRole} />
                </div>
                {pending?.code === warehouse.code && (
                  <div className="wh-set-confirm">
                    {confirmText(warehouse.city, pending.role)}
                    <div className="wh-set-actions">
                      <button type="button" className="wh-set-btn" onClick={() => setPending(null)}>Отмена</button>
                      <button type="button" className="wh-set-btn primary" disabled={saving} onClick={() => saveRole(warehouse.code, pending.role)}>
                        {saving ? 'Сохраняем…' : 'Подтвердить'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {addingCode === null ? (
              <button type="button" className="wh-set-btn" onClick={() => setAddingCode('')}>+ Добавить склад</button>
            ) : (
              <div className="wh-set-row">
                <AddWarehouseForm
                  key={addingCode}
                  initialCode={addingCode}
                  saving={saving}
                  onSubmit={submitAdd}
                  onCancel={() => setAddingCode(null)}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="report-note">
        Реальный склад хранит товар: он виден на «Складе», его продажи идут на «Главную» и в основной «Отчёт».
        Самовыкупной считается только на странице «Самовыкупы». Код точки виден в заказе Kaspi.
      </div>
    </>
  );
}
