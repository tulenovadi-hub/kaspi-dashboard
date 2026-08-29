import React, { useMemo, useState } from 'react';
import { VIEW_BOX, REGION_SHAPES, CITY_REGIONS } from './kazakhstanMap.js';
import { formatMoney, formatNumber } from './dateUtils.js';

// Заливка: чем больше значение, тем ярче фирменный синий. Степень 0.65, а не сама доля —
// при линейной шкале мелкие области сливаются с пустыми, при корне (0.5), наоборот, почти
// всё выглядит одинаково ярким.
function fillFor(value, max) {
  if (!value || value <= 0 || !max) return 'var(--bg-card-hover)';
  const t = 0.12 + 0.88 * Math.pow(value / max, 0.65);
  return `rgba(110, 139, 255, ${Math.min(1, t).toFixed(3)})`;
}

const TOOLTIP_WIDTH = 210;

export default function KazakhstanMap({ regions, macroRegions, metric, view }) {
  // hovered — то, что под курсором; pinned — то, что выбрано тапом (на телефоне hover нет,
  // а посмотреть цифры по области надо).
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);
  // flip — рисовать ли подсказку слева от курсора: у правого края карты (особенно на телефоне)
  // она иначе вылезает за пределы экрана.
  const [pointer, setPointer] = useState({ x: 0, y: 0, flip: false });

  const valueOf = (item) => (metric === 'orders' ? item.orders : item.revenue);
  const byMacro = view === 'macro';

  const regionById = useMemo(() => Object.fromEntries(regions.map((r) => [r.id, r])), [regions]);
  const macroById = useMemo(() => Object.fromEntries(macroRegions.map((m) => [m.id, m])), [macroRegions]);

  // Шкала цвета для областей считается БЕЗ городов республиканского значения: Алматы с
  // Астаной почти всегда крупнее любой области, а на карте они всего лишь точки — если брать
  // максимум по ним, все области окрашиваются в один средний оттенок и карта ничего не
  // показывает. Кружки городов красятся по своей шкале.
  const maxRegion = useMemo(
    () => Math.max(0, ...regions.filter((r) => !r.isCity).map(valueOf)),
    [regions, metric]
  );
  const maxCityRegion = useMemo(
    () => Math.max(0, ...regions.filter((r) => r.isCity).map(valueOf)),
    [regions, metric]
  );
  const maxMacro = useMemo(() => Math.max(0, ...macroRegions.map(valueOf)), [macroRegions, metric]);

  // Подписи макрорегионов ставим в середину их областей. Отдельной геометрии у макрорегиона
  // нет — он просто набор областей, залитых одним цветом.
  const macroLabels = useMemo(() => {
    const groups = new Map();
    for (const shape of REGION_SHAPES) {
      if (!groups.has(shape.macro)) groups.set(shape.macro, []);
      groups.get(shape.macro).push(shape);
    }
    return [...groups.entries()].map(([macroId, shapes]) => ({
      id: macroId,
      short: macroById[macroId] ? macroById[macroId].short : macroId,
      x: shapes.reduce((s, x) => s + x.labelX, 0) / shapes.length,
      y: shapes.reduce((s, x) => s + x.labelY, 0) / shapes.length,
    }));
  }, [macroById]);

  const active = hovered || pinned;

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setPointer({
      x,
      // по вертикали держим подсказку внутри карты, иначе у верхнего края она наезжает
      // на переключатели над картой
      y: Math.max(70, Math.min(rect.height - 70, y)),
      flip: x + TOOLTIP_WIDTH > rect.width,
    });
  }

  // Одна и та же подсказка и для области, и для макрорегиона — цифры в них одинаковые.
  function tooltipFor(item) {
    if (!item) return null;
    return (
      <div className={`kz-map-tooltip${pointer.flip ? ' flip' : ''}`} style={{ left: pointer.x, top: pointer.y }}>
        <div className="kz-map-tooltip-title">{item.name}</div>
        <div className="kz-map-tooltip-sub">{item.revenueShare.toFixed(1)}% выручки</div>
        <div className="kz-map-tooltip-row"><span>Выручка</span><b>{formatMoney(item.revenue)}</b></div>
        <div className="kz-map-tooltip-row"><span>Заказов</span><b>{formatNumber(item.orders)}</b></div>
        <div className="kz-map-tooltip-row"><span>Средний чек</span><b>{formatMoney(item.avgCheck)}</b></div>
        {item.deliveryCost > 0 && (
          <div className="kz-map-tooltip-row"><span>Доставка</span><b>{formatMoney(item.deliveryCost)}</b></div>
        )}
      </div>
    );
  }

  // Что показывать при наведении на конкретную область — зависит от режима карты.
  function targetFor(regionId) {
    const region = regionById[regionId];
    if (!region) return null;
    if (!byMacro) return region;
    return macroById[region.macro] || null;
  }

  function select(regionId) {
    const target = targetFor(regionId);
    if (!target) return;
    setPinned((prev) => (prev && prev.id === target.id ? null : target));
  }

  function fillForRegion(regionId, isCityMarker) {
    const region = regionById[regionId];
    if (!region) return 'var(--bg-card-hover)';
    if (byMacro) {
      const macro = macroById[region.macro];
      return fillFor(macro ? valueOf(macro) : 0, maxMacro);
    }
    return fillFor(valueOf(region), isCityMarker ? maxCityRegion : maxRegion);
  }

  return (
    // onPointerDown нужен для телефона: там mousemove перед касанием может не прийти,
    // и подсказка без него встала бы в позицию от прошлого касания.
    <div
      className="kz-map-wrap"
      onMouseMove={handleMove}
      onPointerDown={handleMove}
      onMouseLeave={() => setHovered(null)}
    >
      <svg
        className={`kz-map${byMacro ? ' by-macro' : ''}`}
        viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`}
        role="img"
        aria-label="Карта Казахстана: продажи по регионам и областям"
      >
        {REGION_SHAPES.map((shape) => {
          const target = targetFor(shape.id);
          const isActive = active && target && active.id === target.id;
          return (
            <path
              key={shape.id}
              d={shape.d}
              className={`kz-region${isActive ? ' active' : ''}`}
              fill={fillForRegion(shape.id, false)}
              onMouseEnter={() => setHovered(targetFor(shape.id))}
              onClick={() => select(shape.id)}
            />
          );
        })}

        {/* В режиме макрорегионов подписи областей только мешают: соседние области залиты
            одним цветом и читаются как единый регион, поэтому подписываем сам регион. */}
        {byMacro
          ? macroLabels.map((m) => (
            <text key={`m-${m.id}`} className="kz-map-label kz-map-label-macro" x={m.x} y={m.y}>{m.short}</text>
          ))
          : REGION_SHAPES.map((shape) => (
            <text key={`l-${shape.id}`} className="kz-map-label" x={shape.labelX} y={shape.labelY}>{shape.short}</text>
          ))}

        {/* Города республиканского значения: собственной площади на карте страны у них
            практически нет, поэтому рисуем их кружками поверх областей. */}
        {CITY_REGIONS.map((c) => {
          const target = targetFor(c.id);
          const isActive = active && target && active.id === target.id;
          return (
            <g key={c.id} className="kz-city-region" onMouseEnter={() => setHovered(targetFor(c.id))} onClick={() => select(c.id)}>
              <circle cx={c.x} cy={c.y} r={isActive ? 12 : 10} fill={fillForRegion(c.id, true)} className="kz-city-dot" />
              {!byMacro && <text className="kz-map-label kz-map-label-city" x={c.x} y={c.y - 16}>{c.short}</text>}
            </g>
          );
        })}
      </svg>

      {tooltipFor(active)}

      <div className="kz-map-legend">
        <span>{metric === 'orders' ? 'Заказов' : 'Выручка'}: меньше</span>
        <i className="kz-map-legend-bar" />
        <span>больше</span>
      </div>
    </div>
  );
}
