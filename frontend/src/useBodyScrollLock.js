import { useEffect } from 'react';

// Блокирует прокрутку страницы под открытой модалкой.
//
// Почему не просто overflow: hidden на body: в iOS Safari (а приложение стоит на телефоне
// как PWA) этого недостаточно — страница под модалкой всё равно продолжает прокручиваться,
// и пользователь видит, как вместо содержимого окна уезжает фон. Надёжно работает только
// position: fixed на body — но он сбрасывает позицию прокрутки в начало страницы, поэтому
// запоминаем её перед блокировкой и возвращаем на место после закрытия окна.
// Цвет фона страницы под открытой модалкой: это var(--bg) (#0e1420), уже перекрытый
// подложкой окна rgba(6, 9, 16, 0.65) из .modal-overlay. Нужен из-за бага короткого окна на
// iPhone (см. комментарии в index.html): полосу под окном рисует система цветом фона страницы,
// и если фон не притемнить, у нижнего края модалки получается заметный стык — владелец назвал
// его "рамкой снизу". Если будете менять --bg или прозрачность .modal-overlay — пересчитайте
// и это значение, иначе стык вернётся.
const MODAL_BACKDROP_BG = '#090d16';

export function useBodyScrollLock() {
  useEffect(() => {
    const { body } = document;
    const scrollY = window.scrollY;
    const saved = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
      background: body.style.background,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.background = MODAL_BACKDROP_BG;

    return () => {
      body.style.position = saved.position;
      body.style.top = saved.top;
      body.style.width = saved.width;
      body.style.overflow = saved.overflow;
      body.style.background = saved.background;
      // instant, а не плавно: для пользователя это должно выглядеть как "ничего не двигалось",
      // пока окно было открыто, а не как прыжок страницы после закрытия.
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, []);
}
