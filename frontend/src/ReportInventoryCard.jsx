import React, { useEffect, useState } from 'react';
import { fetchInventoryAsOf } from './api.js';
import { formatDateDMY, formatMoney, formatMonthLabel, formatNumber } from './dateUtils.js';

// "Фактически в товаре": сумма со "Склада" плюс товар, который из остатка ушёл, а к покупателю ещё
// не попал. Показывает сейчас либо конец завершённого месяца, то есть начало следующего по Алматы
// (backend/inventoryAsOf.js). Это снимок на момент, поэтому карточка, а не колонка таблиц.

const FIRST_REPORT_MONTH = '2026-06';
const BUCKET_LABELS = { to_customers: 'К клиенту', returning: 'Обратно к нам', unresolved: 'Не определено' };

function nextMonthStart(month) {
  const [year, number] = month.split('-').map(Number);
  return number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, '0')}-01`;
}

const almatyToday = () => new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);

function OrdersList({ lines }) {
  if (lines.length === 0) return null;
  return (
    <details className="report-inventory-orders">
      <summary>Заказы в пути: {formatNumber(lines.length)}</summary>
      <div className="table-scroll">
        <table className="product-table">
          <thead>
            <tr>
              <th>Заказ</th>
              <th>Создан</th>
              <th>Товар</th>
              <th>Склад</th>
              <th className="num">Шт</th>
              <th className="num">Себестоимость</th>
              <th>Где</th>
              <th>Оценка</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={`${line.order_code}-${line.product_id}`}>
                <td>{line.order_code}</td>
                <td>{formatDateDMY(line.created_at)}</td>
                <td>{line.product_name}</td>
                <td>{line.warehouse}</td>
                <td className="num">{formatNumber(line.quantity)}</td>
                <td className="num">{formatMoney(line.value)}</td>
                <td>{BUCKET_LABELS[line.bucket]}</td>
                <td className="report-inventory-note">{line.reason || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Parts({ data, past }) {
  return (
    <>
      <div className="stat-card-hint">
        {past
          ? <>Склад {formatMoney(data.stock_value)} + поставки {formatMoney(data.in_transit_value)}</>
          : <>Склад и поставки {formatMoney(data.total)}</>}
        {' + '}к клиентам {formatMoney(data.to_customers_value)} ({formatNumber(data.to_customers_quantity)} шт)
        {' + '}отмены едут к нам {formatMoney(data.returning_value)} ({formatNumber(data.returning_quantity)} шт)
      </div>
      {data.estimated_quantity > 0 && (
        <div className="stat-card-hint report-inventory-warning">
          Из них оценка: {formatMoney(data.estimated_value)} ({formatNumber(data.estimated_quantity)} шт)
        </div>
      )}
      {data.unresolved_quantity > 0 && (
        <div className="stat-card-hint report-inventory-warning">
          Не определено, в сумму не вошло: {formatMoney(data.unresolved_value)} ({formatNumber(data.unresolved_quantity)} шт), нет даты выдачи
        </div>
      )}
      {data.orders_without_items?.length > 0 && (
        <div className="stat-card-hint report-inventory-warning">
          Нельзя посчитать, заказов без состава: {formatNumber(data.orders_without_items.length)}
        </div>
      )}
      {data.off_shelf_unpriced_quantity > 0 && (
        <div className="stat-card-hint report-inventory-warning">
          Из них {formatNumber(data.off_shelf_unpriced_quantity)} шт без себестоимости: нет ни одной партии, в сумму не вошли
        </div>
      )}
    </>
  );
}

export default function ReportInventoryCard({ password, inventory, failed, months }) {
  const [date, setDate] = useState('');
  const [byDate, setByDate] = useState({});
  const [errorByDate, setErrorByDate] = useState({});

  const today = almatyToday();
  const options = months
    .map((m) => ({ month: m.month, date: nextMonthStart(m.month) }))
    .filter((option) => option.month >= FIRST_REPORT_MONTH && option.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date));

  useEffect(() => {
    if (!date || byDate[date]) return;
    setErrorByDate((prev) => ({ ...prev, [date]: false }));
    fetchInventoryAsOf(password, date)
      .then((res) => setByDate((prev) => ({ ...prev, [date]: res })))
      .catch(() => setErrorByDate((prev) => ({ ...prev, [date]: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const past = date ? byDate[date] : null;
  const selected = options.find((option) => option.date === date);
  const label = selected ? `Фактически в товаре на конец: ${formatMonthLabel(selected.month)}` : 'Фактически в товаре сейчас';
  const data = date ? past : inventory;
  const hasFailed = date ? errorByDate[date] : failed;

  if (!date && !failed && inventory?.actual_total === undefined) return null;

  return (
    <div className="stat-card inventory-summary-total report-actual-inventory">
      <div className="report-inventory-head">
        <div className="stat-label">{label}</div>
        {options.length > 0 && (
          <select value={date} onChange={(e) => setDate(e.target.value)} aria-label="На какую дату показать">
            <option value="">Сейчас</option>
            {options.map((option) => (
              <option value={option.date} key={option.date}>Конец: {formatMonthLabel(option.month)}</option>
            ))}
          </select>
        )}
      </div>

      {hasFailed && !data ? (
        <div className="stat-card-hint">Не удалось посчитать, обновите страницу</div>
      ) : !data ? (
        <div className="stat-card-hint">Считаем…</div>
      ) : (
        <>
          <div className="stat-value">{formatMoney(data.actual_total)}</div>
          {date && (
            <div className="stat-card-hint">
              {data.source === 'snapshot'
                ? `Снимок на ${formatDateDMY(data.date)}, снят в ${new Date(data.captured_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                : `Восстановлено по датам заказов на начало ${formatDateDMY(data.date)}, статусы тогда не сохранялись`}
            </div>
          )}
          <Parts data={data} past={Boolean(date)} />
          {date && <OrdersList lines={data.lines || []} />}
        </>
      )}
    </div>
  );
}
