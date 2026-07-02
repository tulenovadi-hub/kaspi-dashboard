import React, { useEffect, useRef, useState } from 'react';
import { uploadKaspiPayReport, fetchMonthlyReport } from './api.js';
import { formatMoney, formatMonthLabel, formatPercent } from './dateUtils.js';

export default function Report({ password }) {
  const [months, setMonths] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const fileInputRef = useRef(null);

  function loadReport() {
    setLoading(true);
    setError('');
    fetchMonthlyReport(password)
      .then((res) => setMonths(res.months))
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

      <div className="section-title">По месяцам</div>
      <div className="card">
        {loading ? (
          <div className="empty-state">Загрузка...</div>
        ) : months.length === 0 ? (
          <div className="empty-state">Пока нет данных — загрузите отчёт Kaspi Pay выше</div>
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

      <div className="report-note">
        ⚠️ Налог считается упрощённо: 3% с чистого оборота (выручка минус возвраты). Себестоимость считается по методу FIFO на основе партий на «Поставках»
        и только по продажам с 1 июня 2026 — так же, как на «Складе». Если у товара ещё нет введённых партий, его себестоимость пока считается как 0
        (чистая прибыль по нему будет завышена, пока вы не внесёте партии).
      </div>
    </div>
  );
}
