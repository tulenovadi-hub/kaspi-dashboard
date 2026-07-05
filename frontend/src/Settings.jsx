import React, { useEffect, useState } from 'react';
import { fetchUsers, createUser, updateUser, deleteUser } from './api.js';

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

export default function Settings({ password, username }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function loadUsers() {
    setLoading(true);
    setError('');
    fetchUsers(password)
      .then((res) => setUsers(res.users))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div className="card">
        {loading ? (
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
    </div>
  );
}
