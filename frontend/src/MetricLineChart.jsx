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

export default function MetricLineChart({ values, labels, color = 'var(--accent-brand)', height = 140 }) {
  const target = toShape(values);
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target); // то, что реально нарисовано прямо сейчас
  const signature = `${target.points.join('|')}#${target.zero}`;

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

  const w = 320;
  const padX = 6;
  const bottom = height - 20;
  const top = 12;

  const points = shown.points;
  const x = (i) => padX + (i * (w - padX * 2)) / Math.max(1, points.length - 1);
  const y = (share) => bottom - share * (bottom - top);

  const line = points.map((share, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(share).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  // Пунктир нуля рисуем, только если он реально выше нижнего края — то есть в ряду есть минусы.
  // Иначе линия совпала бы с осью и была бы просто лишней чертой.
  const showZero = shown.zero > 0.005;

  return (
    <div className="mlc">
      <svg
        className="mlc-svg"
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="График по дням выбранного периода"
      >
        {showZero && (
          <line
            x1={padX}
            y1={y(shown.zero)}
            x2={w - padX}
            y2={y(shown.zero)}
            stroke="var(--border)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        )}
        <path d={area} fill={color} opacity="0.12" />
        <path className="mlc-line" d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((share, i) => (
          <circle key={i} cx={x(i)} cy={y(share)} r="2.6" fill={color} />
        ))}
      </svg>
      <div className="mlc-caption">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}
