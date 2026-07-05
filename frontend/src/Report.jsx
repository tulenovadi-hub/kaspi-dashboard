import React, { useEffect, useRef, useState } from 'react';
import { uploadKaspiPayReport, fetchMonthlyReport } from './api.js';
import { formatMoney, formatMonthLabel, formatPercent } from './dateUtils.js';

// columns — массив { key, label }. key === 'month' форматируется отдельно (название месяца),
// остальные — через formatMoney, кроме margin/roi (по имени колонки определяем формат).
function MonthlyTable({ title, months, columns }) {
  return (
    <>
      <div className="section-title">{title}</div>
      <div className="card">
        {months.length === 0 ? (
          <div className="empty-state">Нет данных за загруженный период</div>
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col.key} className={col.key === 'month' ? '' : 'num'}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    {columns.map((col) => {
                      if (col.key === 'month') return <td key={col.key}>{formatMonthLabel(m.month)}</td>;
                      if (col.key === 'margin' || col.key === 'roi') {
                        return <td key={col.key} className="num">{formatPercent(m[col.key])}</td>;
                      }
                      return <td key={col.key} className="num">{formatMoney(m[col.key])}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const GENERAL_COLUMNS = [
  { key: 'month', label: 'Месяц' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'taxes', label: 'Налоги (3%)' },
];

const MAIN_COLUMNS = [
  { key: 'month', label: 'Месяц' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'cost_of_goods', label: 'Себестоимость' },
  { key: 'returns', label: 'Возвраты' },
  { key: 'cost_of_returns', label: 'Себестоимость возвратов' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'taxes', label: 'Налоги (3%)' },
  { key: 'other_expenses', label: 'Прочие расходы' },
  { key: 'net_profit', label: 'Чистая прибыль' },
  { key: 'margin', label: 'Маржа' },
  { key: 'roi', label: 'ROI' },
];

const SELF_BUY_COLUMNS = [
  { key: 'month', label: 'Месяц' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'taxes', label: 'Налоги (3%)' },
];

export default function Report({ password }) {
  const [months, setMonths] = useState([]);
  const [monthsMainCities, setMonthsMainCities] = useState([]);
  const [monthsSelfBuyCities, setMonthsSelfBuyCities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const fileInputRef = useRef(null);

  function loadReport() {
    setLoading(true);
    setError('');
    fetchMonthlyReport(password)
      .then((res) => {
        setMonths(res.months);
        setMonthsMainCities(res.monthsMainCities);
        setMonthsSelfBuyCities(res.monthsSelfBuyCities);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    setUploadMessage('');
    setError('');

    uploadKaspiPayReport(password, file)
      .then((res) => {
        setUploadMessage(`Загружено операций: ${res.processed}`);
        loadReport();
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      });
  }

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Отчёт <span>по прибыли</span></h1>
      </div>

      <div className="card">
        <div className="report-upload-row">
          <div>
            <div className="report-upload-title">Загрузить отчёт Kaspi Pay</div>
            <div className="report-upload-hint">
              Личный кабинет продавца → Аналитика/Отчёты → выгрузите «Детальная информация по операциям» в .xlsx и загрузите сюда.
              Комиссии и стоимость доставки подтянутся автоматически.
            </div>
          </div>
          <label className={`primary-button report-upload-btn${uploading ? ' disabled' : ''}`}>
            {uploading ? 'Загружаем...' : 'Выбрать файл .xlsx'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={handleFileChange}
              disabled={uploading}
              style={{ display: 'none' }}
            />
          </label>
        </div>
        {uploadMessage && <div className="report-upload-success">{uploadMessage}</div>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="empty-state">Загрузка...</div>
      ) : (
        <>
          <MonthlyTable title="Общий отчёт" months={months} columns={GENERAL_COLUMNS} />
          <MonthlyTable title="Основной отчёт (Алматы, Астана)" months={monthsMainCities} columns={MAIN_COLUMNS} />
          <MonthlyTable title="Самовыкупы (Юбилейное, Талдыкорган)" months={monthsSelfBuyCities} columns={SELF_BUY_COLUMNS} />
        </>
      )}

      <div className="report-note">
        ⚠️ Налог считается упрощённо: 3% с чистого оборота (выручка минус возвраты). Себестоимость считается по методу FIFO на основе партий на «Поставках»,
        и только по тем заказам, которые реально есть в загруженном Excel-отчёте Kaspi Pay со статусом «Покупка». «Себестоимость возвратов» — справочная
        колонка (приближённая оценка по текущей активной партии товара), в расчёт чистой прибыли она не входит — себестоимость возвращённого товара уже
        разово списана в момент продажи и повторно не вычитается. «Прочие расходы» в основном отчёте — это сумма категории «Прочие затраты» из раздела
        «Расходы» (Google Таблица) за тот же месяц; категория «Товар» туда не входит — она уже учтена через себестоимость, а «Вывод» не входит, так как это
        не операционный расход бизнеса. Таблицы по городам определяются по номеру заказа: он совпадает и в Excel-отчёте Kaspi Pay, и в данных заказов Kaspi.
      </div>
    </div>
  );
}
