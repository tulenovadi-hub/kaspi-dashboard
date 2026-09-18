import React, { useState } from 'react';
import { formatMoney, formatNumber } from './dateUtils.js';
import CopyableOrderNumber from './CopyableOrderNumber.jsx';

// Мобильные "Отмены при доставке". На компьютере это таблица на 10 колонок, вторая такая же
// в архиве и три больших абзаца текста. Владелец выбрала из двух макетов (2026-09-09) вариант
// "что нужно сделать": сверху плитки-цифры, свёрнутое примечание, дальше только заказы,
// по которым реально идёт возврат — карточками с кнопкой "+ в остаток" во всю ширину.
// Архив (сотни строк) — отдельным свёрнутым блоком с поиском внизу.
// Второй вариант (все отмены одним списком с цветной полосой статуса) отклонён.
//
// ДВА ТРЕБОВАНИЯ ВЛАДЕЛЬЦА, из-за которых страница выглядит именно так:
//   1. **Длинные примечания должны сворачиваться.** Три абзаца с компьютера сведены в один
//      блок под кнопкой "Как это работает" и по умолчанию закрыты.
//   2. **Архив в цифрах не участвует.** Первая версия макета показывала "ждут в пункте
//      выдачи: 2", а это были две архивные записи от декабря 2025 с in_return_flow: false —
//      возврат по ним давно закрыт. Теперь ВСЕ цифры считаются по активным заказам.
//      Плитка остаётся на месте и с нулём: ноль здесь — это ответ "забирать нечего",
//      а не отсутствие показателя (так попросила владелец).

const ARCHIVE_STEP = 20;

