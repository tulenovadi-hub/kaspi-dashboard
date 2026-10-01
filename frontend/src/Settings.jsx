import React, { useEffect, useState } from 'react';
import {
  fetchUsers, createUser, updateUser, deleteUser,
  fetchOrderExclusions, excludeOrder, restoreExcludedOrder,
} from './api.js';
import { useAppRefresh } from './useAppRefresh.js';

function CreateUserForm({ password, onCreated }) {
  const [username, setUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [role, setRole] = useState('manager');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    createUser(password, { username: username.trim(), password: newPassword, role })
      .then(() => {
        setUsername('');
        setNewPassword('');
        setRole('manager');
        onCreated();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <form onSubmit={handleSubmit}>
      {error && <div className="error-banner">{error}</div>}
      <div className="batch-form-row-2">
        <div className="batch-form-field">
          <label>Логин</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            required
          />
        </div>
        <div className="batch-form-field">
          <label>Пароль</label>
          <input
            type="text"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={4}
          />
        </div>
      </div>
      <div className="batch-form-field">
        <label>Роль</label>
        <select className="product-select" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="admin">Админ — все функции сайта</option>
          <option value="manager">Менеджер — Главная, Самовыкупы, Склад</option>
          <option value="marketer">Маркетолог — Главная, Самовыкупы, Склад, Маркетинг</option>
        </select>
      </div>
      <button className="primary-button batch-submit" type="submit" disabled={saving}>
        {saving ? 'Создаём...' : '+ Создать пользователя'}
      </button>
    </form>
  );
}

function UserRow({ password, user, currentUsername, onChanged }) {
  const [newPassword, setNewPassword] = useState('');
  const [role, setRole] = useState(user.role);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isSelf = user.username === currentUsername;

  function handleRoleChange(newRole) {
    setRole(newRole);
    setSaving(true);
    setError('');
    updateUser(password, user.id, { role: newRole })
      .then(() => onChanged())
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  function handlePasswordSave() {
    if (!newPassword) return;
    setSaving(true);
    setError('');
    updateUser(password, user.id, { password: newPassword })
      .then(() => {
        setNewPassword('');
        onChanged();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  function handleDelete() {
    if (!window.confirm(`Удалить пользователя «${user.username}»?`)) return;
    deleteUser(password, user.id)
      .then(() => onChanged())
      .catch((err) => setError(err.message));
  }

  return (
    <tr>
      <td>{user.username}{isSelf && <span className="batch-field-hint"> (это вы)</span>}</td>
      <td>
        <select
          className="product-select"
          value={role}
          onChange={(e) => handleRoleChange(e.target.value)}
          disabled={saving || isSelf}
          title={isSelf ? 'Нельзя менять роль самому себе' : undefined}
        >
          <option value="admin">Админ</option>
          <option value="manager">Менеджер</option>
          <option value="marketer">Маркетолог</option>
        </select>
      </td>
      <td>
        <div className="users-password-cell">
          <input
            type="text"
            placeholder="Новый пароль"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <button className="sync-button" onClick={handlePasswordSave} disabled={saving || !newPassword}>
            Сохранить
          </button>
        </div>
        {error && <div className="batch-missing-logistics">{error}</div>}
      </td>
      <td className="num">
        <button className="batch-delete" onClick={handleDelete} disabled={isSelf} title={isSelf ? 'Нельзя удалить самого себя' : 'Удалить'}>
          ✕
        </button>
      </td>
    </tr>
  );
}

function OrderExclusions({ password, exclusions, onChanged }) {
  const [orderNumber, setOrderNumber] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function handleExclude(e) {
    e.preventDefault();
    if (!window.confirm(`Исключить заказ ${orderNumber} из склада и всех финансовых отчётов?`)) return;
    setSaving(true);
    setError('');
    excludeOrder(password, orderNumber.trim(), reason.trim())
      .then(() => {
        setOrderNumber('');
        setReason('');
        onChanged();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  function handleRestore(number) {
    if (!window.confirm(`Вернуть заказ ${number} в склад и финансовые отчёты?`)) return;
    setSaving(true);
    setError('');
    restoreExcludedOrder(password, number)
      .then(onChanged)
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  }

  const formatMoney = (value) => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₸`;

  return (
    <>
      <div className="section-title">Исключить ошибочный заказ</div>
      <div className="card">
        <div className="order-exclusion-intro">
          Используйте только когда реальной продажи вашего товара не было — например, склад отправил товар другого продавца,
          а ваш остался на месте. Обычные отмены и возвраты здесь исключать нельзя.
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form className="order-exclusion-form" onSubmit={handleExclude}>
          <div className="batch-form-field">
            <label>Номер заказа</label>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Например, 1089589665"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value.replace(/\D/g, ''))}
              required
            />
          </div>
          <div className="batch-form-field order-exclusion-reason">
            <label>Почему не учитывать</label>
            <input
              type="text"
              placeholder="Склад отправил товар другого продавца"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={5}
              required
            />
          </div>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? 'Исключаем...' : 'Не учитывать заказ'}
          </button>
        </form>
      </div>

      <div className="section-title">Не участвуют в учёте</div>
      <div className="card">
        {exclusions.length === 0 ? (
          <div className="empty-state">Исключённых заказов нет</div>
        ) : (
          <div className="order-exclusion-list">
            {exclusions.map((item) => (
              <div className="order-exclusion-row" key={item.order_number}>
                <div className="order-exclusion-main">
                  <strong>№ {item.order_number}</strong>
                  <span>{item.reason}</span>
                  <small>
                    Исключён {new Date(item.excluded_at).toLocaleString('ru-RU')}
                    {item.excluded_by ? ` · ${item.excluded_by}` : ''}
                  </small>
                </div>
                <div className="order-exclusion-impact">
                  <span>{item.summary.item_quantity} шт.</span>
                  <span>продажи {formatMoney(item.summary.purchase_amount)}</span>
                  <span>возвраты {formatMoney(item.summary.refund_amount)}</span>
                </div>
                <button className="sync-button" type="button" disabled={saving} onClick={() => handleRestore(item.order_number)}>
                  Вернуть в учёт
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default function Settings({ password, username, active = true, isOnline = true }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [error, setError] = useState('');
  const [exclusions, setExclusions] = useState([]);

  function loadUsers() {
    setLoading(true);
    setError('');
    Promise.all([fetchUsers(password), fetchOrderExclusions(password)])
      .then(([usersRes, exclusionsRes]) => {
        setUsers(usersRes.users);
        setExclusions(exclusionsRes.orders);
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
    if (active) loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshTick]);

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Настройки</h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="section-title">Новый пользователь</div>
      <div className="card">
        <CreateUserForm password={password} onCreated={loadUsers} />
      </div>

      <div className="section-title">Пользователи</div>
      <div className="card" style={{ opacity: (loading && hasData) || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        {loading && !hasData ? (
          <div className="empty-state">Загрузка...</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Логин</th>
                  <th>Роль</th>
                  <th>Сменить пароль</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.id} password={password} user={u} currentUsername={username} onChanged={loadUsers} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-note">
        Роли определяют, какие разделы сайта видит пользователь: <strong>Админ</strong> — все функции сайта; <strong>Менеджер</strong> — Главная,
        Самовыкупы, Склад; <strong>Маркетолог</strong> — Главная, Самовыкупы, Склад, Маркетинг. Создавать пользователей и менять пароли может только Админ.
      </div>

      <OrderExclusions password={password} exclusions={exclusions} onChanged={loadUsers} />
    </div>
  );
}
