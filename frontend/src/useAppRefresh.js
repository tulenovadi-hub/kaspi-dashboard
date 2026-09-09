import { useEffect, useState } from 'react';

// Общий сигнал "перезапроси данные" для всех страниц.
//
// Зачем: жест "потяни вниз, чтобы обновить" сначала делал `window.location.reload()`, и страница
// на секунду ПРОПАДАЛА — белый экран, потом всё появлялось заново. Владелец 2026-09-09:
// «у нас же есть функция затемнения всех элементов в офлайн-режиме, пусть при обновлении просто
// так же затемняется, а не пропадает». Затемнение у страниц уже было (`opacity: 0.55`, когда
// `loading` или нет сети) — не хватало только способа перезапросить данные, не размонтируя
// страницу. Этим способом и стал этот хук: DOM остаётся на месте, поднимается `loading`,
// страница тускнеет и наливается обратно с новыми числами.
//
// Как пользоваться на странице:
//   const refreshTick = useAppRefresh(active);
//   useEffect(() => { if (active) loadData(); }, [active, password, refreshTick]);
//
// Неактивные страницы (Dashboard держит уже открытые смонтированными) сигнал не слушают —
// им незачем: при возврате на страницу её эффект и так перезапустится по смене `active`.
//
// Чего этот способ НЕ делает: не подтягивает новую версию фронтенда с Vercel — для этого
// нужна настоящая перезагрузка. Обновление кода прилетает при следующем запуске приложения.

export const APP_REFRESH_EVENT = 'app:refresh';

export function requestAppRefresh() {
  window.dispatchEvent(new Event(APP_REFRESH_EVENT));
}

export function useAppRefresh(active = true) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const handler = () => setTick((v) => v + 1);
    window.addEventListener(APP_REFRESH_EVENT, handler);
    return () => window.removeEventListener(APP_REFRESH_EVENT, handler);
  }, [active]);

  return tick;
}
