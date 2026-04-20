/**
 * Worker script for adding a single vacancy from clipboard.
 * Receives: vacancy URL via command line args
 * Writes progress to data/add-vacancy-progress.json
 * Usage: node scripts/add-vacancy-worker.mjs --url=<vacancy-url> [--record-id=<id>]
 *
 * Требует: npm run login (persistent-профиль с авторизацией на hh.ru)
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { ROOT, DATA_DIR } from '../lib/paths.mjs';
import { sessionProfilePath } from '../lib/paths.mjs';
import { loadPreferences } from '../lib/preferences.mjs';
import { vacancyIdFromUrl, parseVacancyPageWithRetry, waitForVacancyContent } from '../lib/vacancy-parse.mjs';
import { runHardFilters } from '../lib/filters.mjs';
import { addVacancyRecord, knownVacancyIds, getVacancyRecord, updateVacancyRecord } from '../lib/store.mjs';

const PROGRESS_FILE = path.join(DATA_DIR, 'add-vacancy-progress.json');
// Для процесса «Добавление вакансии» по умолчанию работаем в фоне (без окна браузера).
// Можно принудительно вернуть окно: HH_ADD_VACANCY_HEADLESS=0
const headless = process.env.HH_ADD_VACANCY_HEADLESS !== '0';

function updateProgress(updates) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let progress = { step: 'clipboard', percent: 0 };
    const fileExists = fs.existsSync(PROGRESS_FILE);
    if (fileExists) {
      try {
        const raw = fs.readFileSync(PROGRESS_FILE, 'utf-8');
        if (raw && raw.trim()) {
          progress = JSON.parse(raw);
        }
      } catch (e) {
        console.error('[updateProgress] read error:', e.message);
      }
    }
    Object.assign(progress, updates);
    const content = JSON.stringify(progress, null, 2);
    const fd = fs.openSync(PROGRESS_FILE, 'w');
    fs.writeSync(fd, content, 0, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    console.log('[progress]', JSON.stringify({ step: progress.step, percent: progress.percent, message: progress.message }));
  } catch (e) {
    console.error('[updateProgress] write error:', e.message);
  }
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length);
}

function parseArgs() {
  const url = getArgValue('url');
  if (!url) {
    console.error('Usage: node add-vacancy-worker.mjs --url=<vacancy-url> [--record-id=<id>]');
    process.exit(1);
  }
  return {
    vacancyUrl: url,
    recordId: getArgValue('record-id'),
  };
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${label}): ${ms}ms`)), ms)
    )
  ]);
}

/**
 * Запускает браузер ТОЛЬКО с persistent-профилем (залогиненная сессия).
 * Без сессии выдаёт ошибку — требуется: npm run login
 */
