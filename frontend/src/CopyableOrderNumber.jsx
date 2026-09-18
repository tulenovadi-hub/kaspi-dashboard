import React, { useEffect, useRef, useState } from 'react';

function copyThroughSelection(value) {
  const previousFocus = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.fontSize = '16px';
  textarea.style.webkitUserSelect = 'text';
  textarea.style.userSelect = 'text';
  textarea.style.webkitTouchCallout = 'default';
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (err) {
    // Современный Clipboard API остаётся последней попыткой ниже.
  } finally {
    document.body.removeChild(textarea);
    if (previousFocus && typeof previousFocus.focus === 'function') {
      previousFocus.focus({ preventScroll: true });
    }
  }
  return copied;
}

async function copyText(value) {
  // Вызов Clipboard API и запасной способ запускаем синхронно внутри настоящего клика.
  // Предыдущий вариант считал один лишь сработавший `copy` event доказательством успеха,
  // хотя Chrome фактически не менял буфер — поэтому галочка была ложной.
  let clipboardWrite = null;
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      clipboardWrite = navigator.clipboard.writeText(value);
    } catch (err) {
      // В старом браузере остаётся синхронное копирование через временное поле.
    }
  }
  const selectionCopied = copyThroughSelection(value);

  if (clipboardWrite) {
    try {
      await clipboardWrite;
      return;
    } catch (err) {
      // Если современный API запрещён, принимаем только результат реального execCommand.
    }
  }
  if (selectionCopied) return;

  throw new Error('Clipboard copy failed');
}

// Единый кликабельный номер заказа для таблиц и мобильных карточек. Это span, а не button:
// в мобильном архиве весь ряд уже является кнопкой. Останавливаем всплытие, чтобы тап по
// номеру только копировал его и не раскрывал/закрывал карточку заодно.
export default function CopyableOrderNumber({ value, className = '' }) {
  const [status, setStatus] = useState('');
  const resetTimer = useRef(null);
  const text = String(value ?? '');

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function handleCopy(event) {
    event.stopPropagation();
    if (!text) return;
    clearTimeout(resetTimer.current);
    try {
      await copyText(text);
      setStatus('copied');
    } catch (err) {
      setStatus('error');
    }
    resetTimer.current = setTimeout(() => setStatus(''), 1600);
  }

  function handleKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleCopy(event);
  }

  const stateClass = status ? ` is-${status}` : '';
  const title = status === 'copied'
    ? 'Номер скопирован'
    : status === 'error'
      ? 'Не удалось скопировать'
      : 'Нажмите, чтобы скопировать номер заказа';

  return (
    <span
      className={`copy-order-number${stateClass}${className ? ` ${className}` : ''}`}
      role="button"
      tabIndex={0}
      title={title}
      aria-label={`${title}: ${text}`}
      onClick={handleCopy}
      onKeyDown={handleKeyDown}
    >
      {text}{status === 'copied' ? ' ✓' : status === 'error' ? ' !' : ''}
    </span>
  );
}
