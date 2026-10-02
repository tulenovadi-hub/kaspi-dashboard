import React, { useEffect, useState } from 'react';
import {
  fetchKaspiGatewayTokens,
  fetchKaspiGatewayLogs,
  createKaspiGatewayToken,
  updateKaspiGatewayToken,
  rotateKaspiGatewayToken,
} from './api.js';

function formatDate(value) {
  if (!value) return 'никогда';
  return new Date(value).toLocaleString('ru-RU');
}

function CopyButton({ value, label = 'Копировать' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      window.prompt('Скопируйте значение:', value);
    }
  }

  return (
    <button className={`sync-button gateway-copy-button${copied ? ' is-copied' : ''}`} type="button" onClick={copy}>
      <span className="gateway-copy-label">{copied ? 'Скопировано' : label}</span>
      <span className="gateway-copy-check" aria-hidden="true">✓</span>
    </button>
  );
}

function SecretPanel({ secret, onClose }) {
  if (!secret) return null;
  return (
    <div className="gateway-secret-panel">
      <div>
        <strong>Сохраните токен сейчас</strong>
        <p>После закрытия он больше не будет показан. В базе хранится только его необратимый хеш.</p>
      </div>
      <div className="gateway-secret-value">
        <code>{secret}</code>
        <CopyButton value={secret} label="Копировать токен" />
        <button className="secondary-button" type="button" onClick={onClose}>Я сохранил</button>
      </div>
    </div>
  );
}

