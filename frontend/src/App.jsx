import React, { useEffect, useState } from 'react';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';
import { fetchMe, logout as apiLogout } from './api.js';

function loadSession() {
  const token = localStorage.getItem('auth_token');
  const username = localStorage.getItem('auth_username');
  const role = localStorage.getItem('auth_role');
  if (token && username && role) return { token, username, role };
  return null;
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [checking, setChecking] = useState(Boolean(loadSession()));

  useEffect(() => {
    const existing = loadSession();
    if (!existing) {
      setChecking(false);
      return;
    }
    // Проверяем, что сохранённый токен ещё действителен (например, его не удалил админ) —
    // без этого при недействительном токене все запросы просто будут молча падать с 401.
    fetchMe(existing.token)
      .catch(() => {
        clearSession();
        setSession(null);
      })
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearSession() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_username');
    localStorage.removeItem('auth_role');
  }

  function handleLogin({ token, username, role }) {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_username', username);
    localStorage.setItem('auth_role', role);
    setSession({ token, username, role });
  }

  function handleLogout() {
    if (session) {
      apiLogout(session.token).catch(() => {});
    }
    clearSession();
    setSession(null);
  }

  if (checking) {
    // Раньше здесь был return null — при "холодном" старте бэкенда (например, Render после
    // долгой паузы просыпается по 10-30 секунд) это превращалось в пустой тёмный экран без
    // всякой обратной связи. Показываем тот же спиннер, что и на самом первом экране загрузки
    // (до подключения React), чтобы не было ощущения, что сайт завис.
    return (
      <div className="boot-loader-fallback">
        <div className="boot-spinner" />
        <div>
          <div className="boot-label">Sabr🤌🏻</div>
          <div className="boot-sublabel">Идёт загрузка...</div>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Login onSuccess={handleLogin} />;
  }

  return (
    <Dashboard
      password={session.token}
      username={session.username}
      role={session.role}
      onLogout={handleLogout}
    />
  );
}
