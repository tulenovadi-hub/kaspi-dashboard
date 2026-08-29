import React, { useMemo, useState } from 'react';
import { VIEW_BOX, REGION_SHAPES, CITY_REGIONS, CITY_POINTS, projectLonLat } from './kazakhstanMap.js';
import { formatMoney, formatNumber } from './dateUtils.js';

// Заливка области: чем больше значение, тем ярче фирменный синий. Степень 0.65, а не сама
// доля — при линейной шкале мелкие области сливаются с пустыми, при корне (0.5), наоборот,
// почти всё выглядит одинаково ярким.
function fillFor(value, max) {
  if (!value || value <= 0 || !max) return 'var(--bg-card-hover)';
  const t = 0.12 + 0.88 * Math.pow(value / max, 0.65);
  return `rgba(110, 139, 255, ${Math.min(1, t).toFixed(3)})`;
}

function radiusFor(value, max) {
  if (!value || value <= 0 || !max) return 0;
  return 4 + 20 * Math.sqrt(value / max);
}

export default function KazakhstanMap({ regions, cities, metric, view }) {
  // hovered — то, что под курсором; pinned — то, что выбрано тапом (на телефоне hover нет,
  // а посмотреть цифры по области надо).
  const [hovered, setHovered] = useState(null);
  const [pinned, setPinned] = useState(null);
  // flip — рисовать ли подсказку слева от курсора: у правого края карты (особенно на телефоне)
  // она иначе вылезает за пределы экрана.
  const [pointer, setPointer] = useState({ x: 0, y: 0, flip: false });

  const valueOf = (item) => (metric === 'orders' ? item.orders : item.revenue);

  const regionById = useMemo(() => Object.fromEntries(regions.map((r) => [r.id, r])), [regions]);

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

  // Города, для которых есть координаты: сначала справочник geonames, затем координаты из
  // самого заказа (Kaspi присылает их у своей доставки — как раз у мелких сёл, которых в
  // справочнике нет). Что не легло ни туда, ни туда, на карте не рисуется, но в таблице
  // городов под картой есть — поэтому ничего не теряется молча.
  const cityPoints = useMemo(() => {
    const list = [];
    for (const c of cities) {
      if (valueOf(c) <= 0) continue;
      const point = CITY_POINTS[c.pointKey] || CITY_POINTS[c.key] || projectLonLat(c.lon, c.lat);
      if (!point) continue;
      list.push({ ...c, x: point[0], y: point[1] });
    }
    // мелкие рисуем поверх крупных, иначе большой пузырь Алматы накрывает соседей
    return list.sort((a, b) => valueOf(b) - valueOf(a));
  }, [cities, metric]);

  // Сколько городов с продажами не удалось поставить на карту. Молча терять их нельзя —
  // в таблице под картой они есть, и человек должен понимать, почему точек меньше.
  const hiddenCities = useMemo(
    () => cities.filter((c) => valueOf(c) > 0).length - cityPoints.length,
    [cities, cityPoints, metric]
  );

  const maxCity = useMemo(() => Math.max(0, ...cityPoints.map(valueOf)), [cityPoints, metric]);

  const active = hovered || pinned;

  const TOOLTIP_WIDTH = 210;

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

  function tooltipFor(item) {
    if (!item) return null;
    return (
      <div className={`kz-map-tooltip${pointer.flip ? ' flip' : ''}`} style={{ left: pointer.x, top: pointer.y }}>
        <div className="kz-map-tooltip-title">{item.title}</div>
        {item.subtitle && item.subtitle !== item.title && (
          <div className="kz-map-tooltip-sub">{item.subtitle}</div>
        )}
        <div className="kz-map-tooltip-row"><span>Выручка</span><b>{formatMoney(item.revenue)}</b></div>
        <div className="kz-map-tooltip-row"><span>Заказов</span><b>{formatNumber(item.orders)}</b></div>
        <div className="kz-map-tooltip-row"><span>Средний чек</span><b>{formatMoney(item.avgCheck)}</b></div>
        {item.deliveryCost > 0 && (
          <div className="kz-map-tooltip-row"><span>Доставка</span><b>{formatMoney(item.deliveryCost)}</b></div>
        )}
      </div>
    );
  }

  function regionTooltip(r) {
    if (!r) return null;
    return { title: r.name, subtitle: `${r.revenueShare.toFixed(1)}% выручки`, ...r };
  }

  function selectRegion(r) {
    const data = regionTooltip(r);
    setPinned((prev) => (prev && prev.title === data.title ? null : data));
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
        className="kz-map"
        viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`}
        role="img"
        aria-label="Карта Казахстана: продажи по областям"
      >
        {REGION_SHAPES.map((shape) => {
          const data = regionById[shape.id] || { orders: 0, revenue: 0, avgCheck: 0, revenueShare: 0, name: shape.short };
          const isActive = active && active.id === shape.id;
          return (
            <path
              key={shape.id}
              d={shape.d}
              className={`kz-region${isActive ? ' active' : ''}`}
              fill={view === 'cities' ? 'var(--bg-card-hover)' : fillFor(valueOf(data), maxRegion)}
              onMouseEnter={() => setHovered(regionTooltip(data))}
              onClick={() => selectRegion(data)}
            />
          );
        })}

        {REGION_SHAPES.map((shape) => (
          <text key={`l-${shape.id}`} className="kz-map-label" x={shape.labelX} y={shape.labelY}>
            {shape.short}
          </text>
        ))}

        {/* Города республиканского значения: собственных площадей на карте страны у них
            практически нет, поэтому в режиме областей рисуем их кружками поверх. */}
        {view === 'regions' && CITY_REGIONS.map((c) => {
          const data = regionById[c.id];
          if (!data) return null;
          const isActive = active && active.id === c.id;
          return (
            <g key={c.id} className="kz-city-region" onMouseEnter={() => setHovered(regionTooltip(data))} onClick={() => selectRegion(data)}>
              <circle
                cx={c.x}
                cy={c.y}
                r={isActive ? 12 : 10}
                fill={fillFor(valueOf(data), maxCityRegion)}
                className="kz-city-dot"
              />
              <text className="kz-map-label kz-map-label-city" x={c.x} y={c.y - 16}>{c.short}</text>
            </g>
          );
        })}

        {view === 'cities' && cityPoints.map((c) => (
          <circle
            key={c.key}
            cx={c.x}
            cy={c.y}
            r={radiusFor(valueOf(c), maxCity)}
            className="kz-city-bubble"
            onMouseEnter={() => setHovered({ title: c.city, subtitle: c.regionName || 'Область не определена', ...c })}
            onClick={() => setPinned((prev) => (prev && prev.title === c.city ? null : { title: c.city, subtitle: c.regionName || 'Область не определена', ...c }))}
          />
        ))}
      </svg>

      {tooltipFor(active)}

      <div className="kz-map-legend">
        <span>{metric === 'orders' ? 'Заказов' : 'Выручка'}: меньше</span>
        <i className="kz-map-legend-bar" />
        <span>больше</span>
        {view === 'cities' && hiddenCities > 0 && (
          <span className="kz-map-legend-note">
            {hiddenCities} {hiddenCities === 1 ? 'город без точки' : 'городов без точки'} — они в таблице ниже
          </span>
        )}
      </div>
    </div>
  );
}
