import React, { useEffect, useRef, useState } from 'react';

// График на мобильной "Главной". Отличие от SalesChart на компьютере — линия ПЕРЕЕЗЖАЕТ при
// смене показателя, а не перерисовывается мгновенно.
//
// Почему requestAnimationFrame, а не CSS-переход на атрибуте d: анимация d в CSS поддержана не
// везде одинаково (приложение стоит на айфоне как PWA) и ломается при смене числа точек.
//
// ГЛАВНОЕ: анимируется ФОРМА линии (доли 0…1 от собственной шкалы ряда), а не сырые значения.
// Сначала интерполировались именно значения — и переход между рядами разного порядка выглядел
// как рывок: у выручки ~3·10⁵, у количества заказов ~10¹, разница в 32 000 раз. Пока смесь
// падала с 321 000 до 5 000, график каждый кадр подгонял масштаб под текущий максимум, и линия
// всё это время оставалась формой выручки — форма "доезжала" только в последние 40 мс из 380
// (замер 2026-09-08: на 285-й мс переход был пройден на 0,3%). Обратный переход был зеркальным:
// форма менялась в первом же кадре, а дальше 285 мс не происходило ничего. С нормированной
// формой скорость перехода не зависит от того, отличаются ряды в 5 раз или в 32 000.
//
// ЗНАЧЕНИЕ ЗА ОТДЕЛЬНЫЙ ДЕНЬ: по графику можно вести пальцем (или мышью) — выбранный день
// отмечается вертикальным пунктиром и точкой, а над ней всплывает дата и цифра, как в
// recharts-подсказке на компьютере. Тонкости:
//   • подпись берёт значение из ИСХОДНОГО ряда values, а не из анимированной формы shown —
//     иначе во время переезда линии в подсказке мелькали бы промежуточные, несуществующие числа;
//   • touch-action: pan-y (в styles.css) — вертикальная прокрутка страницы пальцем по графику
//     продолжает работать, перехватывается только горизонтальное ведение;
//   • после отпускания палец отметку НЕ сбрасывает: на телефоне значение читают уже после того,
//     как убрали палец с экрана. Мышь — наоборот, снимает отметку при уходе с графика.
//
// ДРУГИЕ ГРАБЛИ, на которые уже наступили:
//   1. Зависимость эффекта — СТРОКА-подпись, а не массив: массив создаётся заново на каждый
//      рендер родителя, и с зависимостью [values] эффект перезапускался бы постоянно, перебивая
//      собственную анимацию.
//   2. То, что сейчас на экране, держим в ref, а не читаем из состояния в функции очистки —
//      там оно уже устаревшее (замыкание того рендера, где эффект создавался).
//   3. В скрытой вкладке requestAnimationFrame НЕ вызывается ни разу. Без ветки document.hidden
//      график молча застывал бы на старых значениях (именно так это и выглядело при проверке
//      в браузерной панели, где страница всегда hidden).

const DURATION = 380;
const W = 320;
const PAD_X = 6;

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// "ease-out": быстро стартует, мягко тормозит.
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// Приводит ряд к долям 0…1 внутри его собственной шкалы. Ноль всегда попадает внутрь шкалы
// (min берётся не больше нуля), поэтому его положение — тоже доля: она нужна пунктирной линии,
// когда в ряду есть отрицательные значения.
function toShape(values) {
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  return {
    points: values.map((v) => (v - min) / span),
    zero: (0 - min) / span,
  };
}

