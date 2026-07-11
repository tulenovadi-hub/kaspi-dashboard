import React, { useState, useEffect } from 'react';
import Sidebar, { ROLE_PAGES } from './Sidebar.jsx';
import SalesView from './SalesView.jsx';
import Batches from './Batches.jsx';
import Report from './Report.jsx';
import Warehouse from './Warehouse.jsx';
import Expenses from './Expenses.jsx';
import Orders from './Orders.jsx';
import Settings from './Settings.jsx';
import Marketing from './Marketing.jsx';
import Bonuses from './Bonuses.jsx';
import { fetchReviewBonusExpenses } from './api.js';
import Analyst from './Analyst.jsx';
import ComingSoon from './ComingSoon.jsx';

const SECTION_TITLES = {};

export default function Dashboard({ password, username, role, onLogout }) {
  const allowedPages = ROLE_PAGES[role] || ROLE_PAGES.manager;
  const [view, setView] = useState('sales'); // 'sales' | 'report' | 'selfbuy' | 'expenses' | 'batches' | 'warehouse' | 'marketing_ads' | 'marketing_bonuses' | 'marketing_reviews' | 'settings'
  const [collapsed, setCollapsed] = useState(() => sessionStorage.getItem('sidebar_collapsed') === '1');

  // Защита на случай, если роль не даёт доступа к текущему разделу (например, роль сменили
  // прямо во время работы, или view остался от предыдущей роли) — просто откатываемся на Главную.
  const safeView = allowedPages.includes(view) ? view : 'sales';

  // Раньше renderContent() каждый раз возвращал только ТЕКУЩИЙ раздел — при переходе на другую
  // страницу и возврате обратно React видел в этом месте дерева совсем другой компонент и полностью
  // пересоздавал его с нуля (все загруденные данные терялись, страница грузилась заново). Теперь
  // держим уже открывавшиеся разделы смонтированными и просто прячем неактивные через display:none —
  // так их состояние (и загруженные данные) не пропадает при переключении между разделами.
  const [visited, setVisited] = useState(() => new Set(['sales']));

  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(safeView)) return prev;
      const next = new Set(prev);
      next.add(safeView);
      return next;
    });
  }, [safeView]);

  function handleSelect(key) {
    if (allowedPages.includes(key)) {
      setView(key);
    }
  }

  function handleToggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      sessionStorage.setItem('sidebar_collapsed', next ? '1' : '0');
      return next;
    });
  }

  function renderPage(key) {
    const style = key === safeView ? undefined : { display: 'none' };

    if (key === 'batches') {
      return (
        <div key={key} style={style}>
          <Batches password={password} onClose={() => setView('sales')} />
        </div>
      );
    }

    if (key === 'report') {
      return (
        <div key={key} style={style}>
          <Report password={password} />
        </div>
      );
    }

    if (key === 'warehouse') {
      return (
        <div key={key} style={style}>
          <Warehouse password={password} />
        </div>
      );
    }

    if (key === 'expenses') {
      return (
        <div key={key} style={style}>
          <Expenses password={password} />
        </div>
      );
    }

    if (key === 'orders') {
      return (
        <div key={key} style={style}>
          <Orders password={password} />
        </div>
      );
    }

    if (key === 'settings') {
      return (
        <div key={key} style={style}>
          <Settings password={password} username={username} />
        </div>
      );
    }

    if (key === 'marketing_ads') {
      return (
        <div key={key} style={style}>
          <Marketing password={password} />
        </div>
      );
    }

    if (key === 'marketing_bonuses') {
      return (
        <div key={key} style={style}>
          <Bonuses password={password} />
        </div>
      );
    }

    if (key === 'marketing_reviews') {
      return (
        <div key={key} style={style}>
          <Bonuses
            password={password}
            fetchExpenses={fetchReviewBonusExpenses}
            subtitle="за отзыв"
            pageLabel="«Бонусы за отзыв»"
          />
        </div>
      );
    }

    if (key === 'analyst') {
      return (
        <div key={key} style={style}>
          <Analyst password={password} />
        </div>
      );
    }

    if (key === 'selfbuy') {
      return (
        <div key={key} style={style}>
          <SalesView
            password={password}
            onLogout={onLogout}
            mode="selfbuy"
            title={<>Самовыкупы <span>(Талдыкорган + Юбилейное)</span></>}
            showSync={false}
          />
        </div>
      );
    }

    if (SECTION_TITLES[key]) {
      return (
        <div key={key} style={style}>
          <ComingSoon title={SECTION_TITLES[key]} />
        </div>
      );
    }

    // key === 'sales'
    return (
      <div key={key} style={style}>
        <SalesView
          password={password}
          onLogout={onLogout}
          mode="main"
          title={<>Продажи <span>Kaspi</span></>}
          showSync
        />
      </div>
    );
  }

  return (
    <div className="layout">
      <Sidebar
        view={safeView}
        onSelect={handleSelect}
        collapsed={collapsed}
        onToggleCollapse={handleToggleCollapse}
        onLogout={onLogout}
        role={role}
      />
      <div className="main-content">
        <div className={`app${(safeView === 'orders' || safeView === 'report') ? ' app-wide' : ''}`}>
          {Array.from(visited).map((key) => renderPage(key))}
        </div>
      </div>
    </div>
  );
}
