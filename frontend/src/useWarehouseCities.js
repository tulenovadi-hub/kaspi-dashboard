import { useEffect, useState } from 'react';
import { fetchWarehouseCities } from './api.js';

// Состав складов меняется на странице "Настройки", поэтому подписи вроде "Основной отчёт (Алматы,
// Астана)" собираются из ответа сервера и перечитываются при каждом открытии страницы.
// FALLBACK нужен только на первую отрисовку, пока ответа ещё нет.
const FALLBACK = {
  main: ['Алматы', 'Астана'],
  selfbuy: ['Явленка', 'Юбилейное', 'Талдыкорган', 'Атырау'],
  display: ['Алматы', 'Астана'],
  all: ['Алматы', 'Астана'],
};

export function useWarehouseCities(password, active = true) {
  const [cities, setCities] = useState(FALLBACK);

  useEffect(() => {
    if (!active) return;
    fetchWarehouseCities(password).then(setCities).catch(() => {});
  }, [password, active]);

  return cities;
}
