import fs from 'fs';
import { QUEUE_FILE, DATA_DIR } from './paths.mjs';

export function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
}

export function saveQueue(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${QUEUE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, QUEUE_FILE);
}

export function knownVacancyIds() {
  return new Set(loadQueue().map((x) => x.vacancyId));
}

/**
 * Добавляет запись, если такого vacancyId ещё нет в очереди.
 */
export function addVacancyRecord(item) {
  const q = loadQueue();
  if (q.some((x) => x.vacancyId === item.vacancyId)) {
    return false;
  }
  q.push(item);
  saveQueue(q);
  return true;
}

export function updateVacancyRecord(recordId, patch) {
  const q = loadQueue();
  const i = q.findIndex((x) => x.id === recordId);
  if (i === -1) return false;
  q[i] = { ...q[i], ...patch, updatedAt: new Date().toISOString() };
  saveQueue(q);
  return true;
}

export function getVacancyRecord(recordId) {
  return loadQueue().find((x) => x.id === recordId);
}

export function removeVacancyRecord(recordId) {
  const q = loadQueue();
  const next = q.filter((x) => x.id !== recordId);
  if (next.length === q.length) return false;
  saveQueue(next);
  return true;
}
