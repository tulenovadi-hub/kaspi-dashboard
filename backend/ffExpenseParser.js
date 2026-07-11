// ffExpenseParser.js — разбор PDF-отчётов от фулфилмент-центра (WONDER): два вида отчётов,
// "ФФ услуга" (упаковка/обработка по каждому заказу) и "Хранение" (аренда склада по дням).
// Оба отчёта сгенерированы отчётной системой без пробелов между колонками одной строки —
// значения слиты в одну строку текста (например "988.582.0595311" — сумма+объём+кол-во товаров).
// pdf-parse по умолчанию просто конкатенирует текстовые фрагменты одной строки без разделителя,
// поэтому используем свой pagerender: вставляем таб, когда между соседними фрагментами есть
// заметный горизонтальный зазор (это и есть граница колонки в таблице).
const pdf = require('pdf-parse');

function renderPage(pageData) {
  const renderOptions = { normalizeWhitespace: false, disableCombineTextItems: false };
  return pageData.getTextContent(renderOptions).then((textContent) => {
    let lastY, lastX, lastWidth;
    let text = '';
    for (const item of textContent.items) {
      const x = item.transform[4];
      const y = item.transform[5];
      if (lastY === y || lastY === undefined) {
        if (lastX !== undefined && x - (lastX + lastWidth) > 1.5) text += '\t';
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = y;
      lastX = x;
      lastWidth = item.width;
    }
    return text;
  });
}

function parseDate(ddmmyyyy) {
  const match = String(ddmmyyyy).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function parseMoney(value) {
  if (value === null || value === undefined) return 0;
  const num = Number(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(num) ? num : 0;
}

// "Отчёт по хранению" — таблица по дням (Дата, Сумма за хранение, Объём, Кол-во товаров).
// Дата уже даёт точную привязку к месяцу, ничего дополнительно сопоставлять не нужно.
function parseStorageReport(text) {
  const periodMatch = text.match(/Период:\t(\d{2}\.\d{2}\.\d{4})\s*[–-]\s*(\d{2}\.\d{2}\.\d{4})/);
  const periodFrom = periodMatch ? parseDate(periodMatch[1]) : null;
  const periodTo = periodMatch ? parseDate(periodMatch[2]) : null;

  const rows = [];
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const date = parseDate(parts[0]);
    if (!date) continue;
    rows.push({
      rowKey: `ff_storage_${date}`,
      expenseDate: date,
      amount: parseMoney(parts[1]),
      orderNumber: null,
    });
  }

  return { type: 'storage', periodFrom, periodTo, rows };
}

// "ФФ услуга" — построчно по заказам. Колонок много и часть ячеек в строке может быть пустой
// (например, не у всех заказов есть "Подарок" или конкретный курьерский сервис), из-за чего
// число полей после разбиения по табу отличается от строки к строке — поэтому не полагаемся
// на фиксированную позицию каждой колонки. Нужны только: код заказа (сопоставляем с orders.code,
// чтобы узнать настоящую дату заказа) и "Итого [все расходы]" — она всегда последняя колонка
// и всегда начинается с ₸, это и есть надёжный якорь конца строки.
function parsePackagingReport(text) {
  const fromMatch = text.match(/Дата начало:\t(\d{2}\.\d{2}\.\d{4})/);
  const toMatch = text.match(/Дата конец:\t(\d{2}\.\d{2}\.\d{4})/);
  const periodFrom = fromMatch ? parseDate(fromMatch[1]) : null;
  const periodTo = toMatch ? parseDate(toMatch[1]) : null;

  const rows = [];
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    // Строки реальных заказов длинные (14+ колонок); шапка и итоговая сводка сверху — короче.
    if (parts.length < 12) continue;
    if (!/^\d+$/.test(parts[0])) continue; // первая колонка — порядковый номер строки

    const lastField = parts[parts.length - 1];
    if (!/^₸[\d\s]+$/.test(lastField)) continue;

    // Код заказа обычно во второй колонке. Если у заказа не сохранился код (редкий случай в
    // выгрузке ФФ), вторая колонка — это уже SKU товара; он не найдётся в таблице orders,
    // и такая строка просто попадёт в fallback по дате конца периода — то же самое, что и для
    // любого не найденного в базе заказа.
    const orderNumber = /^\d{5,}$/.test(parts[1]) ? parts[1] : null;

    rows.push({
      rowKey: `ff_packaging_${periodTo || 'unknown'}_row${parts[0]}`,
      amount: parseMoney(lastField),
      orderNumber,
    });
  }

  return { type: 'packaging', periodFrom, periodTo, rows };
}

async function parseFFReport(buffer) {
  const data = await pdf(buffer, { pagerender: renderPage });
  const text = data.text;

  if (text.includes('ОТЧЕТ ПО ХРАНЕНИЮ')) {
    return parseStorageReport(text);
  }
  if (text.includes('Расходы на ФФ') && text.includes('Код заказа')) {
    return parsePackagingReport(text);
  }
  throw new Error('Не удалось распознать формат файла — это точно отчёт фулфилмента (услуга ФФ или хранение)?');
}

module.exports = { parseFFReport };
