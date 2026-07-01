import React, { useState } from 'react';

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (!password.trim()) {
      setError('Введите пароль');
      return;
    }
    setError('');
    onSuccess(password.trim());
  }

  return (
    <div className="login-screen">
      <form className="login-box" onSubmit={handleSubmit}>
        <h1>Продажи Kaspi</h1>
        <p>Введите пароль для доступа к дашборду</p>
        <input
          type="password"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <p style={{ color: '#ff6b6b', fontSize: 13, marginBottom: 12 }}>{error}</p>}
        <button type="submit">Войти</button>
      </form>
    </div>
  );
}
