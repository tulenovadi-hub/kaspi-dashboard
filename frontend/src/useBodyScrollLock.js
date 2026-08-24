import { useEffect } from 'react';

// Блокирует прокрутку страницы под открытой модалкой.
//
// Почему не просто overflow: hidden на body: в iOS Safari (а приложение стоит на телефоне
// как PWA) этого недостаточно — страница под модалкой всё равно продолжает прокручиваться,
// и пользователь видит, как вместо содержимого окна уезжает фон. Надёжно работает только
// position: fixed на body — но он сбрасывает позицию прокрутки в начало страницы, поэтому
// запоминаем её перед блокировкой и возвращаем на место после закрытия окна.
export function useBodyScrollLock() {
  useEffect(() => {
    const { body } = document;
    const scrollY = window.scrollY;
    const saved = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    return () => {
      body.style.position = saved.position;
      body.style.top = saved.top;
      body.style.width = saved.width;
      body.style.overflow = saved.overflow;
      // instant, а не плавно: для пользователя это должно выглядеть как "ничего не двигалось",
      // пока окно было открыто, а не как прыжок страницы после закрытия.
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, []);
}
