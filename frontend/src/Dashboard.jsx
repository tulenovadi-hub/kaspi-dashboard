import React, { useState } from 'react';
import Sidebar from './Sidebar.jsx';
import SalesView from './SalesView.jsx';
import Batches from './Batches.jsx';
import Report from './Report.jsx';
import Warehouse from './Warehouse.jsx';
import Expenses from './Expenses.jsx';
import ComingSoon from './ComingSoon.jsx';

const SECTION_TITLES = {
  marketing: 'Маркетинг',
};

export default function Dashboard({ password, onLogout }) {
  const [view, setView] = useState('sales'); // 'sales' | 'report' | 'selfbuy' | 'expenses' | 'batches' | 'warehouse' | 'marketing'
  const [collapsed, setCollapsed] = useState(() => sessionStorage.getItem('sidebar_collapsed') === '1');

  function handleToggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      sessionStorage.setItem('sidebar_collapsed', next ? '1' : '0');
      return next;
    });
  }

  function renderContent() {
    if (view === 'batches') {
      return <Batches password={password} onClose={() => setView('sales')} />;
    }

    if (view === 'report') {
      return <Report password={password} />;
    }

    if (view === 'warehouse') {
      return <Warehouse password={password} />;
    }

    if (view === 'expenses') {
      return <Expenses password={password} />;
    }

    if (view === 'selfbuy') {
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

    if (SECTION_TITLES[view]) {
      return <ComingSoon title={SECTION_TITLES[view]} />;
    }

    // view === 'sales'
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
        view={view}
        onSelect={setView}
        collapsed={collapsed}
        onToggleCollapse={handleToggleCollapse}
        onLogout={onLogout}
      />
      <div className="main-content">
        <div className="app">{renderContent()}</div>
      </div>
    </div>
  );
}
