import { useEffect, useState } from 'react';
import { getFetchedAt } from './api.js';

const STALE_AFTER_MS = 60 * 60 * 1000; // 60 минут — порог, после которого данные на экране считаются устаревшими

// Раз в минуту перерисовывает компонент, чтобы "устарелость" данных включалась сама по себе
// просто от того, что прошло время — не только в момент новой загрузки/перехода на страницу.
function useClockTick(intervalMs = 60000) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

// pathPrefixes — префиксы путей API, за которыми "числится" эта страница (см. api.js —
// getFetchedAt берёт заголовок Date самого свежего HTTP-ответа, а не момент, когда страница
// прочитала его из кэша, поэтому честно отражает реальный возраст данных, даже если ответ
// пришёл из Cache Storage мгновенно). true — данные ещё ни разу не подтверждались сетью, либо
// подтверждались более 60 минут назад.
export function useStaleData(pathPrefixes) {
  useClockTick();
  const fetchedAt = getFetchedAt(pathPrefixes);
  if (!fetchedAt) return true;
  return Date.now() - fetchedAt > STALE_AFTER_MS;
}
