import React, { useEffect, useRef, useState } from 'react';

// Табло: каждая цифра — своя вертикальная лента 0…9, и при смене значения ленты
// перематываются на нужную цифру, справа налево, с небольшой задержкой друг за другом.
// Придумано под этот дашборд: все денежные значения набраны моноширинным шрифтом
// (--font-mono), поэтому колонки одинаковой ширины и строка не «дышит» при перемотке.
//
// Где применяется: только крупные итоговые числа (выручка, прибыль, средний чек, расходы
// за месяц). В таблицах и списках этого НЕ делаем — тридцать перематывающихся строк
// читаются как рябь, а не как эффект.
//
// Числа не пересчитываются по кадрам: анимирует CSS (transform ленты), JS только
// расставляет цифры. Поэтому эффект ничего не стоит при прокрутке и сам отключается
// при `prefers-reduced-motion` — глобальное правило в начале styles.css обнуляет
// длительность перехода, и цифра просто встаёт на место.

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export default function Odometer({ value, format, className = '' }) {
  const text = format ? format(value) : String(value);

  // Первый показ начинается с нулей и «разгоняется» до настоящего числа: без этого
  // при заходе на страницу перематывать было бы не с чего, и эффект пропал бы там,
  // где он нужнее всего — на первом взгляде на цифру.
  const [shown, setShown] = useState(() => text.replace(/\d/g, '0'));
  const raf = useRef(null);
  const fallback = useRef(null);

  useEffect(() => {
    // Ждём кадр: лента должна сначала отрисоваться на старом значении, иначе браузер
    // объединит оба состояния в одно и перехода не будет вовсе.
    //
    // Второй, страховочный таймер — на случай, когда кадров нет вообще: в свёрнутом
    // приложении и в фоновой вкладке requestAnimationFrame не вызывается ВООБЩЕ, и без
    // страховки на экране осталось бы «000 тыс ₸» вместо настоящей суммы. Таймер в фоне
    // тоже придерживают, но он всё-таки срабатывает. Кто первый — тот и ставит значение;
    // второй вызов ничего не меняет, значение то же самое.
    cancelAnimationFrame(raf.current);
    clearTimeout(fallback.current);
    raf.current = requestAnimationFrame(() => setShown(text));
    fallback.current = setTimeout(() => setShown(text), 250);
    return () => {
      cancelAnimationFrame(raf.current);
      clearTimeout(fallback.current);
    };
  }, [text]);

  // Длина строки меняется (было «9 999 ₸», стало «10 000 ₸») — тогда лишние колонки
  // просто появляются, перематывать в них нечего.
  const chars = shown.length === text.length ? shown : text;
  const total = chars.length;

  return (
    <span className={`odometer ${className}`.trim()} aria-label={text} role="text">
      {chars.split('').map((ch, i) => {
        if (!/\d/.test(ch)) {
          // Пробелы, «₸», минус, запятая — обычным текстом, они не крутятся.
          return <span key={i} className="odometer-static">{ch}</span>;
        }
        return (
          <span key={i} className="odometer-col">
            <span
              className="odometer-strip"
              style={{
                transform: `translateY(${-Number(ch) * 10}%)`,
                // Справа налево: младшие разряды трогаются первыми, старшие догоняют —
                // так это читается как счётчик, а не как одновременный подскок всей строки.
                transitionDelay: `${Math.min(total - i - 1, 8) * 45}ms`,
              }}
            >
              {DIGITS.map((d) => (
                <span key={d} className="odometer-digit">{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
