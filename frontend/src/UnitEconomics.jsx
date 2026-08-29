import React, { useEffect, useMemo, useState } from 'react';
import { fetchUnitEconomicsDefaults, saveUnitEconomicsPreset } from './api.js';
import { formatMoney, formatNumber } from './dateUtils.js';

const STORAGE_KEY = 'unit_economics_input';
const PRODUCT_KEY = 'unit_economics_product';

// Пустая форма. Всё, что можно взять из собственных продаж (комиссия, доставка, курс),
// подставляется поверх неё из /api/unit-economics/defaults.
const EMPTY_FORM = {
  importMode: 'grey', // 'grey' — всё в ставке за кг, 'white' — с пошлиной, НДС и оформлением
  sellPrice: '',
  quantity: '100',
  purchaseAmount: '',
  currency: 'USD',
  rate: '',
  logisticsAmount: '',
  logisticsCurrency: 'USD',
  logisticsRate: '',
  dutyPercent: '0',
  vatPercent: '12',
  brokerPerBatch: '0',
  customsWarehousePerBatch: '0',
  certificationPerBatch: '0',
  fulfillmentPerUnit: '0',
  cityDeliveryPerUnit: '0',
  otherPerUnit: '0',
  otherPerBatch: '0',
  commissionPercent: '',
  kaspiDeliveryPerUnit: '',
  adPercent: '0',
  sellerBonusPercent: '0',
  reviewBonusPerUnit: '0',
  taxPercent: '3',
};

const CURRENCIES = ['USD', 'CNY', 'KZT'];

