import { useCallback, useEffect, useRef, useState } from 'react';

// Закрытие модалки/шторки с анимацией. Открытие анимируется само (элемент появляется в DOM,
// и CSS-анимация играет при монтировании), а вот закрытие — нет: React выкидывает элемент
// мгновенно, и уход не видно. Хук держит окно на месте ещё `ms` миллисекунд, пока идёт
// анимация ухода, и только потом зовёт настоящий onClose родителя.
//
// Применение: `const { closing, close } = useClosing(onClose);` — дальше `close` вешается на
// крестик и на клик по подложке, а `closing` подмешивает класс `is-closing` (см. styles.css).
// Число 190 мс совпадает с длительностью анимаций ухода; меняешь одно — меняй и второе.
export function useClosing(onClose, ms = 190) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);

  // Если родитель размонтирует окно раньше (например, после сохранения), таймер надо снять,
  // иначе onClose дёрнется у уже мёртвого компонента.
  useEffect(() => () => clearTimeout(timer.current), []);

  const close = useCallback(() => {
    if (timer.current) return; // повторное нажатие во время ухода не должно ставить второй таймер
    setClosing(true);
    timer.current = setTimeout(() => {
      // Сбрасываем состояние ДО onClose: модалка после него размонтируется, и сброс ей
      // безразличен, а вот выезжающее меню в Sidebar живёт дальше — без сброса оно бы
      // открылось в следующий раз сразу с классом ухода и больше не закрывалось.
      timer.current = null;
      setClosing(false);
      onClose();
    }, ms);
  }, [onClose, ms]);

  return { closing, close };
}
