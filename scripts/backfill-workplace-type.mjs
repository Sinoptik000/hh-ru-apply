/**
 * Проставляет workplaceType для всех существующих записей в очереди.
 *
 * Использует descriptionPreview + remoteNote для определения типа.
 *
 * Usage: node scripts/backfill-workplace-type.mjs
 */

import { loadQueue, saveQueue } from '../lib/store.mjs';
import { determineWorkplaceType } from '../lib/filters.mjs';

function countByType(items) {
  const counts = {};
  for (const item of items) {
    const t = item.workplaceType || 'не было';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

async function main() {
  const queue = loadQueue();
  console.log(`Всего записей: ${queue.length}`);
  console.log('До:', countByType(queue));

  let updated = 0;
  for (const item of queue) {
    if (item.workplaceType) continue; // Уже есть

    // Собираем доступный текст для анализа
    const textBlob = [
      item.title || '',
      item.company || '',
      item.salaryRaw || '',
      item.descriptionPreview || '',
      item.remoteNote || '',
    ].join(' ').toLowerCase();

    item.workplaceType = determineWorkplaceType(textBlob);
    updated++;
  }

  saveQueue(queue);
  console.log(`Обновлено: ${updated}`);
  console.log('После:', countByType(queue));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
