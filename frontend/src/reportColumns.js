// Единственное место, где перечислены показатели "Отчёта".
//
// Раньше их было два: колонки таблиц в Report.jsx и параллельный список строк в ReportMobile.jsx.
// Списки приходилось держать одинаковыми руками, и цена ошибки была неприятной — колонку
// добавляют в отчёт, про мобильную версию забывают, и на телефоне цифра просто исчезает, молча.
// Теперь мобильные наборы ВЫВОДЯТСЯ из колонок таблицы, поэтому разойтись они физически не могут:
// новая колонка сама появляется и в шторке месяца, и в ленте показателей.
//
// Что делать, если добавляете колонку: дописать её в MAIN_COLUMNS (и, если она считается по
// товарам, в PRODUCT_COLUMNS) — этого достаточно. Дополнительно стоит решить три вещи:
//   • красить её как расход, доход или справочную величину — RED_KEYS / GREEN_KEYS / YELLOW_KEYS;
//   • показывать ли под суммой долю от базы маржи — PERCENT_OF_REVENUE_KEYS;
//   • где она должна стоять в мобильной ленте — METRIC_ORDER (если не указать, встанет в конец).

export const GENERAL_COLUMNS = [
  { key: 'month', label: 'Месяц' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'taxes', label: 'Налоги (3%)' },
];

export const MAIN_COLUMNS = [
  { key: 'month', label: 'Месяц' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'cost_of_goods', label: 'Себестоимость' },
  { key: 'returns', label: 'Возвраты' },
  { key: 'cost_of_returns', label: 'Себестоимость возвратов' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'taxes', label: 'Налоги (3%)' },
  { key: 'marketing', label: 'Маркетинг' },
  { key: 'packaging', label: 'Упаковка' },
  { key: 'other_expenses', label: 'Прочие расходы' },
  { key: 'net_profit', label: 'Чистая прибыль' },
  { key: 'margin', label: 'Маржа' },
  { key: 'roi', label: 'ROI' },
];

// Разбивка по товарам внутри развёрнутого месяца "Основного отчёта" — те же колонки, что в
// MAIN_COLUMNS, только вместо "Месяц" — товар, а единый "Маркетинг" раскрыт на три источника
// (реклама, бонусы от продавца, бонусы за отзыв) — все три точно разносятся по товару через
// привязку кампания→товар. Упаковка и прочие расходы распределяются сервером между товарами
// пропорционально количеству выданных заказов за месяц.
export const PRODUCT_COLUMNS = [
  { key: 'product_name', label: 'Товар' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'cost_of_goods', label: 'Себестоимость' },
  { key: 'returns', label: 'Возвраты' },
  { key: 'cost_of_returns', label: 'Себестоимость возвратов' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'taxes', label: 'Налоги (3%)' },
  { key: 'marketing_ads', label: 'Реклама товаров' },
  { key: 'marketing_bonuses', label: 'Бонусы от продавца' },
  { key: 'marketing_reviews', label: 'Бонусы за отзыв' },
  { key: 'packaging', label: 'Упаковка' },
  { key: 'other_expenses', label: 'Прочие расходы' },
  { key: 'net_profit', label: 'Чистая прибыль' },
  { key: 'margin', label: 'Маржа' },
  { key: 'roi', label: 'ROI' },
];

export const SELF_BUY_COLUMNS = [
  { key: 'month', label: 'Месяц' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'taxes', label: 'Налоги (3%)' },
];

// Столбцы, которые красим сплошным цветом в "Основном отчёте"
export const GREEN_KEYS = new Set(['revenue', 'net_profit']);
export const YELLOW_KEYS = new Set(['cost_of_returns']);
export const RED_KEYS = new Set([
  'cost_of_goods', 'returns', 'commission', 'delivery', 'taxes',
  'marketing', 'marketing_ads', 'marketing_bonuses', 'marketing_reviews',
  'packaging', 'other_expenses',
]);

// Колонки, для которых под суммой показываем долю от полной выручки — той же базы, от которой
// считается маржа. "Себестоимости возвратов" здесь намеренно нет:
// это справочная сумма, которая не вычитается из прибыли. "Чистая прибыль" тоже не входит —
// для неё уже есть отдельная колонка "Маржа" с тем же смыслом.
// Единый "Маркетинг" есть только в строке месяца, а в разбивке по товарам он раскрыт на три
// колонки — поэтому в наборе перечислены и он, и все три.
export const PERCENT_OF_REVENUE_KEYS = new Set([
  'cost_of_goods', 'returns', 'commission', 'delivery', 'taxes',
  'marketing', 'marketing_ads', 'marketing_bonuses', 'marketing_reviews',
  'packaging', 'other_expenses',
]);

// Показатели-проценты: форматируются как "20.0%", а не как сумма, и на компьютере красятся
// градиентом вместо сплошного цвета.
export const PERCENT_VALUE_KEYS = new Set(['margin', 'roi']);

// ===== Дальше — то, что выводится из наборов выше для мобильной версии =====

// Ключи, которые в мобильной раскладке показываются не строкой расхода, а отдельно: заголовком
// (месяц/товар), первой строкой (выручка) и итогом (прибыль, маржа, ROI).
const MONTH_STRUCTURAL = ['month', 'revenue', 'net_profit', 'margin', 'roi'];
const PRODUCT_STRUCTURAL = ['product_name', 'revenue', 'net_profit', 'margin', 'roi'];

// "Себестоимость возвратов" — справочная сумма: она не вычитается и не прибавляется к прибыли.
const MONTH_LINE_EXTRAS = {
  cost_of_returns: { informational: true, note: 'справочно, не влияет на прибыль' },
};
const PRODUCT_LINE_EXTRAS = {
  cost_of_returns: { informational: true, note: 'справочно, не влияет на прибыль' },
};

function toLines(columns, structural, extras) {
  return columns
    .filter((col) => !structural.includes(col.key))
    .map((col) => ({ ...col, ...(extras[col.key] || {}) }));
}

export const MONTH_LINES = toLines(MAIN_COLUMNS, MONTH_STRUCTURAL, MONTH_LINE_EXTRAS);
export const PRODUCT_LINES = toLines(PRODUCT_COLUMNS, PRODUCT_STRUCTURAL, PRODUCT_LINE_EXTRAS);

// Порядок показателей в мобильной ленте — не как в таблице, а по частоте использования:
// прибыль и маржа первыми. Список неполный намеренно: колонка, которой здесь нет, встанет
// в конец ленты в порядке таблицы — то есть новая колонка не потеряется, даже если про этот
// список забыть.
const METRIC_ORDER = ['net_profit', 'margin', 'revenue', 'cost_of_goods', 'commission', 'marketing'];

export const METRICS = MAIN_COLUMNS
  .filter((col) => col.key !== 'month')
  .map((col, index) => ({
    ...col,
    tone: YELLOW_KEYS.has(col.key) ? 'warn' : (RED_KEYS.has(col.key) ? 'down' : 'up'),
    percent: PERCENT_VALUE_KEYS.has(col.key),
    // Внутри "неупорядоченного хвоста" сохраняем порядок таблицы.
    sortIndex: METRIC_ORDER.indexOf(col.key) === -1 ? METRIC_ORDER.length + index : METRIC_ORDER.indexOf(col.key),
  }))
  .sort((a, b) => a.sortIndex - b.sortIndex);