function TokenRow({ password, item, onChanged, onSecret }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({
    name: item.name,
    access_level: item.access_level,
    rate_limit_per_minute: item.rate_limit_per_minute,
    allowed_ips: (item.allowed_ips || []).join(', '),
    expires_in_days: 'keep',
  });

  const expired = item.expires_at && new Date(item.expires_at).getTime() <= Date.now();
  const status = !item.enabled ? 'Отключён' : expired ? 'Истёк' : 'Активен';

  function update(values) {
    setSaving(true);
    setError('');
    return updateKaspiGatewayToken(password, item.id, values)
      .then(() => {
        onChanged();
        return true;
      })
      .catch((err) => {
        setError(err.message);
        return false;
      })
      .finally(() => setSaving(false));
  }

  function save() {
    const values = {
      name: draft.name.trim(),
      access_level: draft.access_level,
      rate_limit_per_minute: Number(draft.rate_limit_per_minute),
      allowed_ips: draft.allowed_ips.split(/[\s,;]+/).filter(Boolean),
    };
    if (draft.expires_in_days !== 'keep') {
      values.expires_in_days = draft.expires_in_days === 'none' ? null : Number(draft.expires_in_days);
    }
    update(values).then((ok) => {
      if (ok) setEditing(false);
    });
  }

  function rotate() {
    if (!window.confirm(`Перевыпустить токен «${item.name}»? Старый токен сразу перестанет работать.`)) return;
    setSaving(true);
    setError('');
    rotateKaspiGatewayToken(password, item.id)
      .then((response) => {
        onSecret(response.token);
        onChanged();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <div className="gateway-token-row">
      <div className="gateway-token-heading">
        <div>
          <strong>{item.name}</strong>
          <code>{item.token_hint}</code>
        </div>
        <div className="gateway-token-badges">
          <span className={`gateway-status gateway-status-${status === 'Активен' ? 'active' : 'inactive'}`}>{status}</span>
          <span className="gateway-access">{item.access_level === 'read' ? 'Только чтение' : 'Полный доступ'}</span>
        </div>
      </div>

      <div className="gateway-token-meta">
        <span>Запросов: <strong>{Number(item.request_count || 0).toLocaleString('ru-RU')}</strong></span>
        <span>Последний: <strong>{formatDate(item.last_used_at)}</strong></span>
        <span>Истекает: <strong>{item.expires_at ? formatDate(item.expires_at) : 'без срока'}</strong></span>
        <span>Лимит: <strong>{item.rate_limit_per_minute}/мин</strong></span>
        <span>IP: <strong>{(item.allowed_ips || []).length ? item.allowed_ips.join(', ') : 'любой'}</strong></span>
      </div>

      {editing && (
        <div className="gateway-edit-grid">
          <div className="batch-form-field">
            <label>Название</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="batch-form-field">
            <label>Доступ</label>
            <select className="product-select" value={draft.access_level} onChange={(e) => setDraft({ ...draft, access_level: e.target.value })}>
              <option value="read">Только чтение</option>
              <option value="full">Полный доступ с редактированием</option>
            </select>
          </div>
          <div className="batch-form-field">
            <label>Запросов в минуту</label>
            <input type="number" min="1" max="1000" value={draft.rate_limit_per_minute} onChange={(e) => setDraft({ ...draft, rate_limit_per_minute: e.target.value })} />
          </div>
          <div className="batch-form-field">
            <label>Срок действия</label>
            <select className="product-select" value={draft.expires_in_days} onChange={(e) => setDraft({ ...draft, expires_in_days: e.target.value })}>
              <option value="keep">Не менять</option>
              <option value="7">Продлить на 7 дней</option>
              <option value="30">Продлить на 30 дней</option>
              <option value="90">Продлить на 90 дней</option>
              <option value="365">Продлить на 1 год</option>
              <option value="none">Убрать срок</option>
            </select>
          </div>
          <div className="batch-form-field gateway-ip-field">
            <label>Разрешённые IP</label>
            <input placeholder="Пусто — любой IP" value={draft.allowed_ips} onChange={(e) => setDraft({ ...draft, allowed_ips: e.target.value })} />
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      <div className="gateway-token-actions">
        {editing ? (
          <>
            <button className="primary-button" type="button" disabled={saving} onClick={save}>Сохранить</button>
            <button className="secondary-button" type="button" disabled={saving} onClick={() => setEditing(false)}>Отмена</button>
          </>
        ) : (
          <button className="secondary-button" type="button" disabled={saving} onClick={() => setEditing(true)}>Изменить</button>
        )}
        <button className="sync-button" type="button" disabled={saving || expired} onClick={() => update({ enabled: !item.enabled })}>
          {item.enabled ? 'Отключить' : 'Включить'}
        </button>
        <button className="sync-button" type="button" disabled={saving} onClick={rotate}>Перевыпустить</button>
      </div>
    </div>
  );
}

export default function KaspiGatewaySettings({ password, active = true, isOnline = true }) {
  const [tokens, setTokens] = useState([]);
  const [logs, setLogs] = useState([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    access_level: 'read',
    expires_in_days: '90',
    rate_limit_per_minute: '60',
    allowed_ips: '',
  });

  function load() {
    if (!active) return Promise.resolve();
    setLoading(true);
    setError('');
    return Promise.all([fetchKaspiGatewayTokens(password), fetchKaspiGatewayLogs(password)])
      .then(([tokensResponse, logsResponse]) => {
        setTokens(tokensResponse.tokens || []);
        setBaseUrl(tokensResponse.base_url || '');
        setLogs(logsResponse.logs || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function create(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    createKaspiGatewayToken(password, {
      ...form,
      expires_in_days: form.expires_in_days === '' ? null : Number(form.expires_in_days),
      rate_limit_per_minute: Number(form.rate_limit_per_minute),
      allowed_ips: form.allowed_ips.split(/[\s,;]+/).filter(Boolean),
    })
      .then((response) => {
        setSecret(response.token);
        setForm({ ...form, name: '' });
        return load();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <>
      <div className="section-title">Шлюз Kaspi API</div>
      <div className="card gateway-card" style={{ opacity: !isOnline ? 0.55 : 1 }}>
        <div className="order-exclusion-intro">
          Выдаёт сторонним сервисам отдельные отзывные токены. Настоящий токен Kaspi хранится только на сервере,
          а ответы передаются без изменения и без скрытия данных.
        </div>

        <div className="gateway-usage-note">
          В стороннем сервисе замените адрес <code>https://kaspi.kz/shop/api/v2</code> на адрес ниже,
          а созданный токен передавайте в стандартном заголовке <code>X-Auth-Token</code>. Остальные пути и параметры запросов не меняются.
        </div>

        {baseUrl && (
          <div className="gateway-base-url">
            <div>
              <span>Базовый адрес API</span>
              <code>{baseUrl}</code>
            </div>
            <CopyButton value={baseUrl} label="Копировать адрес" />
          </div>
        )}

        <SecretPanel secret={secret} onClose={() => setSecret('')} />
        {error && <div className="error-banner">{error}</div>}

        <form className="gateway-create-form" onSubmit={create}>
          <div className="batch-form-field">
            <label>Название доступа</label>
            <input placeholder="Например, сервис аналитики" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength="2" maxLength="80" required />
          </div>
          <div className="batch-form-field">
            <label>Права</label>
            <select className="product-select" value={form.access_level} onChange={(e) => setForm({ ...form, access_level: e.target.value })}>
              <option value="read">Только чтение</option>
              <option value="full">Полный доступ с редактированием</option>
            </select>
          </div>
          {form.access_level === 'full' && (
            <div className="gateway-full-warning">
              Полный доступ позволяет стороннему сервису менять статусы заказов и другие данные Kaspi.
            </div>
          )}
          <div className="batch-form-field">
            <label>Срок действия</label>
            <select className="product-select" value={form.expires_in_days} onChange={(e) => setForm({ ...form, expires_in_days: e.target.value })}>
              <option value="7">7 дней</option>
              <option value="30">30 дней</option>
              <option value="90">90 дней</option>
              <option value="365">1 год</option>
              <option value="">Без срока</option>
            </select>
          </div>
          <div className="batch-form-field">
            <label>Запросов в минуту</label>
            <input type="number" min="1" max="1000" value={form.rate_limit_per_minute} onChange={(e) => setForm({ ...form, rate_limit_per_minute: e.target.value })} required />
          </div>
          <div className="batch-form-field gateway-ip-field">
            <label>Разрешённые IP — необязательно</label>
            <input placeholder="Например, 203.0.113.10, 203.0.113.11" value={form.allowed_ips} onChange={(e) => setForm({ ...form, allowed_ips: e.target.value })} />
          </div>
          <button className="primary-button" type="submit" disabled={saving || !isOnline}>
            {saving ? 'Создаём...' : '+ Создать доступ'}
          </button>
        </form>
      </div>

      <div className="section-title">Выданные доступы</div>
      <div className="card gateway-card">
        {loading ? <div className="empty-state">Загрузка...</div> : tokens.length === 0 ? (
          <div className="empty-state">Токенов ещё нет</div>
        ) : tokens.map((item) => (
          <TokenRow key={item.id} password={password} item={item} onChanged={load} onSecret={setSecret} />
        ))}
      </div>

      <div className="section-title">Последние обращения</div>
      <div className="card gateway-card">
        {logs.length === 0 ? <div className="empty-state">Запросов через шлюз ещё не было</div> : (
          <div className="table-scroll">
            <table className="product-table gateway-log-table">
              <thead><tr><th>Время</th><th>Доступ</th><th>Запрос</th><th>Ответ</th><th>IP</th><th>Время</th></tr></thead>
              <tbody>{logs.map((log) => (
                <tr key={log.id}>
                  <td>{formatDate(log.created_at)}</td>
                  <td>{log.token_name}</td>
                  <td><code>{log.method} {log.request_path}</code></td>
                  <td><span className={`gateway-http-status gateway-http-${Math.floor(log.status_code / 100)}`}>{log.status_code}</span></td>
                  <td>{log.client_ip || '—'}</td>
                  <td>{log.duration_ms} мс</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
