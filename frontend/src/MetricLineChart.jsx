import React, { useEffect, useRef, useState } from 'react';

// График на мобильной "Главной". Отличие от SalesChart на компьютере — линия ПЕРЕЕЗЖАЕТ при
// смене показателя, а не перерисовывается мгновенно: точек всегда столько же, сколько дней в
// периоде, поэтому между старым и новым набором значений можно честно интерполировать.
//
// Почему requestAnimationFrame, а не CSS-переход на атрибуте d: анимация свойства d в CSS
// поддерживается не везде одинаково (а приложение стоит на айфоне как PWA), и любая смена
// количества точек её ломает. Интерполяция по кадрам работает предсказуемо и заодно позволяет
// плавно менять масштаб оси — у выручки и заказов он отличается на три порядка.

const DURATION = 380;

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Плавная кривая в стиле "ease-out": быстро стартует, мягко тормозит.
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export default function MetricLineChart({ values, labels, color = 'var(--accent-brand)', height = 140 }) {
  const [shown, setShown] = useState(values);
  const fromRef = useRef(values);
  const rafRef = useRef(null);

  useEffect(() => {
    const target = values;
    const start = fromRef.current;

    // Количество дней изменилось (сменили период) — анимировать нечего, показываем сразу.
    if (start.length !== target.length || prefersReducedMotion()) {
      fromRef.current = target;
      setShown(target);
      return undefined;
    }

    const t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / DURATION);
      const k = easeOut(t);
      setShown(start.map((v, i) => v + (target[i] - v) * k));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    }
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // Прервали на середине — запоминаем то, что реально на экране, иначе следующая
      // анимация стартует с чужого места и линия дёрнется.
      fromRef.current = shown.length === target.length ? shown : target;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

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
        {/* Нулевая линия рисуется, только если есть отрицательные значения — иначе она
            совпала бы с нижним краем и была бы просто лишней чертой. */}
        {zeroY !== null && (
          <line x1={padX} y1={zeroY} x2={w - padX} y2={zeroY} stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
        )}
        <path d={area} fill={color} opacity="0.12" />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
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
