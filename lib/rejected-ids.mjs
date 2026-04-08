import fs from 'fs';
import { REJECTED_IDS_FILE, DATA_DIR } from './paths.mjs';

/**
 * Загружает множество отклонённых vacancyId из файла.
 * Файл никогда не очищается — это перманентный чёрный список.
 */
export function loadRejectedVacancyIds() {
  if (!fs.existsSync(REJECTED_IDS_FILE)) {
    return new Set();
  }
  const lines = fs.readFileSync(REJECTED_IDS_FILE, 'utf8').split('\n').filter(Boolean);
  const ids = new Set();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.vacancyId) {
        ids.add(parsed.vacancyId);
      }
    } catch {
      // Пропускаем битые строки
    }
  }
  return ids;
}

/**
 * Сохраняет отклонённый vacancyId в перманентный чёрный список.
 * Идемпотентно — не добавляет дубликаты.
 */
export function addRejectedVacancyId(vacancyId, meta = {}) {
  if (!vacancyId) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Проверяем, нет ли уже такого ID
  const existing = loadRejectedVacancyIds();
  if (existing.has(vacancyId)) {
    return; // Уже в чёрном списке
  }

  const record = {
    vacancyId,
    title: meta.title || '',
    url: meta.url || '',
    rejectedAt: new Date().toISOString(),
    reason: meta.reason || '',
  };

  fs.appendFileSync(REJECTED_IDS_FILE, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Инициализирует чёрный список из уже существующих rejected вакансий в очереди.
 * Нужно запустить один раз, чтобы старые отклонённые вакансии тоже попали в фильтр.
 */
export async function initRejectedIdsFromQueue() {
  const { loadQueue } = await import('./store.mjs');
  const queue = loadQueue();
  const rejected = queue.filter(x => x.status === 'rejected');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Записываем все rejected vacancyId (перезаписываем файл)
  const records = rejected.map(x => ({
    vacancyId: x.vacancyId,
    title: x.title || '',
    url: x.url || '',
    rejectedAt: x.updatedAt || x.createdAt || new Date().toISOString(),
    reason: x.feedbackReason || '',
  }));

  const content = records.map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(REJECTED_IDS_FILE, content ? `${content}\n` : '', 'utf8');

  return records.length;
}
