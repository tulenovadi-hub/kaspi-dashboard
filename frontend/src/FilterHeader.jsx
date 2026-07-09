import React, { useEffect, useRef, useState } from 'react';

// Кнопка-заголовок столбца с иконкой воронки + выпадающая панель фильтра.
// Открывается по клику, закрывается по клику снаружи — как автофильтр в Google Sheets/Excel.
// Используется в шапках таблиц (Заказы, Склад) — единый переиспользуемый компонент,
// чтобы не дублировать одну и ту же реализацию в каждом файле.
export default function FilterHeader({ label, active, align, children }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="th-filter-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`th-filter-btn${active ? ' th-filter-btn-active' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <svg viewBox="0 0 20 20" width="11" height="11" fill="none">
          <path d="M3 4h14l-5.5 6.5V16l-3 1.5v-7L3 4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          className={`th-filter-popover${align === 'right' ? ' th-filter-popover-right' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  );
}
