import React, { useEffect, useRef, useState } from 'react';
import { uploadKaspiPayReport, fetchMonthlyReport } from './api.js';
import { formatMoney, formatMonthLabel, formatPercent } from './dateUtils.js';

function MonthlyTable({ title, months }) {
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
                  <th>Месяц</th>
                  <th className="num">Выручка</th>
                  <th className="num">Себестоимость</th>
                  <th className="num">Возвраты</th>
                  <th className="num">Комиссия</th>
                  <th className="num">Доставка</th>
                  <th className="num">Налоги (3%)</th>
                  <th className="num">Чистая прибыль</th>
                  <th className="num">Маржа</th>
                  <th className="num">ROI</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    <td>{formatMonthLabel(m.month)}</td>
                    <td className="num">{formatMoney(m.revenue)}</td>
                    <td className="num">{formatMoney(m.cost_of_goods)}</td>
                    <td className="num">{formatMoney(m.returns)}</td>
                    <td className="num">{formatMoney(m.commission)}</td>
                    <td className="num">{formatMoney(m.delivery)}</td>
                    <td className="num">{formatMoney(m.taxes)}</td>
                    <td className="num">{formatMoney(m.net_profit)}</td>
                    <td className="num">{formatPercent(m.margin)}</td>
                    <td className="num">{formatPercent(m.roi)}</td>
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
          <MonthlyTable title="По месяцам" months={months} />
          <MonthlyTable title="Алматы + Астана" months={monthsMainCities} />
          <MonthlyTable title="Талдыкорган + Юбилейное" months={monthsSelfBuyCities} />
        </>
      )}

      <div className="report-note">
        ⚠️ Налог считается упрощённо: 3% с чистого оборота (выручка минус возвраты). Себестоимость считается по методу FIFO на основе партий на «Поставках»,
        только по продажам с 1 июня 2026, только по завершённым заказам (COMPLETED) и не позже последней даты, которая есть в загруженном Excel-отчёте Kaspi
        Pay — так выручка и себестоимость всегда за один и тот же набор заказов, без «зависших» в рассрочке. Таблицы по городам определяются по номеру
        заказа: он совпадает и в Excel-отчёте Kaspi Pay, и в данных заказов Kaspi.
      </div>
    </div>
  );
}
