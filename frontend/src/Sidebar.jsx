import React, { useEffect, useState } from 'react';

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
  purchasing: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M3 4h1.5l1.2 8.4a1.5 1.5 0 001.5 1.3h6.2a1.5 1.5 0 001.5-1.2L16 7H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="8" cy="17" r="1" fill="currentColor"/><circle cx="14" cy="17" r="1" fill="currentColor"/><path d="M11 8v3M9.5 9.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
  ),
  marketing: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M2 8v4h3l5 3V5L5 8H2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M14 7.5a3 3 0 010 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M16.3 5.5a6 6 0 010 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  // Реклама товаров — мегафон с ручкой: платное продвижение, "кричим о товаре".
  marketingAds: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M4.5 8h2.2L14 4.5v11L6.7 12H4.5A1.5 1.5 0 013 10.5v-1A1.5 1.5 0 014.5 8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M7 12.2V15a1.5 1.5 0 003 0v-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M16.2 7.8a3.5 3.5 0 010 4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
  ),
  // Бонусы от продавца — подарочная коробка с лентой: скидку дарит продавец из своего кармана.
  marketingBonuses: (
    <svg viewBox="0 0 20 20" fill="none"><rect x="3.2" y="8.6" width="13.6" height="8.2" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><rect x="2.2" y="5.6" width="15.6" height="3" rx="1" stroke="currentColor" strokeWidth="1.5"/><path d="M10 5.6v11.2" stroke="currentColor" strokeWidth="1.5"/><path d="M10 5.6C9.2 4 8.4 3.2 7.3 3.2a1.7 1.7 0 000 3.4H10M10 5.6c.8-1.6 1.6-2.4 2.7-2.4a1.7 1.7 0 010 3.4H10" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
  ),
  // Бонусы за отзыв — облако отзыва со звездой внутри: платим за оставленную оценку.
  marketingReviews: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M3 5.6a2 2 0 012-2h10a2 2 0 012 2v6a2 2 0 01-2 2h-4.6L6.6 17v-3.4H5a2 2 0 01-2-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M10 6.2l.65 1.51 1.63.15-1.23 1.08.49 1.6L10 9.7l-1.54.84.49-1.6L7.72 7.86l1.63-.15z" fill="currentColor"/></svg>
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
  settings: (
    <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  orders: (
    <svg viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  analyst: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M10 2.5a5.5 5.5 0 013 10.1V14a1 1 0 01-1 1H8a1 1 0 01-1-1v-1.4A5.5 5.5 0 0110 2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M8.5 17h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M9 8.5l1 1.5 2-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  geography: (
    <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5"/><path d="M2.5 10h15" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
  ),
  abc: (
    <svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="2.5" width="15" height="15" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M2.5 7.5h15M2.5 12.5h15M7.5 2.5v15M12.5 2.5v15" stroke="currentColor" strokeWidth="1.2"/><rect x="3.5" y="3.5" width="3" height="3" rx="0.5" fill="currentColor"/></svg>
  ),
  unitEconomics: (
    <svg viewBox="0 0 20 20" fill="none"><rect x="3" y="2.5" width="14" height="15" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="5.5" y="5" width="9" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.3"/><circle cx="6.8" cy="11" r="1" fill="currentColor"/><circle cx="10" cy="11" r="1" fill="currentColor"/><circle cx="13.2" cy="11" r="1" fill="currentColor"/><circle cx="6.8" cy="14.2" r="1" fill="currentColor"/><circle cx="10" cy="14.2" r="1" fill="currentColor"/><circle cx="13.2" cy="14.2" r="1" fill="currentColor"/></svg>
  ),
  deliveryReturns: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M6 8l-3 2 3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 10h8a3 3 0 003-3V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="14.5" cy="14.5" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M14.5 13v1.5l1 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  // Иконки заголовков разделов
  money: (
    <svg viewBox="0 0 20 20" fill="none"><ellipse cx="10" cy="5.5" rx="6" ry="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M4 5.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9" stroke="currentColor" strokeWidth="1.5"/><path d="M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" stroke="currentColor" strokeWidth="1.5"/></svg>
  ),
  salesBag: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M4.5 6.5h11l1 10.5h-13z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M7.5 8.5V5.8a2.5 2.5 0 015 0v2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  truck: (
    <svg viewBox="0 0 20 20" fill="none"><rect x="2" y="5.5" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.5"/><path d="M11 8.5h3.2l3 2.8v2.2H11z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><circle cx="6" cy="15" r="1.6" stroke="currentColor" strokeWidth="1.4"/><circle cx="14" cy="15" r="1.6" stroke="currentColor" strokeWidth="1.4"/></svg>
  ),
  chevron: (
    <svg viewBox="0 0 20 20" fill="none"><path d="M7.5 5l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
};

// Какие пункты меню видит каждая роль
const ROLE_PAGES = {
  admin: ['sales', 'report', 'expenses', 'analyst', 'orders', 'selfbuy', 'geography', 'delivery_returns', 'warehouse', 'batches', 'purchasing', 'abc', 'unit_economics', 'marketing_ads', 'marketing_bonuses', 'marketing_reviews', 'settings'],
  manager: ['sales', 'orders', 'selfbuy', 'warehouse'],
  marketer: ['sales', 'orders', 'selfbuy', 'geography', 'warehouse', 'marketing_ads', 'marketing_bonuses', 'marketing_reviews'],
};

// Меню сгруппировано по задаче, которую решает страница: "Деньги" — сколько заработали,
// "Продажи" — что уехало и что вернулось, "Закуп и склад" — что и сколько привезти,
// "Маркетинг" — во что вложились в продвижение. "Главная" и "Настройки" стоят вне групп.
// Раздел показывается, только если у роли есть доступ хотя бы к двум его страницам:
// заголовок над единственным пунктом — лишний шум, такой пункт рисуется как обычный.
const NAV_ITEMS = [
  { key: 'sales', label: 'Главная', icon: 'home' },
  {
    section: 'money',
    title: 'Деньги',
    icon: 'money',
    children: [
      { key: 'report', label: 'Отчёт', icon: 'report' },
      { key: 'expenses', label: 'Расходы', icon: 'expenses' },
      { key: 'analyst', label: 'AI Финансист', icon: 'analyst' },
    ],
  },
  {
    section: 'orders',
    title: 'Продажи',
    icon: 'salesBag',
    children: [
      { key: 'orders', label: 'Заказы', icon: 'orders' },
      { key: 'selfbuy', label: 'Самовыкупы', icon: 'selfbuy' },
      { key: 'geography', label: 'География заказов', icon: 'geography' },
      { key: 'delivery_returns', label: 'Проблемные возвраты', icon: 'deliveryReturns' },
    ],
  },
  {
    section: 'supply',
    title: 'Закуп и склад',
    icon: 'truck',
    children: [
      { key: 'warehouse', label: 'Склад', icon: 'warehouse' },
      { key: 'batches', label: 'Поставки', icon: 'batches' },
      { key: 'purchasing', label: 'Закуп', icon: 'purchasing' },
      { key: 'abc', label: 'ABC/XYZ', icon: 'abc' },
      { key: 'unit_economics', label: 'Юнит-экономика', icon: 'unitEconomics' },
    ],
  },
  {
    section: 'marketing',
    title: 'Маркетинг',
    icon: 'marketing',
    children: [
      { key: 'marketing_ads', label: 'Реклама товаров', icon: 'marketingAds' },
      { key: 'marketing_bonuses', label: 'Бонусы от продавца', icon: 'marketingBonuses' },
      { key: 'marketing_reviews', label: 'Бонусы за отзыв', icon: 'marketingReviews' },
    ],
  },
  { key: 'settings', label: 'Настройки', icon: 'settings' },
];

// Свёрнутые разделы запоминаются между заходами (localStorage, а не sessionStorage:
// на телефоне приложение открывается заново каждый раз, и каждый раз перескладывать
// меню руками — бессмысленно). В хранилище лежит только то, что явно свернули;
// отсутствие ключа = раздел раскрыт.
const GROUPS_KEY = 'sidebar_groups';

function readOpenGroups() {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveOpenGroups(next) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
  } catch {
    /* приватный режим / переполненное хранилище — просто не запоминаем */
  }
}

export { ROLE_PAGES };

function NavList({ view, onSelect, collapsed, role, openGroups, onToggleGroup }) {
  const allowed = (key) => !role || (ROLE_PAGES[role] || []).includes(key);

  const renderItem = (item, sub) => (
    <button
      key={item.key}
      className={`sidebar-item${sub ? ' sidebar-item-sub' : ''}${view === item.key ? ' active' : ''}`}
      onClick={() => onSelect(item.key)}
      title={collapsed ? item.label : undefined}
    >
      <span className="sidebar-item-icon">{icons[item.icon]}</span>
      {!collapsed && <span className="sidebar-item-label">{item.label}</span>}
    </button>
  );

  // Свёрнутый сайдбар: заголовков нет (для них нет места), поэтому группы разделяются
  // тонкой чертой, а все пункты видны всегда — иначе до половины страниц было бы не добраться.
  if (collapsed) {
    const blocks = [];
    let plainRun = null;
    for (const item of NAV_ITEMS) {
      if (item.children) {
        const visible = item.children.filter((c) => allowed(c.key));
        if (visible.length) {
          blocks.push(visible);
          plainRun = null;
        }
      } else if (allowed(item.key)) {
        if (!plainRun) {
          plainRun = [];
          blocks.push(plainRun);
        }
        plainRun.push(item);
      }
    }

    return (
      <nav className="sidebar-nav">
        {blocks.map((block, i) => (
          <React.Fragment key={i}>
            {i > 0 && <div className="sidebar-divider" />}
            {block.map((item) => renderItem(item, false))}
          </React.Fragment>
        ))}
      </nav>
    );
  }

  return (
    <nav className="sidebar-nav">
      {NAV_ITEMS.map((item) => {
        if (!item.children) return allowed(item.key) ? renderItem(item, false) : null;

        const visible = item.children.filter((c) => allowed(c.key));
        if (visible.length === 0) return null;
        if (visible.length === 1) return renderItem(visible[0], false);

        const open = openGroups[item.section] !== false;
        const hasActive = visible.some((c) => c.key === view);

        return (
          <React.Fragment key={item.section}>
            <button
              className={`sidebar-section${open ? ' open' : ''}${hasActive && !open ? ' has-active' : ''}`}
              onClick={() => onToggleGroup(item.section)}
              aria-expanded={open}
              title={open ? `Свернуть «${item.title}»` : `Развернуть «${item.title}»`}
            >
              <span className="sidebar-section-icon">{icons[item.icon]}</span>
              <span className="sidebar-section-title">{item.title}</span>
              <span className="sidebar-section-chevron">{icons.chevron}</span>
            </button>
            {open && visible.map((c) => renderItem(c, true))}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export default function Sidebar({ view, onSelect, collapsed, onToggleCollapse, onLogout, role }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState(readOpenGroups);

  // Если активная страница оказалась внутри свёрнутого раздела (например, переход
  // «Закуп → Поставки» кнопкой на самой странице), раскрываем раздел, чтобы было видно,
  // где мы находимся. Эффект завязан на view, поэтому свернуть раздел руками, стоя на его
  // странице, по-прежнему можно — обратно он не раскроется.
  useEffect(() => {
    const group = NAV_ITEMS.find((i) => i.children && i.children.some((c) => c.key === view));
    if (!group) return;
    setOpenGroups((prev) => {
      if (prev[group.section] !== false) return prev;
      const next = { ...prev, [group.section]: true };
      saveOpenGroups(next);
      return next;
    });
  }, [view]);

  function toggleGroup(section) {
    setOpenGroups((prev) => {
      const next = { ...prev, [section]: prev[section] === false };
      saveOpenGroups(next);
      return next;
    });
  }

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

        <NavList
          view={view}
          onSelect={onSelect}
          collapsed={collapsed}
          role={role}
          openGroups={openGroups}
          onToggleGroup={toggleGroup}
        />

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

            <NavList
              view={view}
              onSelect={handleSelect}
              collapsed={false}
              role={role}
              openGroups={openGroups}
              onToggleGroup={toggleGroup}
            />

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
