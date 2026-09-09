import React, { useEffect, useRef, useState } from 'react';

// "Потяни вниз, чтобы обновить" — для ВСЕХ страниц сразу. Владелец попросила 2026-09-09:
// "как это обычно работает на веб-сайтах".
//
// Почему это вообще пришлось писать: приложение стоит на айфоне как PWA (standalone), а в этом
// режиме Safari СВОЙ pull-to-refresh не показывает — он есть только во вкладке браузера.
// Поэтому жест приходится ловить самим.
//
// Что делает жест: `window.location.reload()`. Это честнее, чем перезапрашивать данные текущей
// страницы: страницы грузят себя сами в useEffect по `active`, у каждой свой набор запросов, и
// единой "перезагрузи всё" ручки нет. Полная перезагрузка заодно подтягивает обновившийся
// фронтенд с Vercel. Открытый раздел при этом сохраняется (см. sessionStorage в Dashboard.jsx),
// так что после обновления остаёшься на той же странице.
//
// ГРАБЛИ, которые уже учтены:
//   1. Жест ловим ТОЛЬКО когда страница реально в самом верху (scrollY <= 0) и палец повёл
//      вниз больше, чем вбок — иначе он перебивал бы горизонтальные полосы чипсов и месяцев.
//   2. Под открытой модалкой (её блокировка ставит body в position: fixed) жест выключен:
//      там scrollY всегда 0, и любой свайп по листу фильтров означал бы перезагрузку.
//   3. touchmove слушаем с { passive: false } и гасим событие — иначе айфон одновременно
//      тянет всю страницу резинкой, и индикатор дёргается вместе с ней.
//   4. Порог 70px и сопротивление: тянуть надо осознанно, случайный свайп по инерции
//      страницу не перезагрузит.

const THRESHOLD = 70; // сколько нужно протянуть, чтобы жест сработал
const MAX_PULL = 110; // дальше индикатор не едет, как бы сильно ни тянули

export function usePullToRefresh(enabled = true) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(null);
  const startX = useRef(null);
  const decided = useRef(null); // null — ещё не поняли, 'pull' или 'ignore'
  // Текущее натяжение держим ещё и в ref: решение "хватит ли, чтобы обновить" принимается
  // в обработчике touchend, а состояние там было бы из замыкания того рендера, где эффект
  // создавался. Класть побочный эффект (перезагрузку) внутрь функционального setState нельзя —
  // апдейтер обязан быть чистым.
  const pullRef = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;

    function locked() {
      // Модалка открыта: useBodyScrollLock ставит body в position: fixed.
      return document.body.style.position === 'fixed';
    }

    function onStart(e) {
      if (refreshing || locked() || e.touches.length !== 1 || window.scrollY > 0) {
        startY.current = null;
        return;
      }
      startY.current = e.touches[0].clientY;
      startX.current = e.touches[0].clientX;
      decided.current = null;
    }

    function onMove(e) {
      if (startY.current === null || refreshing) return;
      const dy = e.touches[0].clientY - startY.current;
      const dx = e.touches[0].clientX - startX.current;

      if (decided.current === null) {
        // Ждём, пока станет понятно, куда ведут палец: 8px хватает, чтобы отличить
        // вертикальный жест от листания полосы чипсов вбок.
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
        decided.current = dy > 0 && Math.abs(dy) > Math.abs(dx) ? 'pull' : 'ignore';
      }
      if (decided.current !== 'pull') return;
      if (window.scrollY > 0) { pullRef.current = 0; setPull(0); startY.current = null; return; }

      // Сопротивление: чем дальше тянешь, тем медленнее едет — так ведут себя нативные списки.
      const distance = Math.min(MAX_PULL, dy * 0.5);
      if (distance > 0) {
        if (e.cancelable) e.preventDefault();
        pullRef.current = distance;
        setPull(distance);
      }
    }

    function onEnd() {
      if (startY.current === null) return;
      startY.current = null;
      const distance = pullRef.current;
      if (distance >= THRESHOLD && !locked()) {
        pullRef.current = THRESHOLD;
        setPull(THRESHOLD);
        setRefreshing(true);
        // Небольшая пауза — чтобы индикатор успел показать, что обновление началось,
        // а не мигнул и исчез вместе со страницей.
        setTimeout(() => window.location.reload(), 220);
        return;
      }
      pullRef.current = 0;
      setPull(0);
    }

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, refreshing]);

  return { pull, refreshing, threshold: THRESHOLD };
}

// Индикатор: кружок со стрелкой, который едет за пальцем и разворачивается на пороге.
// Рисуем svg, а не символ: стрелки-эмодзи на айфоне подменяются цветными и выбиваются из стиля.
export function PullToRefreshIndicator({ pull, refreshing, threshold }) {
  if (!pull && !refreshing) return null;
  const ready = pull >= threshold;
  return (
    <div
      className={`ptr${refreshing ? ' ptr-refreshing' : ''}`}
      style={{ transform: `translate(-50%, ${Math.round(pull)}px)`, opacity: Math.min(1, pull / 30) }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" className={ready || refreshing ? 'ptr-arrow ptr-arrow-ready' : 'ptr-arrow'}>
        <path
          d="M12 4v13M6.5 11.5 12 17l5.5-5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
