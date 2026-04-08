/**
 * Инициализирует чёрный список отклонённых вакансий из уже существующих rejected записей в очереди.
 *
 * Запускать один раз (или при необходимости), чтобы старые отклонённые вакансии
 * тоже попали в фильтр и не добавлялись повторно при harvest.
 *
 * Usage: node scripts/init-rejected-ids.mjs
 */

import { initRejectedIdsFromQueue } from '../lib/rejected-ids.mjs';

async function main() {
  console.log('Инициализация чёрного списка из отклонённых вакансий...');
  const count = await initRejectedIdsFromQueue();
  console.log(`✅ Добавлено ${count} vacancyId в data/rejected-vacancy-ids.jsonl`);
  if (count === 0) {
    console.log('   (Нет rejected вакансий в очереди, файл создан пустым)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
