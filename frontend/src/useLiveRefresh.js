import { useEffect, useRef, useState } from 'react';

// Страница сначала мгновенно показывает данные из кэша (см. sw.js — stale-while-revalidate),
// а service worker в фоне тихо проверяет сеть. Если фоновый ответ реально отличается от того,
// что уже на экране, service worker шлёт postMessage — этот хук подписывается на такие сообщения
// (по префиксу пути, напр. '/api/batches') и сам вызывает переданную функцию перезагрузки данных.
// Пока идёт перезагрузка, возвращает dimmed=true — страница на это время притемняется (тот же
// приём, что и у кнопки "Обновить сейчас" на Главной), чтобы обновление было заметно на глазах.
export function useLiveRefresh(paths, reload) {
  const [dimmed, setDimmed] = useState(false);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const pathsKey = paths.join(',');

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;

    function runReload() {
      if (busyRef.current) {
        // Уже перезагружаемся — не запускаем второй раз параллельно, а просто запомним,
        // что после текущей перезагрузки нужно повторить (данные успели измениться ещё раз).
        pendingRef.current = true;
        return;
      }
      busyRef.current = true;
      setDimmed(true);
      Promise.resolve()
        .then(() => reloadRef.current())
        .catch(() => {})
        .finally(() => {
          busyRef.current = false;
          setDimmed(false);
          if (pendingRef.current) {
            pendingRef.current = false;
            runReload();
          }
        });
    }

    function handleMessage(event) {
      const data = event.data;
      if (!data || data.type !== 'kaspi-data-updated') return;
      const relevant = pathsKey.split(',').some((p) => p && data.pathname.startsWith(p));
      if (relevant) runReload();
    }

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  return dimmed;
}