function Chevron() {
  return (
    <svg className="dm-chevron" viewBox="0 0 8 12" width="7" height="10" aria-hidden="true" focusable="false">
      <path d="M1.6 1.4 6 6l-4.4 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function DeliveryReturnsMobile({
  activeReturns, archivedOrders, totalCount, thresholdDays,
  subtractedUnits, subtractedInArchive, suspiciousCount, waitingCount,
  search, onSearch,
  statusLabel, reasonLabel, wonderLabel, isHighlighted, isDone, showStockButton,
  onToggleStock, togglingId, onArchive, archivingId, onUnarchive, unarchivingId,
  onSync, onLookup, lookupResult, lookupRaw, syncing, loading, isOnline,
}) {
  const [showNote, setShowNote] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [archiveLimit, setArchiveLimit] = useState(ARCHIVE_STEP);
  const [openOrder, setOpenOrder] = useState(null);

  const shownArchive = archivedOrders.slice(0, archiveLimit);
  const [lookupNumber, setLookupNumber] = useState('');

  return (
    <div className="dm">
      {/* Плитки вместо абзаца-сводки. Считаются ТОЛЬКО по активным заказам — архив сюда
          не входит. Ноль в плитках не прячем: "ждут в пункте выдачи: 0" — это ответ. */}
      <div className="dm-tally">
        <div className="dm-tile">
          <span className="dm-tile-value">{formatNumber(subtractedUnits)} шт</span>
          <span className="dm-tile-label">вычтено со «Склада»</span>
        </div>
        <div className={`dm-tile${suspiciousCount ? ' dm-tile-down' : ''}`}>
          <span className="dm-tile-value">{formatNumber(suspiciousCount)}</span>
          <span className="dm-tile-label">без движения {thresholdDays}+ дней</span>
        </div>
        <div className={`dm-tile${waitingCount ? ' dm-tile-warn' : ''}`}>
          <span className="dm-tile-value">{formatNumber(waitingCount)}</span>
          <span className="dm-tile-label">ждут в пункте выдачи</span>
        </div>
      </div>

      {/* Заказ могли убрать крестиком, не вернув товар в остаток: тогда штуки со "Склада"
          вычтены, а в плитке выше их нет — она считает активные. Молчать об этом нельзя. */}
      {subtractedInArchive > 0 && (
        <div className="dm-warn-line">
          Ещё {plural(subtractedInArchive, 'заказ', 'заказа', 'заказов')} вычтены со «Склада», но убраны в архив
        </div>
      )}

      <button
        className="dm-note-toggle"
        aria-expanded={showNote}
        onClick={() => setShowNote((v) => !v)}
      >
        <span>Как это работает</span>
        <Chevron />
      </button>
      <div className={`wm-collapsible${showNote ? ' is-open' : ''}`}>
        <div>
          <div className="dm-note">
            <p>
              В списке — заказы, отменённые при доставке. Пока товар не принят обратно, на «Складе»
              эти штуки <b>вычтены из остатка</b> колонкой «Возвращается».
            </p>
            <p>
              Убедились, что коробка физически доехала, — нажмите <b>«+ в остаток»</b>, только тогда
              штуки вернутся. Промахнулись — та же кнопка станет красной <b>«− из остатка»</b> и
              вернёт всё назад. Само по себе «Вернулся на склад» в трекинге Kaspi остаток
              <b> не меняет</b>.
            </p>
            <p>
              Статус берётся из настоящего трекинга Kaspi Delivery; подозрительный — если движения
              нет {thresholdDays}+ дней. «Принят складом» — сверка со списком возвратов у партнёра
              Wonder. Список обновляется каждую ночь; «В архив» убирает строку вниз страницы.
            </p>
            <p>
              <b>Архив</b> — отмены, по которым возврат уже не идёт: товар вернулся на склад или его
              вообще не отправляли. Остаток на «Складе» они не уменьшают и в цифры сверху не входят.
            </p>
          </div>
        </div>
      </div>

      <div className="dm-sec">
        <span>В возврате · {activeReturns.length}</span>
        <button className="dm-link" onClick={onSync} disabled={syncing}>
          {syncing ? 'Проверяю…' : 'Проверить сейчас'}
        </button>
      </div>

      {/* Точечный поиск по номеру: полная проверка ищет только заказы, СОЗДАННЫЕ за последние
          три недели (так фильтрует Kaspi), и отмену давнего заказа не находит совсем. */}
      <div className="dm-lookup">
        <input
          type="text"
          inputMode="numeric"
          placeholder="Номер заказа из кабинета"
          value={lookupNumber}
          onChange={(event) => setLookupNumber(event.target.value.replace(/\D/g, ''))}
        />
        <button className="dm-link" onClick={() => onLookup(lookupNumber)} disabled={syncing || !lookupNumber}>
          Найти
        </button>
      </div>
      {lookupResult && <div className="dm-lookup-result">{lookupResult}</div>}
      {lookupRaw && (
        <details className="dm-raw">
          <summary>Данные Kaspi по этому заказу</summary>
          <button onClick={() => navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(lookupRaw, null, 2))}>
            Скопировать
          </button>
          <pre>{JSON.stringify(lookupRaw, null, 2)}</pre>
        </details>
      )}

      <div style={{ opacity: loading || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        {totalCount === 0 ? (
          <div className="empty-state">Сейчас нет заказов, отменённых при доставке</div>
        ) : activeReturns.length === 0 ? (
          <div className="empty-state">Сейчас нет заказов в возврате</div>
        ) : activeReturns.map((o) => (
          <div key={o.order_number} className={`dm-task${isHighlighted(o) ? ' dm-task-alert' : ''}`}>
            <div className="dm-task-top">
              <div>
                <div className="dm-task-name">
                  {o.product_names || 'Товар не указан'}
                  {o.quantity > 1 && <span className="orders-item-qty"> × {o.quantity}</span>}
                </div>
                <span className={`dm-badge${isHighlighted(o) ? (o.suspicious ? ' dm-badge-alert' : ' dm-badge-wait') : isDone(o) ? ' dm-badge-done' : ''}`}>
                  {statusLabel(o)}
                </span>
              </div>
              <div className="dm-task-sum">{formatMoney(o.total_price)}</div>
            </div>

            <dl className="dm-meta">
              <dt>№ заказа</dt><dd><CopyableOrderNumber value={o.order_number} /></dd>
              <dt>Создан</dt><dd>{formatDate(o.creation_date)}</dd>
              <dt>Без движения</dt>
              <dd className={o.suspicious ? 'dm-bad' : ''}>
                {plural(o.days_since_last_track !== null ? o.days_since_last_track : o.days_since, 'день', 'дня', 'дней')}
              </dd>
              <dt>Причина</dt><dd className="dm-text">{reasonLabel(o)}</dd>
              <dt>Город отгрузки</dt><dd className="dm-text">{o.origin_city || '—'}</dd>
              <dt>Принят складом</dt>
              <dd className={o.wonder_received === false ? 'dm-bad' : ''}>{wonderLabel(o)}</dd>
            </dl>

            <div className="dm-actions">
              {showStockButton(o) && (
                <button
                  className={`dm-btn-main${o.subtracted_from_stock ? '' : ' dm-btn-undo'}`}
                  onClick={() => onToggleStock(o)}
                  disabled={togglingId === o.order_number}
                >
                  {togglingId === o.order_number ? '…' : (o.subtracted_from_stock ? '+ в остаток' : '− из остатка')}
                </button>
              )}
              <button
                className="dm-btn-quiet"
                onClick={() => onArchive(o.order_number)}
                disabled={archivingId === o.order_number}
              >
                В архив
              </button>
            </div>
          </div>
        ))}

        {archivedOrders.length > 0 && (
          <>
            <div className="dm-sec"><span>Архив · {formatNumber(archivedOrders.length)}</span></div>
            <button
              className="dm-note-toggle"
              aria-expanded={showArchive}
              onClick={() => setShowArchive((v) => !v)}
            >
              <span>{showArchive ? 'Свернуть архив' : 'Показать архив'}</span>
              <Chevron />
            </button>

            {showArchive && (
              <div className="dm-archive-list">
                <input
                  className="dm-search"
                  type="search"
                  placeholder="Номер заказа или товар"
                  value={search}
                  onChange={(e) => { onSearch(e.target.value); setArchiveLimit(ARCHIVE_STEP); }}
                />
                <div className="dm-list">
                  {shownArchive.length === 0 ? (
                    <div className="empty-state">Ничего не найдено</div>
                  ) : shownArchive.map((o) => {
                    const isOpen = openOrder === o.order_number;
                    return (
                      <button
                        key={o.order_number}
                        className="dm-row"
                        aria-expanded={isOpen}
                        onClick={() => setOpenOrder((prev) => (prev === o.order_number ? null : o.order_number))}
                      >
                        <span className="dm-row-name">{o.product_names || 'Товар не указан'}</span>
                        <span className="dm-row-sum">{formatMoney(o.total_price)}</span>
                        <span className="dm-row-meta">
                          {formatDate(o.creation_date)} · №&nbsp;<CopyableOrderNumber value={o.order_number} /> ·{' '}
                          <i className={isDone(o) ? 'dm-good' : ''}>{statusLabel(o)}</i>
                        </span>
                        <span />
                        {isOpen && (
                          <span className="dm-row-detail">
                            <span className="dm-line"><span>Причина</span><span>{reasonLabel(o)}</span></span>
                            <span className="dm-line"><span>Город отгрузки</span><span>{o.origin_city || '—'}</span></span>
                            <span className="dm-line"><span>Принят складом</span><span>{wonderLabel(o)}</span></span>
                            <span className="dm-line">
                              <span>Остаток на «Складе»</span>
                              <span>{o.subtracted_from_stock ? 'вычтено' : 'в остатке'}</span>
                            </span>
                            {/* Убрали крестиком, а товар так и не вернули в остаток — кнопка
                                должна быть доступна и здесь, иначе штуки застрянут вычтенными. */}
                            {showStockButton(o, 'archive') && (
                              <span
                                className="dm-btn-main dm-btn-inline"
                                role="button"
                                tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); onToggleStock(o); }}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onToggleStock(o); } }}
                              >
                                {togglingId === o.order_number ? '…' : '+ в остаток'}
                              </span>
                            )}
                            {o.archived_at && o.in_return_flow && (
                              <span
                                className="dm-btn-unarchive"
                                role="button"
                                tabIndex={0}
                                aria-disabled={unarchivingId === o.order_number}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (unarchivingId !== o.order_number) onUnarchive(o.order_number);
                                }}
                                onKeyDown={(e) => {
                                  if ((e.key === 'Enter' || e.key === ' ') && unarchivingId !== o.order_number) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onUnarchive(o.order_number);
                                  }
                                }}
                              >
                                {unarchivingId === o.order_number ? 'Возвращаю…' : 'Вернуть из архива'}
                              </span>
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {shownArchive.length < archivedOrders.length && (
                  <button className="dm-more" onClick={() => setArchiveLimit((v) => v + ARCHIVE_STEP)}>
                    Показать ещё {Math.min(ARCHIVE_STEP, archivedOrders.length - shownArchive.length)} · осталось{' '}
                    {formatNumber(archivedOrders.length - shownArchive.length)}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="report-note">
        Всего отслеживается за всю историю: {formatNumber(totalCount)}.
      </div>
    </div>
  );
}