function num(value) {
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Все деньги считаются НА ОДНУ ШТУКУ, а на партию умножаются в конце: так формулы читаются
// глазами и совпадают с тем, как продавец думает про товар.
function calculate(form) {
  const quantity = Math.max(1, num(form.quantity));
  const sellPrice = num(form.sellPrice);
  const rate = form.currency === 'KZT' ? 1 : num(form.rate);

  // И закупка, и логистика вводятся суммой за ВСЮ партию — именно так их выставляют
  // поставщик и карго. На штуку делим сами, чтобы человеку не считать это в уме.
  const purchaseTotal = num(form.purchaseAmount) * rate;
  const purchase = purchaseTotal / quantity;
  const logisticsRate = form.logisticsCurrency === 'KZT' ? 1 : num(form.logisticsRate);
  const logisticsTotal = num(form.logisticsAmount) * logisticsRate;
  const freight = logisticsTotal / quantity;

  // Таможенная стоимость — товар плюс доставка до границы, от неё считаются пошлина и НДС.
  const customsValue = purchase + freight;
  const white = form.importMode === 'white';
  const duty = white ? (customsValue * num(form.dutyPercent)) / 100 : 0;
  const vat = white ? ((customsValue + duty) * num(form.vatPercent)) / 100 : 0;
  const clearance = white
    ? (num(form.brokerPerBatch) + num(form.customsWarehousePerBatch) + num(form.certificationPerBatch)) / quantity
    : 0;
  const importCost = duty + vat + clearance;

  const variable =
    num(form.fulfillmentPerUnit) + num(form.cityDeliveryPerUnit) + num(form.otherPerUnit) + num(form.otherPerBatch) / quantity;

  // "Постфактум" — то, что забирают уже ПОСЛЕ продажи, с каждой проданной штуки.
  const commission = (sellPrice * num(form.commissionPercent)) / 100;
  // Реклама и бонусы от продавца — процент от цены, бонус за отзыв — фиксированная сумма
  // с продажи: за отзыв платят деньгами, а не долей чека.
  const ads = (sellPrice * num(form.adPercent)) / 100;
  const sellerBonus = (sellPrice * num(form.sellerBonusPercent)) / 100;
  const reviewBonus = num(form.reviewBonusPerUnit);
  const marketing = ads + sellerBonus + reviewBonus;
  const kaspiDelivery = num(form.kaspiDeliveryPerUnit);
  const tax = (sellPrice * num(form.taxPercent)) / 100;

  const profit = sellPrice - purchase - freight - importCost - variable - commission - marketing - kaspiDelivery - tax;

  // ROI — по той же формуле, что во всём дашборде: прибыль делится только на вложения в товар.
  // Комиссия, доставка Kaspi и налоги в знаменатель не входят — это не инвестиция, а издержки сделки.
  const investment = purchase + freight + importCost + variable + marketing;

  // Цена, при которой прибыль обращается в ноль. Комиссия, реклама и налог зависят от цены,
  // поэтому решается уравнение, а не просто складываются расходы.
  const priceShare =
    (num(form.commissionPercent) + num(form.adPercent) + num(form.sellerBonusPercent) + num(form.taxPercent)) / 100;
  const fixedPerUnit = purchase + freight + importCost + variable + kaspiDelivery + reviewBonus;
  const breakEven = priceShare < 1 ? fixedPerUnit / (1 - priceShare) : null;

  const parts = [
    { key: 'purchase', label: 'Закупка товара', value: purchase, color: '#6e8bff' },
    { key: 'freight', label: 'Логистика до склада', value: freight, color: '#4ec9f5' },
    { key: 'import', label: 'Ввоз и оформление', value: importCost, color: '#f5a623' },
    { key: 'variable', label: 'Переменные расходы', value: variable, color: '#b38bff' },
    { key: 'commission', label: 'Комиссия Kaspi', value: commission, color: '#ff8fab' },
    { key: 'kaspiDelivery', label: 'Доставка Kaspi', value: kaspiDelivery, color: '#ff6b6b' },
    { key: 'ads', label: 'Реклама', value: ads, color: '#ffd166' },
    { key: 'sellerBonus', label: 'Бонусы от продавца', value: sellerBonus, color: '#ffb347' },
    { key: 'reviewBonus', label: 'Бонусы за отзыв', value: reviewBonus, color: '#e8b04b' },
    { key: 'tax', label: 'Налог', value: tax, color: '#8d99ae' },
  ];

  return {
    quantity,
    sellPrice,
    perUnit: { purchase, freight, importCost, variable, commission, ads, sellerBonus, reviewBonus, marketing, kaspiDelivery, tax, profit, investment },
    parts,
    profit,
    margin: sellPrice > 0 ? (profit / sellPrice) * 100 : 0,
    roi: investment > 0 ? (profit / investment) * 100 : null,
    revenue: sellPrice * quantity,
    totalProfit: profit * quantity,
    // Сколько денег нужно вложить до первой продажи — реклама сюда не входит, она платится позже.
    upfront: (purchase + freight + importCost + variable) * quantity,
    purchaseTotal,
    logisticsTotal,
    breakEven,
    detail: { duty, vat, clearance, customsValue },
  };
}

// Раньше цена закупки вводилась ЗА ШТУКУ (поле purchaseForeign), теперь — за партию.
// Уже сохранённые расчёты переносим: сумма за партию = цена за штуку × количество. Без этого
// поле у старых расчётов молча оказалось бы пустым, а человек бы решил, что расчёт потерялся.
function migrateForm(saved) {
  const form = { ...EMPTY_FORM, ...(saved || {}) };
  if (!form.purchaseAmount && saved && saved.purchaseForeign) {
    form.purchaseAmount = String(Number((num(saved.purchaseForeign) * Math.max(1, num(form.quantity))).toFixed(2)));
  }
  delete form.purchaseForeign;
  // Раньше маркетинг был одним полем "Реклама и бонусы" в процентах — переносим его в рекламу,
  // а не теряем: в старых расчётах в этот процент закладывали всё сразу.
  if (saved && saved.marketingPercent && num(form.adPercent) === 0) {
    form.adPercent = String(saved.marketingPercent);
  }
  delete form.marketingPercent;
  return form;
}

function Field({ label, value, onChange, suffix, hint, wide }) {
  return (
    <div className={`ue-field${wide ? ' ue-field-wide' : ''}`}>
      <label>{label}</label>
      <div className="ue-input-wrap">
        <input type="text" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />
        {suffix && <span className="ue-suffix">{suffix}</span>}
      </div>
      {hint && <div className="ue-hint">{hint}</div>}
    </div>
  );
}

function Gauge({ margin }) {
  // Полукруг от -20% до +50%: за пределами этого диапазона стрелка просто упирается в край.
  const clamped = Math.max(-20, Math.min(50, margin));
  const fraction = (clamped + 20) / 70;
  const radius = 62;
  const circumference = Math.PI * radius;
  const color = margin < 0 ? 'var(--accent-down)' : margin < 15 ? 'var(--accent-warn)' : 'var(--accent-up)';
  return (
    <div className="ue-gauge">
      <svg viewBox="0 0 160 92" width="160" height="92">
        <path d="M18 80 A62 62 0 0 1 142 80" fill="none" stroke="var(--bg)" strokeWidth="12" strokeLinecap="round" />
        <path
          d="M18 80 A62 62 0 0 1 142 80"
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${(circumference * fraction).toFixed(1)} ${circumference.toFixed(1)}`}
        />
      </svg>
      <div className="ue-gauge-value" style={{ color }}>{margin.toFixed(1)}%</div>
      <div className="ue-gauge-label">маржинальность</div>
    </div>
  );
}

export default function UnitEconomics({ password, active = true, isOnline = true }) {
  const [form, setForm] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') return migrateForm(saved);
    } catch (err) {
      // повреждённое содержимое localStorage не должно ронять страницу
    }
    return EMPTY_FORM;
  });
  const [defaults, setDefaults] = useState(null);
  // Какой товар сейчас выбран — от него зависит, куда сохранять расчёт и что подтягивать.
  const [productId, setProductId] = useState(() => localStorage.getItem(PRODUCT_KEY) || '');
  const [presets, setPresets] = useState({});
  const [saveState, setSaveState] = useState(''); // '' | 'saving' | 'saved' | текст ошибки
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    fetchUnitEconomicsDefaults(password)
      .then((res) => {
        setDefaults(res);
        setPresets(res.presets || {});
        // Подставляем реальные комиссию/доставку/курс только в пустые поля — то, что человек
        // уже ввёл руками, перетирать нельзя.
        setForm((prev) => {
          const next = { ...prev };
          if (!next.commissionPercent && res.commissionPercent !== null) next.commissionPercent = String(res.commissionPercent);
          if (!next.kaspiDeliveryPerUnit && res.deliveryPerUnit !== null) next.kaspiDeliveryPerUnit = String(res.deliveryPerUnit);
          if (!next.rate && res.rates && res.rates[next.currency]) next.rate = String(res.rates[next.currency]);
          if (!next.logisticsRate && res.rates && res.rates[next.logisticsCurrency]) {
            next.logisticsRate = String(res.rates[next.logisticsCurrency]);
          }
          if (!next.taxPercent) next.taxPercent = String(res.taxPercent);
          return next;
        });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [active, password]);

  // Ввод сохраняется локально: расчёт часто бросают на середине и возвращаются к нему позже.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch (err) {
      // приватный режим браузера может запрещать запись — это не повод ломать страницу
    }
  }, [form]);

  const set = (key) => (value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Как только что-то поправили, надпись "Расчёт сохранён" перестаёт быть правдой.
    setSaveState('');
  };

  function selectProduct(nextId) {
    setProductId(nextId);
    setSaveState('');
    try {
      localStorage.setItem(PRODUCT_KEY, nextId);
    } catch (err) {
      // приватный режим браузера может запрещать запись
    }
    if (!nextId) return;

    // Если по этому товару расчёт уже сохраняли — подставляем его целиком, а не заново
    // собираем из закупочных цен: человек мог поправить руками что угодно, и именно эти
    // правки он и хочет увидеть в следующий раз.
    const preset = presets[nextId];
    if (preset && preset.form) {
      setForm(migrateForm(preset.form));
      return;
    }
    applyProduct(nextId);
  }

  async function savePreset() {
    if (!productId) return;
    const product = (defaults && defaults.products || []).find((p) => p.productId === productId);
    setSaveState('saving');
    try {
      const res = await saveUnitEconomicsPreset(password, productId, product ? product.name : null, form);
      setPresets((prev) => ({ ...prev, [productId]: { form, updatedAt: res.updatedAt } }));
      setSaveState('saved');
    } catch (err) {
      setSaveState(err.message);
    }
  }

  function applyProduct(productId) {
    const product = (defaults && defaults.products || []).find((p) => p.productId === productId);
    if (!product) return;
    setForm((prev) => ({
      ...prev,
      sellPrice: product.sellPrice !== null ? String(product.sellPrice) : prev.sellPrice,
      currency: product.purchaseCurrency || (product.purchasePrice !== null ? 'KZT' : prev.currency),
      // В партии закупочная цена записана за штуку — приводим к сумме за партию по
      // количеству ИЗ ЭТОГО расчёта, как и с логистикой.
      purchaseAmount:
        product.purchasePriceForeign !== null
          ? String(Number((product.purchasePriceForeign * Math.max(1, num(prev.quantity))).toFixed(2)))
          : product.purchasePrice !== null
            ? String(product.purchasePrice * Math.max(1, num(prev.quantity)))
            : prev.purchaseAmount,
      rate: product.purchaseRate !== null ? String(product.purchaseRate) : prev.rate,
      // Логистику в партии записывали суммой за партию, а количество там было своё —
      // поэтому берём цену за штуку и умножаем на количество ИЗ ЭТОГО расчёта.
      logisticsCurrency: product.logisticsCurrency || (product.logisticsPerUnit ? 'KZT' : prev.logisticsCurrency),
      logisticsAmount:
        product.logisticsPerUnitForeign !== null
          ? String(Number((product.logisticsPerUnitForeign * Math.max(1, num(prev.quantity))).toFixed(2)))
          : product.logisticsPerUnit
            ? String(product.logisticsPerUnit * Math.max(1, num(prev.quantity)))
            : prev.logisticsAmount,
      logisticsRate: product.logisticsRate !== null ? String(product.logisticsRate) : prev.logisticsRate,
      otherPerUnit: product.extraPerUnit !== null ? String(product.extraPerUnit) : prev.otherPerUnit,
      // ДРР этого товара — доля рекламы в его выручке, ровно как на странице "Реклама товаров".
      adPercent: product.adPercent !== null ? String(product.adPercent) : prev.adPercent,
    }));
  }

  function reset() {
    const base = { ...EMPTY_FORM };
    if (defaults) {
      if (defaults.commissionPercent !== null) base.commissionPercent = String(defaults.commissionPercent);
      if (defaults.deliveryPerUnit !== null) base.kaspiDeliveryPerUnit = String(defaults.deliveryPerUnit);
      if (defaults.rates && defaults.rates.USD) base.rate = String(defaults.rates.USD);
      base.taxPercent = String(defaults.taxPercent);
    }
    setForm(base);
    setSaveState('');
  }

  const selectedProduct = productId && defaults ? defaults.products.find((p) => p.productId === productId) : null;
  const currentPreset = productId ? presets[productId] : null;
  const saveHint = (() => {
    if (saveState === 'saved') return 'Расчёт сохранён';
    if (saveState && saveState !== 'saving') return saveState;
    if (!productId) return 'Выберите товар, чтобы сохранить расчёт';
    if (currentPreset && currentPreset.updatedAt) {
      const d = new Date(currentPreset.updatedAt);
      return `Сохранено ${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    }
    return 'По этому товару расчёт ещё не сохраняли';
  })();

  const result = useMemo(() => calculate(form), [form]);
  const white = form.importMode === 'white';
  // Расчёт показываем только когда введено главное — цена продажи и цена закупки.
  const filled = num(form.sellPrice) > 0 && num(form.purchaseAmount) > 0;

  const expenseRows = [
    ...result.parts.map((p) => ({ ...p })),
    { key: 'profit', label: 'Прибыль', value: result.perUnit.profit, color: '#3ddc97', isProfit: true },
  ];

  // Полосы структуры цены: при убытке вместо зелёной прибыли рисуем красную нехватку.
  const barParts = [
    ...result.parts,
    result.perUnit.profit >= 0
      ? { key: 'profit', label: 'Прибыль', value: result.perUnit.profit, color: '#3ddc97' }
      : { key: 'loss', label: 'Не хватает до нуля', value: -result.perUnit.profit, color: '#ff6b6b' },
  ];
  const barTotal = barParts.reduce((sum, p) => sum + Math.max(0, p.value), 0);

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">Юнит-экономика <span>стоит ли брать товар</span></h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="ue-toolbar">
        <div className="geo-chips">
          <button className={`period-chip ${!white ? 'active' : ''}`} onClick={() => set('importMode')('grey')}>В серую</button>
          <button className={`period-chip ${white ? 'active' : ''}`} onClick={() => set('importMode')('white')}>В белую</button>
        </div>
        {defaults && defaults.products.length > 0 && (
          <select className="ue-product-select" value={productId} onChange={(e) => selectProduct(e.target.value)}>
            <option value="">Выбрать товар…</option>
            {defaults.products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {presets[p.productId] ? '✓ ' : ''}{p.name}
              </option>
            ))}
          </select>
        )}
        <button
          className="primary-button ue-save"
          onClick={savePreset}
          disabled={!productId || saveState === 'saving'}
          title={productId ? '' : 'Сначала выберите товар — расчёт сохраняется для него'}
        >
          {saveState === 'saving' ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button className="ue-reset" onClick={reset}>Сбросить</button>
        <span className="ue-save-state">{saveHint}</span>
      </div>

      {defaults && defaults.commissionPercent !== null && (
        <div className="ue-source-note">
          Комиссия {defaults.commissionPercent}% и доставка {formatMoney(defaults.deliveryPerUnit)} за штуку
          подставлены не наугад — это факт по вашим {formatNumber(defaults.basedOn.orders)} заказам
          за последние {defaults.basedOn.days} дней. Поменять можно вручную.
        </div>
      )}

      <div className="ue-layout" style={{ opacity: loading || !isOnline ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        <div className="ue-inputs">
          <div className="card">
            <div className="form-section-title">Товар и партия</div>
            <div className="ue-grid">
              <Field label="Цена продажи на Kaspi" value={form.sellPrice} onChange={set('sellPrice')} suffix="₸/шт" />
              <Field label="Количество в партии" value={form.quantity} onChange={set('quantity')} suffix="шт" />
              <div className="ue-field">
                <label>Цена закупки за партию</label>
                <div className="ue-input-wrap">
                  <input type="text" inputMode="decimal" value={form.purchaseAmount} onChange={(e) => set('purchaseAmount')(e.target.value)} />
                  <select
                    className="ue-currency"
                    value={form.currency}
                    onChange={(e) => {
                      const currency = e.target.value;
                      setForm((prev) => ({
                        ...prev,
                        currency,
                        rate: currency === 'KZT' ? '1' : (defaults && defaults.rates[currency] ? String(defaults.rates[currency]) : prev.rate),
                      }));
                    }}
                  >
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="ue-hint">
                  {result.purchaseTotal > 0
                    ? `${formatMoney(result.purchaseTotal)} за партию, ${formatMoney(result.perUnit.purchase)} на штуку`
                    : 'вся сумма счёта от поставщика'}
                </div>
              </div>
              <Field
                label="Курс"
                value={form.currency === 'KZT' ? '1' : form.rate}
                onChange={set('rate')}
                suffix={`₸ за 1 ${form.currency}`}
                hint={form.currency === 'KZT' ? 'для тенге курс не нужен' : 'из последней поставки'}
              />
              <div className="ue-field">
                <label>Цена логистики за партию</label>
                <div className="ue-input-wrap">
                  <input type="text" inputMode="decimal" value={form.logisticsAmount} onChange={(e) => set('logisticsAmount')(e.target.value)} />
                  <select
                    className="ue-currency"
                    value={form.logisticsCurrency}
                    onChange={(e) => {
                      const currency = e.target.value;
                      setForm((prev) => ({
                        ...prev,
                        logisticsCurrency: currency,
                        logisticsRate:
                          currency === 'KZT' ? '1' : (defaults && defaults.rates[currency] ? String(defaults.rates[currency]) : prev.logisticsRate),
                      }));
                    }}
                  >
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="ue-hint">
                  {result.logisticsTotal > 0
                    ? `${formatMoney(result.logisticsTotal)} за партию, ${formatMoney(result.perUnit.freight)} на штуку`
                    : 'вся доставка от поставщика до склада'}
                </div>
              </div>
              <Field
                label="Курс логистики"
                value={form.logisticsCurrency === 'KZT' ? '1' : form.logisticsRate}
                onChange={set('logisticsRate')}
                suffix={`₸ за 1 ${form.logisticsCurrency}`}
                hint={form.logisticsCurrency === 'KZT' ? 'для тенге курс не нужен' : 'из последней поставки'}
              />
            </div>
          </div>

          <div className="card">
            <div className="form-section-title">
              Ввоз {white ? '— в белую' : '— в серую'}
            </div>
            {white ? (
              <>
                <div className="ue-grid">
                  <Field label="Пошлина" value={form.dutyPercent} onChange={set('dutyPercent')} suffix="%" hint="от таможенной стоимости, по коду ТН ВЭД" />
                  <Field label="НДС при импорте" value={form.vatPercent} onChange={set('vatPercent')} suffix="%" hint="на упрощёнке к зачёту не берётся" />
                  <Field label="Брокер" value={form.brokerPerBatch} onChange={set('brokerPerBatch')} suffix="₸ за партию" />
                  <Field label="СВХ и хранение" value={form.customsWarehousePerBatch} onChange={set('customsWarehousePerBatch')} suffix="₸ за партию" />
                  <Field label="Сертификация" value={form.certificationPerBatch} onChange={set('certificationPerBatch')} suffix="₸ за партию" />
                </div>
                <div className="form-section-hint">
                  Таможенная стоимость единицы — {formatMoney(result.detail.customsValue)} (закупка плюс доставка).
                  Пошлина {formatMoney(result.detail.duty)}, НДС {formatMoney(result.detail.vat)},
                  оформление {formatMoney(result.detail.clearance)} на штуку.
                </div>
              </>
            ) : (
              <div className="form-section-hint" style={{ marginTop: 0 }}>
                В серую отдельных платежей на таможне нет — всё уже сидит в цене карго за партию.
                Проверьте, что она указана именно «под ключ», с доставкой до склада, иначе расчёт
                получится слишком оптимистичным.
              </div>
            )}
          </div>

          <div className="card">
            <div className="form-section-title">Свои расходы</div>
            <div className="ue-grid">
              <Field label="Фулфилмент и упаковка" value={form.fulfillmentPerUnit} onChange={set('fulfillmentPerUnit')} suffix="₸/шт" />
              <Field label="Доставка по городу" value={form.cityDeliveryPerUnit} onChange={set('cityDeliveryPerUnit')} suffix="₸/шт" />
              <Field label="Прочее на штуку" value={form.otherPerUnit} onChange={set('otherPerUnit')} suffix="₸/шт" />
              <Field label="Прочее на партию" value={form.otherPerBatch} onChange={set('otherPerBatch')} suffix="₸" hint="нотариат, перевод, образцы" />
            </div>
          </div>

          <div className="card">
            <div className="form-section-title">Маркетинг</div>
            <div className="ue-grid">
              <Field
                label="Реклама"
                value={form.adPercent}
                onChange={set('adPercent')}
                suffix="% от цены"
                hint={
                  selectedProduct && selectedProduct.adPercent !== null
                    ? `ДРР этого товара за ${defaults.basedOn.days} дней — ${selectedProduct.adPercent}%`
                    : 'доля рекламы в цене'
                }
              />
              <Field label="Бонусы от продавца" value={form.sellerBonusPercent} onChange={set('sellerBonusPercent')} suffix="% от цены" />
              <Field
                label="Бонусы за отзыв"
                value={form.reviewBonusPerUnit}
                onChange={set('reviewBonusPerUnit')}
                suffix="₸/шт"
                hint="фиксированная сумма с продажи, а не процент"
              />
            </div>
          </div>

          <div className="card">
            <div className="form-section-title">Kaspi и налоги</div>
            <div className="ue-grid">
              <Field label="Комиссия Kaspi" value={form.commissionPercent} onChange={set('commissionPercent')} suffix="%" hint="факт по вашим продажам" />
              <Field label="Доставка Kaspi" value={form.kaspiDeliveryPerUnit} onChange={set('kaspiDeliveryPerUnit')} suffix="₸/шт" hint="факт по вашим продажам" />
              <Field label="Налог" value={form.taxPercent} onChange={set('taxPercent')} suffix="%" hint="упрощёнка — 3% с оборота" />
            </div>
          </div>
        </div>

        <div className="ue-results">
          <div className="card ue-summary">
            <Gauge margin={filled ? result.margin : 0} />
            {/* Пока не введены цена продажи и закупки, любые цифры здесь врут: комиссия и
                доставка Kaspi уже подставлены, и "прибыль" вышла бы минусовой на пустой форме. */}
            <div className="ue-summary-rows">
              <div><span>Прибыль с одной штуки</span><b className={!filled ? undefined : result.profit < 0 ? 'ue-negative' : 'ue-positive'}>{filled ? formatMoney(result.perUnit.profit) : '—'}</b></div>
              <div><span>Прибыль с партии</span><b className={!filled ? undefined : result.totalProfit < 0 ? 'ue-negative' : 'ue-positive'}>{filled ? formatMoney(result.totalProfit) : '—'}</b></div>
              <div><span>Выручка с партии</span><b>{filled ? formatMoney(result.revenue) : '—'}</b></div>
              <div><span>ROI</span><b>{filled && result.roi !== null ? `${result.roi.toFixed(1)}%` : '—'}</b></div>
              <div><span>Вложить до первой продажи</span><b>{filled ? formatMoney(result.upfront) : '—'}</b></div>
              <div>
                <span>Цена в ноль</span>
                <b>{filled && result.breakEven !== null ? formatMoney(result.breakEven) : '—'}</b>
              </div>
            </div>
            {filled && result.breakEven !== null && (
              <div className="ue-verdict">
                {result.profit < 0
                  ? `Товар в минусе: чтобы выйти в ноль, продавать нужно минимум за ${formatMoney(result.breakEven)}.`
                  : `Запас по цене — ${formatMoney(result.sellPrice - result.breakEven)} на штуку: ниже этого падать нельзя.`}
              </div>
            )}
          </div>

          <div className="card">
            <div className="form-section-title">Структура цены</div>
            {filled ? (
              <>
                {/* Ширины считаются от суммы САМИХ полос, а не от цены: когда товар в минусе,
                    расходы больше цены, и доли от цены дали бы в сумме больше 100% — полоса
                    поехала бы. При убытке последний сегмент красный: видно, сколько не хватает
                    цене, чтобы покрыть расходы. */}
                <div className="ue-bar">
                  {barParts.map((row) => {
                    const width = barTotal > 0 ? (row.value / barTotal) * 100 : 0;
                    if (width <= 0) return null;
                    return (
                      <div
                        key={row.key}
                        className="ue-bar-part"
                        style={{ width: `${width}%`, background: row.color }}
                        title={`${row.label}: ${formatMoney(row.value)}`}
                      />
                    );
                  })}
                </div>
                <div className="ue-legend">
                  {expenseRows.map((row) => {
                    const share = result.sellPrice > 0 ? (row.value / result.sellPrice) * 100 : 0;
                    if (share === 0) return null;
                    return (
                      <div key={row.key} className="ue-legend-item">
                        <i style={{ background: row.color }} />
                        <span>{row.label}</span>
                        <b className={row.isProfit && row.value < 0 ? 'ue-negative' : undefined}>{share.toFixed(1)}%</b>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="empty-state">Заполните цену продажи и цену закупки</div>
            )}
          </div>

          <div className="card">
            <div className="form-section-title">Статьи расходов</div>
            <div className="table-scroll">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>Статья</th>
                    <th className="num">На штуку</th>
                    <th className="num">На партию</th>
                    <th className="num">% от цены</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><b>Выручка</b></td>
                    <td className="num">{formatMoney(result.sellPrice)}</td>
                    <td className="num">{formatMoney(result.revenue)}</td>
                    <td className="num">100%</td>
                  </tr>
                  {expenseRows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td className={`num${row.isProfit && row.value < 0 ? ' report-cell-red' : ''}`}>{formatMoney(row.value)}</td>
                      <td className={`num${row.isProfit && row.value < 0 ? ' report-cell-red' : ''}`}>{formatMoney(row.value * result.quantity)}</td>
                      <td className="num">{result.sellPrice > 0 ? `${((row.value / result.sellPrice) * 100).toFixed(1)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
