/**
 * Worker script for adding a single vacancy from clipboard.
 * Receives: vacancy URL via command line args
 * Writes progress to data/add-vacancy-progress.json
 * Usage: node scripts/add-vacancy-worker.mjs --url=<vacancy-url>
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { sessionProfilePath, ROOT, DATA_DIR } from '../lib/paths.mjs';
import { loadPreferences } from '../lib/preferences.mjs';
import { parseVacancyPage, vacancyIdFromUrl } from '../lib/vacancy-parse.mjs';
import { runHardFilters } from '../lib/filters.mjs';
import { loadCvBundle } from '../lib/cv-load.mjs';
import { getOpenRouterApiKey, scoreVacancyWithOpenRouter } from '../lib/openrouter-score.mjs';
import { addVacancyRecord, knownVacancyIds } from '../lib/store.mjs';

const PROGRESS_FILE = path.join(DATA_DIR, 'add-vacancy-progress.json');
const headless = process.env.HH_HEADLESS === '1';

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
    // Write and flush to ensure data is on disk
    const fd = fs.openSync(PROGRESS_FILE, 'w');
    fs.writeSync(fd, content, 0, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    console.log('[progress]', JSON.stringify({ step: progress.step, percent: progress.percent, message: progress.message }));
  } catch (e) {
    console.error('[updateProgress] write error:', e.message);
  }
}

function parseArgs() {
  const urlArg = process.argv.find(a => a.startsWith('--url='));
  if (!urlArg) {
    console.error('Usage: node add-vacancy-worker.mjs --url=<vacancy-url>');
    process.exit(1);
  }
  return urlArg.split('=')[1];
}

function looksLikeLoginUrl(url) {
  const u = url.toLowerCase();
  return u.includes('/account/login') || u.includes('oauth.hh.ru') || u.includes('/logon');
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${label}): ${ms}ms`)), ms)
    )
  ]);
}

async function safeParseVacancyPage(page) {
  // Wrap the entire parse in a timeout
  return withTimeout(
    page.evaluate(() => {
      const t = (sel) =>
        document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

      const title = t('[data-qa="vacancy-title"]') || t('h1');
      const company = t('[data-qa="vacancy-company-name"]') || t('a[data-qa="vacancy-company-name"]');
      const salary = t('[data-qa="vacancy-salary"]');
      const experience = t('[data-qa="vacancy-experience"]');
      const employment = t('[data-qa="work-formats-text"]') || t('[data-qa="vacancy-employment-mode"]') || t('[data-qa="vacancy-view-employment-mode"]');
      const address = t('[data-qa="vacancy-view-location"]') || t('[data-qa="vacancy-view-raw-address"]');

      let description =
        t('[data-qa="vacancy-description"]') ||
        t('.vacancy-description') ||
        t('[itemprop="description"]');

      let languages = [];
      const langMatch = document.body.textContent.match(/(Английский|English)\s*—\s*(\S+(?:\s*—\s*\S+)?)/i);
      if (langMatch) {
        const levelMatch = langMatch[2].match(/(A[12]|B[12]|C[12]|Advanced|Proficiency|Native)/i);
        if (levelMatch) {
          languages.push({ name: langMatch[1].trim(), level: levelMatch[1].trim() });
        }
      }

      if (description.length > 12_000) description = `${description.slice(0, 12_000)}…`;

      const blob = [title, company, salary, experience, employment, address, description]
        .join('\n')
        .toLowerCase();

      return {
        title,
        company,
        salaryRaw: salary,
        experience,
        employment,
        address,
        description,
        languages,
        textBlob: blob,
      };
    }),
    30000,
    'page.evaluate'
  );
}

async function main() {
  const vacancyUrl = parseArgs();
  const vacancyId = vacancyIdFromUrl(vacancyUrl);

  if (!vacancyId) {
    updateProgress({ error: 'Неверный URL вакансии', step: 'clipboard', percent: 0 });
    process.exit(1);
  }

  updateProgress({ url: vacancyUrl, vacancyId, step: 'clipboard', percent: 10, message: 'Проверка сессии…' });

  const prefs = loadPreferences();
  const profile = sessionProfilePath();

  if (!fs.existsSync(profile)) {
    updateProgress({ error: 'Нет профиля Chromium. Сначала: npm run login', step: 'clipboard', percent: 0 });
    process.exit(1);
  }

  const cvBundle = await loadCvBundle();
  for (const w of cvBundle.warnings) console.warn('[CV]', w);
  if (!cvBundle.text.trim()) {
    updateProgress({ error: 'Нет текста CV — положите .pdf или .txt в папку CV/', step: 'clipboard', percent: 0 });
    process.exit(1);
  }

  updateProgress({ step: 'parsing', percent: 20, message: 'Открытие браузера…' });

  let ctx;
  try {
    ctx = await withTimeout(
      chromium.launchPersistentContext(profile, {
        headless,
        viewport: { width: 1280, height: 800 },
        locale: 'ru-RU',
        timeout: 30000,
      }),
      60000,
      'launchPersistentContext'
    );
  } catch (e) {
    updateProgress({ error: `Не удалось запустить браузер: ${e.message}`, step: 'parsing', percent: 20 });
    process.exit(1);
  }

  updateProgress({ step: 'parsing', percent: 25, message: 'Навигация…' });

  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await withTimeout(
      page.goto('https://hh.ru/applicant', { waitUntil: 'domcontentloaded', timeout: 30_000 }),
      45000,
      'applicant goto'
    );
    await page.waitForTimeout(1500);
    if (looksLikeLoginUrl(page.url())) {
      updateProgress({ error: 'Сессия не активна. Выполните: npm run login', step: 'parsing', percent: 25 });
      await Promise.race([
        ctx.close(),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]).catch(() => {});
      process.exit(1);
    }

    updateProgress({ step: 'parsing', percent: 30, message: 'Загрузка вакансии…' });
    await withTimeout(
      page.goto(vacancyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
      45000,
      'vacancy goto'
    );
    await page.waitForTimeout(1500);

    updateProgress({ step: 'parsing', percent: 40, message: 'Парсинг страницы…' });

    // Small wait to ensure page content is loaded
    await page.waitForTimeout(500);

    const parsed = await withTimeout(
      safeParseVacancyPage(page),
      45000,
      'safeParseVacancyPage'
    );

    updateProgress({ step: 'filters', percent: 50, message: 'Применение фильтров…' });

    const filter = runHardFilters(parsed, prefs);
    if (!filter.pass) {
      updateProgress({
        error: `Не прошла фильтры (${filter.stage}): ${filter.reason}`,
        step: 'filters',
        percent: 50
      });
      await Promise.race([
        ctx.close(),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]).catch(() => {});
      process.exit(0);
    }

    updateProgress({ step: 'scoring', percent: 60, message: 'Анализ ИИ…' });

    let llm = {
      score: 0,
      scoreVacancy: 0,
      scoreCvMatch: 0,
      scoreOverall: 0,
      summary: '',
      risks: '',
      matchCv: 'unknown',
      tags: [],
      providerModel: null,
    };

    if (getOpenRouterApiKey()) {
      try {
        llm = await withTimeout(
          scoreVacancyWithOpenRouter(
            {
              title: parsed.title,
              company: parsed.company,
              salaryRaw: parsed.salaryRaw,
              description: parsed.description,
              url: vacancyUrl,
            },
            cvBundle,
            prefs
          ),
          120000,
          'scoreVacancyWithOpenRouter'
        );
        updateProgress({ step: 'scoring', percent: 80, message: 'ИИ: ' + (llm.scoreOverall ?? llm.score ?? 0) });
      } catch (e) {
        console.error(' OpenRouter error:', e.message);
        llm.summary = `Ошибка OpenRouter: ${e.message}`;
      }
    } else {
      llm.summary = '(OpenRouter_API_KEY не настроен — оценка пропущена)';
    }

    updateProgress({ step: 'saving', percent: 90, message: 'Сохранение…' });

    const known = knownVacancyIds();
    if (known.has(vacancyId)) {
      updateProgress({ error: 'Эта вакансия уже есть в очереди', step: 'saving', percent: 90 });
      await Promise.race([
        ctx.close(),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]).catch(() => {});
      process.exit(0);
    }

    const record = {
      id: crypto.randomUUID(),
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
      descriptionPreview: parsed.description.slice(0, 600),
      descriptionForLlm: parsed.description.slice(0, 6000),
      llmProvider: 'openrouter',
      openRouterModel: llm.providerModel || null,
      scoreVacancy: llm.scoreVacancy,
      scoreCvMatch: llm.scoreCvMatch,
      scoreOverall: llm.scoreOverall,
      geminiScore: llm.scoreOverall ?? llm.score,
      geminiSummary: llm.summary,
      geminiRisks: llm.risks,
      geminiMatchCv: llm.matchCv,
      geminiTags: llm.tags,
      status: 'pending',
      feedbackReason: '',
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };

    const added = addVacancyRecord(record);

    if (added) {
      updateProgress({ step: 'saving', percent: 100, message: 'Готово!', done: true, recordId: record.id });
    } else {
      updateProgress({ error: 'Вакансия уже была в очереди', step: 'saving', percent: 90 });
    }

    // Force-close browser — don't wait forever
    try {
      await Promise.race([
        ctx.close(),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]);
    } catch (e) {
      console.log('[ctx.close] ignored error:', e.message);
    }
    process.exit(0);

  } catch (e) {
    updateProgress({ error: `Ошибка: ${e.message}`, step: 'parsing', percent: 30 });
    if (ctx) {
      await Promise.race([
        ctx.close(),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]).catch(() => {});
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[main.catch]', e);
  updateProgress({ error: e.message, step: 'parsing', percent: 30 });
  process.exit(1);
});