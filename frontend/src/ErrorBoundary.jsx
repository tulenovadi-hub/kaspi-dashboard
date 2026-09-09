import React from 'react';

// Предохранитель: ловит исключение при отрисовке и показывает сообщение вместо того, чтобы
// уронить всё приложение. Появился 2026-09-09 после того, как опечатка в "Поставках"
// (`refreshTick is not defined`) сделала белым ВЕСЬ дашборд: разделы живут в одном дереве и
// держатся смонтированными (см. Dashboard.jsx), поэтому исключение в одном из них React
// лечит единственным способом — размонтирует корень целиком.
//
// Ловится только то, что падает во время отрисовки, в конструкторе или в эффекте. НЕ ловятся
// ошибки в обработчиках событий и в промисах (там уже есть свои .catch с error-banner) —
// это ограничение самого React, а не недоделка.
//
// Границы стоят вокруг КАЖДОЙ страницы отдельно, а не одна на всё приложение: упавший раздел
// не должен уносить с собой соседние, в которых уже загружены данные.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // На айфоне консоль недоступна, поэтому текст ошибки дублируется на экран — его можно
    // прислать скриншотом. Здесь же он остаётся для отладки на компьютере.
    console.error(`Упала страница «${this.props.title || 'приложение'}»:`, error, info.componentStack);
  }

  handleRetry() {
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;

    // Упасть страница может и в фоне (разделы отрисовываются, даже когда скрыты) — тогда
    // сообщение обязано остаться скрытым вместе с ней, иначе оно вылезет поверх открытого раздела.
    const style = this.props.hidden ? { display: 'none' } : undefined;

    return (
      <div style={style}>
        <div className="card page-error">
          <div className="page-error-title">
            {this.props.title ? `Раздел «${this.props.title}» не открылся` : 'Приложение не запустилось'}
          </div>
          <div className="page-error-text">
            {this.props.title
              ? 'Остальные разделы работают — можно открыть меню и перейти в другой.'
              : 'Перезапустите приложение. Если не поможет — пришлите этот текст.'}
          </div>
          <div className="page-error-message">{String(this.state.error && this.state.error.message || this.state.error)}</div>
          <div className="page-error-actions">
            <button className="primary-button" onClick={this.handleRetry}>Попробовать снова</button>
            <button className="sync-button" onClick={() => window.location.reload()}>Перезапустить приложение</button>
          </div>
        </div>
      </div>
    );
  }
}
