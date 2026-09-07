import { useEffect, useState } from 'react';

// Ширина, ниже которой страница считается "телефоном". 700px, а не 480: на этой границе
// уже начинает ломаться широкая таблица (см. .report-row в styles.css), и именно её
// используют мобильные правила на страницах — держим одно число, чтобы вёрстка и логика
// переключались одновременно, а не в разные моменты.
export const MOBILE_BREAKPOINT = 700;

// Нужен там, где мобильная версия — это не другая вёрстка одного и того же DOM, а другой
// компонент целиком (например, "Отчёт": на компьютере таблицы, на телефоне — список).
// Через CSS такое не решается: рисовать оба дерева и прятать одно из них — значит грузить
// разбивки по товарам дважды.
export function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(
    () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches)
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    function update(e) { setIsMobile(e.matches); }
    setIsMobile(mql.matches);
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return isMobile;
}
