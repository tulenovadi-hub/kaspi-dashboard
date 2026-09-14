// Единая очередь для всех обращений к Kaspi.
//
// У сервера несколько источников синхронизации: минутный cron на Oracle, полная сверка
// трижды в сутки, ночное задание внутри сервера и ручные кнопки. Без общей очереди они
// могли стартовать одновременно и создавать лишнюю нагрузку на Kaspi и базу.
let queueTail = Promise.resolve();
let pendingTasks = 0;
let activeTask = null;

function enqueueKaspiSync(name, task, { skipIfBusy = false } = {}) {
  if (skipIfBusy && pendingTasks > 0) return null;

  pendingTasks += 1;
  const queuedAt = Date.now();

  const run = queueTail
    .catch(() => undefined)
    .then(async () => {
      activeTask = name;
      console.log(`Очередь Kaspi: запуск ${name} (ожидание ${Date.now() - queuedAt} мс)`);
      try {
        return await task();
      } finally {
        console.log(`Очередь Kaspi: завершено ${name}`);
        activeTask = null;
      }
    });

  const tracked = run.finally(() => {
    pendingTasks -= 1;
  });

  // Хвост очереди никогда не остаётся отклонённым: ошибка одной задачи не блокирует
  // запуск следующей. Сам вызывающий код всё равно получает исходный Promise с ошибкой.
  queueTail = tracked.catch(() => undefined);
  return run;
}

function getKaspiSyncState() {
  return {
    busy: pendingTasks > 0,
    pending: pendingTasks,
    active: activeTask,
  };
}

module.exports = { enqueueKaspiSync, getKaspiSyncState };
