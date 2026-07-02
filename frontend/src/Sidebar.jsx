import React, { useState } from 'react';

// Простые line-иконки без внешних зависимостей — 20x20, stroke=currentColor
const icons = {
  home: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M3 8.5L10 3l7 5.5V16a1 1 0 01-1 1h-3.5a.5.5 0 01-.5-.5V12a1 1 0 00-1-1H9a1 1 0 00-1 1v4.5a.5.5 0 01-.5.5H4a1 1 0 01-1-1V8.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
  ),
  report: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M4 16V9M10 16V4M16 16v-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M2 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  expenses: (
    <svg viewBox="0 0 20 20" fill="none"><rect x="2" y="5" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M2 8h16" stroke="currentColor" strokeWidth="1.5"/><circle cx="14" cy="12" r="1" fill="currentColor"/></svg>
  ),
  batches: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M2 6.5l8-3.5 8 3.5-8 3.5-8-3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M2 6.5V13l8 3.5 8-3.5V6.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M10 10v6.5" stroke="currentColor" strokeWidth="1.5"/></svg>
  ),
  warehouse: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M2 8l8-5 8 5v8a1 1 0 01-1 1H3a1 1 0 01-1-1V8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><rect x="7.5" y="11" width="5" height="6" stroke="currentColor" strokeWidth="1.5"/></svg>
  ),
  marketing: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M2 8v4h3l5 3V5L5 8H2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M14 7.5a3 3 0 010 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M16.3 5.5a6 6 0 010 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  selfbuy: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M3 4h1.5l1.2 8.4a1.5 1.5 0 001.5 1.3h6.2a1.5 1.5 0 001.5-1.2L16 7H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="8" cy="17" r="1" fill="currentColor"/><circle cx="14" cy="17" r="1" fill="currentColor"/><path d="M13 3.5l2 2-2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M15 5.5H10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
  ),
  collapse: (
    <svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.5"/></svg>
  ),
  logout: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M8 3H4a1 1 0 00-1 1v12a1 1 0 001 1h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M13 14l4-4-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M17 10H7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  burger: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
  ),
  close: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
  ),
};

const NAV_ITEMS = [
  { key: 'sales', label: 'Главная', icon: 'home' },
  { key: 'report', label: 'Отчёт', icon: 'report' },
  { key: 'selfbuy', label: 'Самовыкупы', icon: 'selfbuy' },
  { key: 'expenses', label: 'Расходы', icon: 'expenses' },
  { key: 'batches', label: 'Поставки', icon: 'batches' },
  { key: 'warehouse', label: 'Склад', icon: 'warehouse' },
  { key: 'marketing', label: 'Маркетинг', icon: 'marketing' },
];

function NavList({ view, onSelect, collapsed }) {
  return (
    <nav className="sidebar-nav">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.key}
          className={`sidebar-item${view === item.key ? ' active' : ''}`}
          onClick={() => onSelect(item.key)}
          title={collapsed ? item.label : undefined}
        >
          <span className="sidebar-item-icon">{icons[item.icon]}</span>
          {!collapsed && <span className="sidebar-item-label">{item.label}</span>}
        </button>
      ))}
    </nav>
  );
}

export default function Sidebar({ view, onSelect, collapsed, onToggleCollapse, onLogout }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  function handleSelect(key) {
    onSelect(key);
    setMobileOpen(false);
  }

  return (
    <>
      {/* ===== Десктоп: постоянная колонка слева ===== */}
      <div className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-top">
          {!collapsed && <div className="sidebar-brand">Kaspi <span>Dashboard</span></div>}
          <button className="sidebar-collapse-btn" onClick={onToggleCollapse} title={collapsed ? 'Развернуть' : 'Свернуть'}>
            {icons.collapse}
          </button>
        </div>

        <NavList view={view} onSelect={onSelect} collapsed={collapsed} />

        <button className="sidebar-item sidebar-logout" onClick={onLogout} title={collapsed ? 'Выйти' : undefined}>
          <span className="sidebar-item-icon">{icons.logout}</span>
          {!collapsed && <span className="sidebar-item-label">Выйти</span>}
        </button>
      </div>

      {/* ===== Мобильный: верхняя панель с гамбургером ===== */}
      <div className="mobile-topbar">
        <button className="mobile-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Открыть меню">
          {icons.burger}
        </button>
        <div className="mobile-topbar-title">Kaspi <span>Dashboard</span></div>
        <div className="mobile-topbar-spacer" />
      </div>

      {/* ===== Мобильный: выезжающее меню поверх контента ===== */}
      {mobileOpen && (
        <div className="mobile-menu-overlay" onClick={() => setMobileOpen(false)}>
          <div className="mobile-menu-panel" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-menu-header">
              <div className="sidebar-brand">Kaspi <span>Dashboard</span></div>
              <button className="modal-close" onClick={() => setMobileOpen(false)} aria-label="Закрыть меню">
                {icons.close}
              </button>
            </div>

            <NavList view={view} onSelect={handleSelect} collapsed={false} />

            <button className="sidebar-item sidebar-logout" onClick={onLogout}>
              <span className="sidebar-item-icon">{icons.logout}</span>
              <span className="sidebar-item-label">Выйти</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
