// ВРЕМЕННЫЙ стенд: рисует настоящую страницу на ЖИВЫХ данных продакшена.
// Токен берётся из localStorage (кладём его через консоль браузера, а не в файл), адрес
// бэкенда — из frontend/.env.local, который не коммитится. Удалить после проверки.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import AbcXyz from './AbcXyz.jsx';

const token = localStorage.getItem('dev_token') || '';

createRoot(document.getElementById('root')).render(
  <div className="layout">
    <div className="main-content">
      <div className="app app-wide">
        {token
          ? <AbcXyz password={token} />
          : <div className="error-banner">Нет токена: localStorage.setItem('dev_token', '...')</div>}
      </div>
    </div>
  </div>
);
