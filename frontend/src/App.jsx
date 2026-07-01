import React, { useState } from 'react';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';

export default function App() {
  // Пароль храним только в sessionStorage: он живёт пока открыта вкладка браузера,
  // и пропадает при закрытии — так не нужно вводить пароль на каждое обновление страницы,
  // но он не остаётся навсегда на чужом компьютере.
  const [password, setPassword] = useState(() => sessionStorage.getItem('dashboard_password') || '');

  function handleLogin(pw) {
    sessionStorage.setItem('dashboard_password', pw);
    setPassword(pw);
  }

  function handleLogout() {
    sessionStorage.removeItem('dashboard_password');
    setPassword('');
  }

  if (!password) {
    return <Login onSuccess={handleLogin} />;
  }

  return <Dashboard password={password} onLogout={handleLogout} />;
}