async function parsVacancyWithBrowser(vacancyUrl) {
  const profile = sessionProfilePath();

  if (!fs.existsSync(profile)) {
    throw new Error(
      'Сессия не найдена. Выполните: npm run login — для авторизации на hh.ru и сохранения профиля'
    );
  }

  updateProgress({ step: 'parsing', percent: 30, message: 'Открытие браузера (сессия)…' });

  const ctx = await withTimeout(
    chromium.launchPersistentContext(profile, {
      headless,
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      timeout: 30_000,
    }),
    60_000,
    'chromium.launchPersistentContext'
  );

  try {
    const page = await ctx.newPage();
    updateProgress({ step: 'parsing', percent: 40, message: 'Загрузка страницы вакансии…' });
    await withTimeout(
      page.goto(vacancyUrl, { waitUntil: 'networkidle', timeout: 45_000 }),
      60_000,
      'page.goto'
    );
    updateProgress({ step: 'parsing', percent: 55, message: 'Ожидание контента…' });
    await withTimeout(
      waitForVacancyContent(page, 30_000),
      35_000,
      'waitForVacancyContent'
    );
    updateProgress({ step: 'parsing', percent: 65, message: 'Парсинг страницы…' });
    const parsed = await withTimeout(
      parseVacancyPageWithRetry(page, 3),
      45_000,
      'parseVacancyPageWithRetry'
    );
    return parsed;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const { vacancyUrl, recordId } = parseArgs();
  const vacancyId = vacancyIdFromUrl(vacancyUrl);

  if (!vacancyId) {
    updateProgress({ error: 'Неверный URL вакансии', step: 'clipboard', percent: 0 });
    process.exit(1);
  }

  // Проверка сессии ДО начала парсинга
  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    updateProgress({
      error: 'Сессия не найдена. Сначала выполните: npm run login',
      step: 'clipboard',
      percent: 0
    });
    process.exit(1);
  }

  updateProgress({ url: vacancyUrl, vacancyId, step: 'clipboard', percent: 10, message: 'Запуск парсера…' });

  const prefs = loadPreferences();

  updateProgress({ step: 'parsing', percent: 20, message: 'Инициализация…' });

  let parsed;
  try {
    parsed = await parsVacancyWithBrowser(vacancyUrl);
  } catch (e) {
    updateProgress({ error: `Ошибка парсинга: ${e.message}`, step: 'parsing', percent: 30 });
    process.exit(1);
  }

  console.log('[worker] Parsed description length:', parsed.description?.length || 0);
  console.log('[worker] Title:', parsed.title);
  console.log('[worker] Company:', parsed.company);

  updateProgress({ step: 'filters', percent: 70, message: 'Применение фильтров…' });

  const filter = runHardFilters(parsed, prefs);
  if (!filter.pass) {
    updateProgress({
      error: `Не прошла фильтры (${filter.stage}): ${filter.reason}`,
      step: 'filters',
      percent: 70,
    });
    process.exit(0);
  }

  updateProgress({ step: 'saving', percent: 80, message: 'Сохранение…' });

  const known = knownVacancyIds();
  const existingById = recordId ? getVacancyRecord(recordId) : null;
  if (!existingById && known.has(vacancyId)) {
    updateProgress({ error: 'Эта вакансия уже есть в очереди', step: 'saving', percent: 80 });
    process.exit(0);
  }

  const summaryNote = !filter.pass && filter.reason
    ? `Добавлено вручную. Предупреждение фильтра: ${filter.reason}`
    : 'Добавлено вручную без авто-оценки LLM.';

  const patch = {
    vacancyId,
    url: vacancyUrl,
    searchQuery: '(добавлена вручную)',
    title: parsed.title,
    company: parsed.company,
    salaryRaw: parsed.salaryRaw,
    salaryEstimate: filter.salaryEstimate,
    remoteNote: filter.remoteReason,
    salaryNote: filter.salaryReason,
    employment: parsed.employment,
    workplaceType: filter.workplaceType || ['не указано'],
    languages: parsed.languages || [],
    englishLevel: (parsed.languages || []).find(l => /английск|english/i.test(l.name || ''))?.level || null,
    paymentSchedule: parsed.paymentSchedule || null,
    employmentType: parsed.employmentType || null,
    workFormat: parsed.workFormat || null,
    schedule: parsed.schedule || null,
    workHours: parsed.workHours || null,
    viewerCount: parsed.viewerCount || null,
    descriptionPreview: parsed.description.slice(0, 800),
    descriptionForLlm: parsed.description,
    llmProvider: 'manual',
    openRouterModel: null,
    scoreVacancy: null,
    scoreCvMatch: null,
    scoreOverall: null,
    geminiScore: null,
    geminiSummary: summaryNote,
    geminiRisks: '',
    geminiMatchCv: 'unknown',
    geminiTags: ['ручное добавление'],
    status: 'manual',
    feedbackReason: '',
  };

  const savedRecordId = recordId || crypto.randomUUID();
  if (existingById) {
    updateVacancyRecord(savedRecordId, patch);
    updateProgress({ step: 'saving', percent: 100, message: 'Готово!', done: true, recordId: savedRecordId });
  } else {
    const added = addVacancyRecord({
      id: savedRecordId,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      ...patch,
    });
    if (added) {
      updateProgress({ step: 'saving', percent: 100, message: 'Готово!', done: true, recordId: savedRecordId });
    } else {
      updateProgress({ error: 'Вакансия уже была в очереди', step: 'saving', percent: 80 });
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('[main.catch]', e);
  updateProgress({ error: e.message, step: 'parsing', percent: 30 });
  process.exit(1);
});