export default function MetricLineChart({
  values, labels, color = 'var(--accent-brand)', height = 140, format = (v) => v,
}) {
  const target = toShape(values);
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target); // то, что реально нарисовано прямо сейчас
  const signature = `${target.points.join('|')}#${target.zero}`;

  const plotRef = useRef(null);
  const draggingRef = useRef(false);
  const [picked, setPicked] = useState(null); // индекс выбранного дня или null

  useEffect(() => {
    const start = shownRef.current;

    // Показываем сразу, без анимации, если:
    //   • сменилось количество дней (другой период) — интерполировать не между чем;
    //   • пользователь просил меньше движения в настройках системы;
    //   • страница сейчас скрыта — в фоновой вкладке requestAnimationFrame не вызывается вообще.
    if (start.points.length !== target.points.length || prefersReducedMotion() || document.hidden) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }

    let raf = null;
    const t0 = performance.now();
    function step(now) {
      const k = easeOut(Math.min(1, (now - t0) / DURATION));
      const next = {
        points: start.points.map((v, i) => v + (target.points[i] - v) * k),
        zero: start.zero + (target.zero - start.zero) * k,
      };
      shownRef.current = next;
      setShown(next);
      if (k < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => { if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const bottom = height - 20;
  const top = 12;

  const points = shown.points;
  const x = (i) => PAD_X + (i * (W - PAD_X * 2)) / Math.max(1, points.length - 1);
  const y = (share) => bottom - share * (bottom - top);

  const line = points.map((share, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(share).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  // Пунктир нуля рисуем, только если он реально выше нижнего края — то есть в ряду есть минусы.
  // Иначе линия совпала бы с осью и была бы просто лишней чертой.
  const showZero = shown.zero > 0.005;

  // Индекс держим в состоянии как есть, а зажимаем при отрисовке: при смене периода дней
  // становится меньше, и сохранённый индекс мог бы вылезти за конец нового ряда.
  const active = picked === null || points.length === 0
    ? null
    : Math.min(picked, points.length - 1);

  function indexFromClientX(clientX) {
    const el = plotRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || points.length === 0) return null;
    if (points.length === 1) return 0;
    // Из пикселей экрана — в координаты viewBox (по горизонтали svg растянут на всю ширину).
    const vx = ((clientX - rect.left) / rect.width) * W;
    const stepX = (W - PAD_X * 2) / (points.length - 1);
    const i = Math.round((vx - PAD_X) / stepX);
    return Math.max(0, Math.min(points.length - 1, i));
  }

  function pick(e) {
    const i = indexFromClientX(e.clientX);
    if (i !== null) setPicked(i);
  }

  function onPointerDown(e) {
    draggingRef.current = true;
    // Захват указателя — чтобы палец, уехавший за край графика, продолжал вести отметку.
    if (e.currentTarget.setPointerCapture) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* не критично */ }
    }
    pick(e);
  }

  function onPointerMove(e) {
    if (draggingRef.current || e.pointerType === 'mouse') pick(e);
  }

  function onPointerUp() {
    draggingRef.current = false;
  }

  function onPointerLeave(e) {
    // Мышь ушла с графика — подсказку убираем. Палец после отпускания её оставляет.
    if (e.pointerType === 'mouse' && !draggingRef.current) setPicked(null);
  }

  let tip = null;
  if (active !== null) {
    const pxShare = (x(active) / W) * 100;
    const py = y(points[active]);
    const style = {};
    if (pxShare <= 22) style.left = 0;
    else if (pxShare >= 78) style.right = 0;
    else style.left = `${pxShare}%`;
    // Возле верхнего края подсказке некуда всплывать — тогда роняем её под точку.
    const below = py < 58;
    style.top = below ? py + 12 : py - 12;
    style.transform = [
      pxShare > 22 && pxShare < 78 ? 'translateX(-50%)' : '',
      below ? '' : 'translateY(-100%)',
    ].filter(Boolean).join(' ');
    // Минус в отдельный день красим красным, даже если весь период в плюсе и линия зелёная —
    // так же, как в подсказке графика на компьютере.
    const dayValue = values[active];
    tip = (
      <div className="mlc-tip" style={style}>
        <span className="mlc-tip-day">{labels[active] || ''}</span>
        <span className="mlc-tip-value" style={{ color: dayValue < 0 ? 'var(--accent-down)' : color }}>
          {format(dayValue)}
        </span>
      </div>
    );
  }

  return (
    <div className="mlc">
      <div
        className="mlc-plot"
        ref={plotRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <svg
          className="mlc-svg"
          style={{ height }}
          viewBox={`0 0 ${W} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="График по дням выбранного периода"
        >
          {showZero && (
            <line
              x1={PAD_X}
              y1={y(shown.zero)}
              x2={W - PAD_X}
              y2={y(shown.zero)}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
          )}
          <path d={area} fill={color} opacity="0.12" />
          {/* pathLength="1" приводит длину линии к единице — на этом держится её прорисовка
              слева направо в styles.css (иначе длину пришлось бы угадывать в пикселях). */}
          <path className="mlc-line" pathLength="1" d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {points.map((share, i) => (
            <circle key={i} cx={x(i)} cy={y(share)} r="2.6" fill={color} />
          ))}
          {active !== null && (
            <>
              <line
                x1={x(active)}
                y1={top - 8}
                x2={x(active)}
                y2={bottom}
                stroke="var(--text-muted)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <circle cx={x(active)} cy={y(points[active])} r="4.5" fill="var(--bg-card)" stroke={color} strokeWidth="2.5" />
            </>
          )}
        </svg>
        {tip}
      </div>
      <div className="mlc-caption">
        <span>{labels[0]}</span>
        {active === null && <span className="mlc-hint">коснитесь графика</span>}
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}
