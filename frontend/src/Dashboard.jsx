import React, { useState } from 'react';
import Sidebar, { ROLE_PAGES } from './Sidebar.jsx';
import SalesView from './SalesView.jsx';
import Batches from './Batches.jsx';
import Report from './Report.jsx';
import Warehouse from './Warehouse.jsx';
import Expenses from './Expenses.jsx';
import Settings from './Settings.jsx';
import ComingSoon from './ComingSoon.jsx';

const SECTION_TITLES = {
  marketing: 'Маркетинг',
};

export default function Dashboard({ password, username, role, onLogout }) {
  const allowedPages = ROLE_PAGES[role] || ROLE_PAGES.manager;
  const [view, setView] = useState('sales'); // 'sales' | 'report' | 'selfbuy' | 'expenses' | 'batches' | 'warehouse' | 'marketing' | 'settings'
  const [collapsed, setCollapsed] = useState(() => sessionStorage.getItem('sidebar_collapsed') === '1');

  // Защита на случай, если роль не даёт доступа к текущему разделу (например, роль сменили
  // прямо во время работы, или view остался от предыдущей роли) — просто откатываемся на Главную.
  const safeView = allowedPages.includes(view) ? view : 'sales';

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

  function renderContent() {
    if (safeView === 'batches') {
      return <Batches password={password} onClose={() => setView('sales')} />;
    }

    if (safeView === 'report') {
      return <Report password={password} />;
    }

    if (safeView === 'warehouse') {
      return <Warehouse password={password} />;
    }

    if (safeView === 'expenses') {
      return <Expenses password={password} />;
    }

    if (safeView === 'settings') {
      return <Settings password={password} username={username} />;
    }

    if (safeView === 'selfbuy') {
      return (
        <SalesView
          key="selfbuy"
          password={password}
          onLogout={onLogout}
          mode="selfbuy"
          title={<>Самовыкупы <span>(Талдыкорган + Юбилейное)</span></>}
          showSync={false}
        />
      );
    }

    if (SECTION_TITLES[safeView]) {
      return <ComingSoon title={SECTION_TITLES[safeView]} />;
    }

    // safeView === 'sales'
    return (
      <SalesView
        key="main"
        password={password}
        onLogout={onLogout}
        mode="main"
        title={<>Продажи <span>Kaspi</span></>}
        showSync
      />
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
        <div className="app">{renderContent()}</div>
      </div>
    </div>
  );
}
