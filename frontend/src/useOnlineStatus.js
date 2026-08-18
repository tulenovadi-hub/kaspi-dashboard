import { useEffect, useState } from 'react';

// Просто обёртка над navigator.onLine + событиями online/offline браузера — используется,
// чтобы показывать данные притемнёнными, пока не подтверждено, что они не устарели
// (см. use в страницах: opacity зависит от loading || !isOnline).
export function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    function goOnline() { setOnline(true); }
    function goOffline() { setOnline(false); }
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
