import React, { useEffect, useRef, useState } from 'react';

// График на мобильной "Главной". Отличие от SalesChart на компьютере — линия ПЕРЕЕЗЖАЕТ при
// смене показателя, а не перерисовывается мгновенно: точек всегда столько же, сколько дней в
// периоде, поэтому между старым и новым набором значений можно честно интерполировать.
//
// Почему requestAnimationFrame, а не CSS-переход на атрибуте d: анимация d в CSS поддержана не
// везде одинаково (приложение стоит на айфоне как PWA) и ломается при смене числа точек.
//
// ДВЕ ГРАБЛИ, на которые уже наступили — не повторять:
//   1. Зависимость эффекта — СТРОКА-подпись значений, а не сам массив. Массив values создаётся
//      заново на каждый рендер родителя, и с зависимостью [values] эффект перезапускался бы
//      постоянно, перебивая собственную анимацию: график замирал на первой же серии и больше
//      не менялся, хотя цифра над ним переключалась.
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

export default function MetricLineChart({ values, labels, color = 'var(--accent-brand)', height = 140 }) {
  const [shown, setShown] = useState(values);
  const shownRef = useRef(values); // то, что реально нарисовано прямо сейчас
  const signature = values.join('|');

  useEffect(() => {
    const target = values;
    const start = shownRef.current;

    // Показываем сразу, без анимации, если:
    //   • сменилось количество дней (другой период) — интерполировать не между чем;
    //   • пользователь просил меньше движения в настройках системы;
    //   • страница сейчас скрыта — в фоновой вкладке requestAnimationFrame не вызывается вообще,
    //     и без этой ветки график остался бы на старых значениях до возвращения на вкладку.
    if (start.length !== target.length || prefersReducedMotion() || document.hidden) {
      shownRef.current = target;
      setShown(target);
      return undefined;
    }

    let raf = null;
    const t0 = performance.now();
    function step(now) {
      const k = easeOut(Math.min(1, (now - t0) / DURATION));
      const next = start.map((v, i) => v + (target[i] - v) * k);
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

  const max = Math.max(...shown, 0);
  const min = Math.min(...shown, 0);
  const span = max - min || 1;
  const x = (i) => padX + (i * (w - padX * 2)) / Math.max(1, shown.length - 1);
  const y = (v) => bottom - ((v - min) / span) * (bottom - top);

  const line = shown.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(shown.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  const zeroY = min < 0 ? y(0) : null;

  return (
    <div className="mlc">
      <svg
        className="mlc-svg"
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="График по дням выбранного периода"
      >
        {/* Нулевая линия — только если есть отрицательные значения: иначе она совпала бы
            с нижним краем и была бы просто лишней чертой. */}
        {zeroY !== null && (
          <line x1={padX} y1={zeroY} x2={w - padX} y2={zeroY} stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
        )}
        <path d={area} fill={color} opacity="0.12" />
        <path className="mlc-line" d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {shown.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r="2.6" fill={color} />
        ))}
      </svg>
      <div className="mlc-caption">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}
