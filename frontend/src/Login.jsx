import React, { useState } from 'react';
import { login } from './api.js';

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Введите логин и пароль');
      return;
    }
    setError('');
    setLoading(true);
    login(username.trim(), password.trim())
      .then((res) => onSuccess(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  return (
    <div className="login-screen">
      <form className="login-box" onSubmit={handleSubmit}>
        <h1>Продажи Kaspi</h1>
        <p>Войдите, чтобы открыть дашборд</p>
        <input
          type="text"
          placeholder="Логин"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
        />
        <input
          type={showPassword ? 'text' : 'password'}
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label className="login-show-password">
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(e) => setShowPassword(e.target.checked)}
          />
          <span>Показать пароль</span>
        </label>
        {error && <p style={{ color: '#ff6b6b', fontSize: 13, marginBottom: 12 }}>{error}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Входим...' : 'Войти'}</button>
      </form>
    </div>
  );
}
