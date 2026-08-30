import React, { useEffect, useMemo, useState } from 'react';
import { fetchGeography } from './api.js';
import { formatMoney, formatNumber, toISODate, daysAgo, startOfMonth } from './dateUtils.js';
import PeriodSelector from './PeriodSelector.jsx';
import KazakhstanMap from './KazakhstanMap.jsx';

const EMPTY = {
  totals: null, macroRegions: [], regions: [], deliveryModes: [],
  unknownRegion: null, unknownPlaces: [], coverage: null,
};

const WAREHOUSE_MODES = [
  { key: 'main', label: 'Основной магазин' },
  { key: 'selfbuy', label: 'Самовыкупы' },
  { key: 'all', label: 'Все' },
];

function Chips({ options, value, onChange }) {
  return (
    <div className="geo-chips">
      {options.map((o) => (
        <button
          key={o.key}
          className={`period-chip ${value === o.key ? 'active' : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ShareBar({ value }) {
  return (
    <div className="geo-share-track">
      <div className="geo-share-fill" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

export default function Geography({ password, active = true, isOnline = true }) {
  const [from, setFrom] = useState(() => toISODate(startOfMonth()));
  const [to, setTo] = useState(() => toISODate(daysAgo(0)));
  const [presetKey, setPresetKey] = useState('month');
  const [warehouseMode, setWarehouseMode] = useState('main');
  const [mapView, setMapView] = useState('macro'); // 'macro' (5 регионов) | 'regions' (области)
  const [metric, setMetric] = useState('revenue');   // 'revenue' | 'orders'
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    setError('');
    fetchGeography(password, from, to, warehouseMode)
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [active, password, from, to, warehouseMode]);

  function handlePeriodChange({ from: newFrom, to: newTo, presetKey: newPreset }) {
    setFrom(newFrom);
    setTo(newTo);
    setPresetKey(newPreset);
  }

  const totals = data.totals;
  // Области, куда хоть что-то уехало — только их показываем карточками, иначе половина
  // экрана уходит на нули.
  const regionsWithSales = useMemo(() => data.regions.filter((r) => r.orders > 0), [data.regions]);

  const expressShare = totals && totals.expressKnown > 0 ? (totals.expressOrders / totals.expressKnown) * 100 : null;
  // Доля заказов, которые покупатель забирает сам из пункта выдачи. Именно она интересна для
  // вопроса "где ставить склад", а не редкий самовывоз прямо от продавца — тот виден в таблице
  // способов доставки отдельной строкой.
  const pickupShare = totals && totals.orders > 0 ? (totals.kaspiPickupOrders / totals.orders) * 100 : null;
  const lowAddressCoverage = data.coverage && data.coverage.orders > 0 && data.coverage.destCity < 0.5;

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">География заказов <span>по регионам и областям</span></h1>
      </div>

      <PeriodSelector from={from} to={to} activePreset={presetKey} onChange={handlePeriodChange} />
      <Chips options={WAREHOUSE_MODES} value={warehouseMode} onChange={setWarehouseMode} />

      {error && <div className="error-banner">{error}</div>}

      {lowAddressCoverage && (
        <div className="geo-notice">
          Адрес доставки известен только у {Math.round(data.coverage.destCity * 100)}% заказов за период —
          карта и таблица городов построены по ним. У остальных Kaspi не отдал город в заказе.
        </div>
      )}

      <div
        style={{
          opacity: loading || !isOnline ? 0.55 : 1,
          transition: 'opacity 0.25s ease',
          pointerEvents: loading ? 'none' : 'auto',
        }}
      >
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-label">Выручка за период</div>
            <div className="stat-value">{formatMoney(totals ? totals.revenue : 0)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Заказов</div>
            <div className="stat-value">{formatNumber(totals ? totals.orders : 0)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Средний чек</div>
            <div className="stat-value">{formatMoney(totals ? totals.avgCheck : 0)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Охват по стране</div>
            <div className="stat-value">
              {totals ? `${totals.regionsWithSales} из ${totals.regionsTotal}` : '—'}
              <span className="geo-stat-hint"> областей</span>
            </div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {totals ? `${totals.macroWithSales} из ${totals.macroTotal} регионов страны` : ''}
            </div>
          </div>
        </div>

        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-label">Расходы на доставку</div>
            <div className="stat-value" style={{ color: 'var(--accent-down)' }}>
              {formatMoney(totals ? totals.deliveryCost : 0)}
            </div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {totals ? `сколько Kaspi списал с нас по ${formatNumber(totals.ordersWithCost)} заказам` : ''}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Средняя доставка</div>
            <div className="stat-value">
              {totals && totals.avgDeliveryCost !== null ? formatMoney(totals.avgDeliveryCost) : '—'}
            </div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>на один заказ</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Экспресс-доставка</div>
            <div className="stat-value">{expressShare !== null ? `${expressShare.toFixed(1)}%` : '—'}</div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {totals && totals.expressKnown > 0
                ? `${formatNumber(totals.expressOrders)} из ${formatNumber(totals.expressKnown)} заказов`
                : 'нет данных в заказах'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Забирают из пункта выдачи</div>
            <div className="stat-value">{pickupShare !== null ? `${pickupShare.toFixed(1)}%` : '—'}</div>
            <div className="stat-sublabel" style={{ marginTop: 6 }}>
              {totals ? `${formatNumber(totals.kaspiPickupOrders)} заказов` : ''}
            </div>
          </div>
        </div>

        <div className="section-title">Карта доставки</div>
        <div className="card">
          <div className="geo-map-toolbar">
            <Chips
              options={[{ key: 'macro', label: 'По регионам' }, { key: 'regions', label: 'По областям' }]}
              value={mapView}
              onChange={setMapView}
            />
            <Chips
              options={[{ key: 'revenue', label: 'Выручка' }, { key: 'orders', label: 'Заказы' }]}
              value={metric}
              onChange={setMetric}
            />
          </div>

          <KazakhstanMap
            regions={data.regions}
            macroRegions={data.macroRegions}
            metric={metric}
            view={mapView}
          />

          <div className="geo-map-hint">
            Наведите на карту, чтобы увидеть цифры (на телефоне — коснитесь). Астана, Алматы и
            Шымкент — города республиканского значения, на карте они кружками: своей площади у
            них почти нет, а заказов идёт больше, чем в иные области.
          </div>
        </div>

        <div className="section-title">Регионы</div>
        <div className="geo-region-grid geo-macro-grid">
          {data.macroRegions.map((m) => (
            <div className="geo-region-card" key={m.id}>
              <div className="geo-region-share">{m.revenueShare.toFixed(1)}%</div>
              <div className="geo-region-name">{m.name} Казахстан</div>
              <ShareBar value={m.revenueShare} />
              <div className="geo-region-rows">
                <div><span>Выручка</span><b>{formatMoney(m.revenue)}</b></div>
                <div><span>Заказов</span><b>{formatNumber(m.orders)}</b></div>
                <div><span>Средний чек</span><b>{formatMoney(m.avgCheck)}</b></div>
                <div><span>Средняя доставка</span><b>{m.avgDeliveryCost !== null ? formatMoney(m.avgDeliveryCost) : '—'}</b></div>
              </div>
              <div className="geo-macro-oblasts">{m.oblasts.join(', ')}</div>
            </div>
          ))}
        </div>

        <div className="section-title">Области</div>
        {regionsWithSales.length === 0 ? (
          <div className="card"><div className="empty-state">За период нет заказов с известным адресом</div></div>
        ) : (
          <div className="geo-region-grid">
            {regionsWithSales.map((r) => (
              <div className="geo-region-card" key={r.id}>
                <div className="geo-region-share">{r.revenueShare.toFixed(1)}%</div>
                <div className="geo-region-name">{r.name}</div>
                <ShareBar value={r.revenueShare} />
                <div className="geo-region-rows">
                  <div><span>Выручка</span><b>{formatMoney(r.revenue)}</b></div>
                  <div><span>Заказов</span><b>{formatNumber(r.orders)}</b></div>
                  <div><span>Средний чек</span><b>{formatMoney(r.avgCheck)}</b></div>
                  <div><span>Средняя доставка</span><b>{r.avgDeliveryCost !== null ? formatMoney(r.avgDeliveryCost) : '—'}</b></div>
                </div>
              </div>
            ))}
          </div>
        )}

        {data.unknownRegion && data.unknownRegion.orders > 0 && (
          <div className="geo-notice">
            У {formatNumber(data.unknownRegion.orders)} заказов на {formatMoney(data.unknownRegion.revenue)}
            {' '}область определить не удалось — они не попали ни на карту, ни в карточки выше.
          </div>
        )}

        <div className="section-title">Способы доставки</div>
        <div className="card">
          {data.deliveryModes.length === 0 ? (
            <div className="empty-state">За период нет заказов</div>
          ) : (
            <div className="table-scroll">
              <table className="product-table geo-mode-table">
                <thead>
                  <tr>
                    <th>Способ доставки</th>
                    <th className="num">Заказов</th>
                    <th className="num">Доля</th>
                    <th className="num">Выручка</th>
                    <th className="num">Расходы на доставку</th>
                    <th className="num">Средняя доставка</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deliveryModes.map((m) => (
                    <tr key={m.key}>
                      <td>{m.label}</td>
                      <td className="num">{formatNumber(m.orders)}</td>
                      <td className="num">{m.share.toFixed(1)}%</td>
                      <td className="num">{formatMoney(m.revenue)}</td>
                      <td className="num">{m.deliveryCost > 0 ? formatMoney(m.deliveryCost) : '—'}</td>
                      <td className="num">{m.avgDeliveryCost !== null ? formatMoney(m.avgDeliveryCost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>


        {data.unknownPlaces.length > 0 && (
          <>
            <div className="section-title">Не удалось определить область</div>
            <div className="card">
              <div className="geo-map-hint" style={{ marginTop: 0, marginBottom: 12 }}>
                Kaspi прислал эти населённые пункты, но отнести их к области не вышло: в
                справочнике их нет, область в скобках Kaspi не указал, координат в заказе тоже
                нет. Их заказы не попали ни на карту, ни в цифры регионов и областей — чтобы
                попали, названия нужно дописать в <code>backend/kzRegions.js</code>.
              </div>
              <div className="geo-unknown-list">
                {data.unknownPlaces.map((c) => (
                  <span className="geo-unknown-chip" key={c.city}>{c.city} <b>{c.orders}</b></span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
