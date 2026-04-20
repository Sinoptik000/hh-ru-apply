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

import { ROOT, DATA_DIR } from '../lib/paths.mjs';
import { loadPreferences } from '../lib/preferences.mjs';
import { vacancyIdFromUrl } from '../lib/vacancy-parse.mjs';
import { runHardFilters } from '../lib/filters.mjs';
import { addVacancyRecord, knownVacancyIds, getVacancyRecord, updateVacancyRecord } from '../lib/store.mjs';

const PROGRESS_FILE = path.join(DATA_DIR, 'add-vacancy-progress.json');
// Для процесса "Добавление вакансии" по умолчанию работаем в фоне (без окна браузера).
// Можно принудительно вернуть окно только для этого процесса: HH_ADD_VACANCY_HEADLESS=0.
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

      // Опыт
      const experience = t('[data-qa="vacancy-experience"]') ||
        (() => {
          const el = Array.from(document.querySelectorAll('p, span, div')).find(e =>
            /опыт\s*работы\s*:?\s*\S/i.test(e.textContent)
          );
          return el ? el.textContent.replace(/.*опыт\s*работы\s*:\s*/i, '').trim() : '';
        })();

      // Занятость / формат
      const employment = t('[data-qa="work-formats-text"]') ||
        t('[data-qa="vacancy-employment-mode"]') ||
        t('[data-qa="vacancy-view-employment-mode"]');

      // Адрес
      const address = t('[data-qa="vacancy-view-location"]') ||
        t('[data-qa="vacancy-view-raw-address"]');

      // Выплаты — ищем "Выплаты: раз в месяц"
      const paymentSchedule = (() => {
        const el = Array.from(document.querySelectorAll('p, span')).find(e =>
          /выплаты\s*:?\s*/i.test(e.textContent)
        );
        return el ? el.textContent.replace(/.*выплаты\s*:\s*/i, '').trim() : '';
      })();

      // График — ищем "График: 5/2"
      const schedule = (() => {
        const el = Array.from(document.querySelectorAll('p, span')).find(e =>
          /график\s*:?\s*/i.test(e.textContent)
        );
        return el ? el.textContent.replace(/.*график\s*:\s*/i, '').trim() : '';
      })();

      // Рабочие часы — ищем "Рабочие часы: 8"
      const workHours = (() => {
        const el = Array.from(document.querySelectorAll('p, span')).find(e =>
          /рабочие\s*часы\s*:?\s*\d/i.test(e.textContent)
        );
        return el ? el.textContent.replace(/.*рабочие\s*часы\s*:\s*/i, '').trim() : '';
      })();

      // Сколько человек смотрит вакансию
      const viewerCount = (() => {
        const el = Array.from(document.querySelectorAll('p, span, div')).find(e =>
          /смотрет/i.test(e.textContent) && /ваканс/i.test(e.textContent)
        );
        if (!el) return null;
        const childMatch = el.innerHTML.match(/(\d+)\s*(?:человек|чел\.?)/i);
        if (childMatch) return childMatch[1];
        const match = el.textContent.match(/(\d+)\s*(?:человек|чел\.?)/i);
        return match ? match[1] : null;
      })();

      // Оформление — sibling сразу после "Оформление:"
      const employmentType = (() => {
        const allEls = Array.from(document.querySelectorAll('*'));
        const labelEl = allEls.find(e => /^оформление\s*:\s*/i.test(e.textContent));
        if (!labelEl) return '';
        let sibling = labelEl.nextElementSibling;
        if (sibling) return sibling.textContent.replace(/\s+/g, ' ').trim();
        const parent = labelEl.parentElement;
        if (parent) {
          const siblings = Array.from(parent.childNodes).filter(n => n.nodeType === 1);
          const idx = siblings.indexOf(labelEl);
          if (idx >= 0 && idx < siblings.length - 1) {
            return siblings[idx + 1].textContent.replace(/\s+/g, ' ').trim();
          }
        }
        return '';
      })();

      // Описание вакансии: пробуем разные селекторы
      let description =
        t('[data-qa="vacancy-description"]') ||
        t('[data-qa="vacancy-view-vacancyDescription"]') ||
        t('.vacancy-description') ||
        t('.vacancy-section') ||
        t('[itemprop="description"]') ||
        t('.bloko-text') ||
        document.querySelector('[class*="vacancy-description"]')?.textContent?.replace(/\s+/g, ' ')?.trim() ||
        (() => {
          const article = document.querySelector('article') || document.querySelector('section[role="main"]') || document.querySelector('main');
          if (!article) return '';
          return article.textContent.replace(/\s+/g, ' ').trim().slice(0, 15000);
        })() ||
        '';

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
        paymentSchedule,
        employmentType,
        schedule,
        workHours,
        viewerCount,
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
  const { vacancyUrl, recordId } = parseArgs();
  const vacancyId = vacancyIdFromUrl(vacancyUrl);

  if (!vacancyId) {
    updateProgress({ error: 'Неверный URL вакансии', step: 'clipboard', percent: 0 });
    process.exit(1);
  }

  updateProgress({ url: vacancyUrl, vacancyId, step: 'clipboard', percent: 10, message: 'Проверка сессии…' });

  const prefs = loadPreferences();

updateProgress({ step: 'parsing', percent: 20, message: 'Открытие браузера…' });

let browser;
try {
  browser = await withTimeout(
    chromium.launch({
      headless,
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
      timeout: 30000,
    }),
    60000,
    'chromium.launch'
  );
} catch (e) {
  updateProgress({ error: `Не удалось запустить браузер: ${e.message}`, step: 'parsing', percent: 20 });
  process.exit(1);
}

const ctx = await browser.newContext();
const page = await ctx.newPage();

updateProgress({ step: 'parsing', percent: 25, message: 'Навигация…' });

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
        browser.close(),
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
        browser.close(),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]).catch(() => {});
      process.exit(0);
    }

    updateProgress({ step: 'saving', percent: 70, message: 'Сохранение…' });

    const known = knownVacancyIds();
    const existingById = recordId ? getVacancyRecord(recordId) : null;
    if (!existingById && known.has(vacancyId)) {
      updateProgress({ error: 'Эта вакансия уже есть в очереди', step: 'saving', percent: 70 });
      await Promise.race([
        browser.close(),
        new Promise(r => setTimeout(() => r('timeout'), 3000))
      ]).catch(() => {});
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
      // Новые поля
      paymentSchedule: parsed.paymentSchedule || null,
      employmentType: parsed.employmentType || null,
      schedule: parsed.schedule || null,
      workHours: parsed.workHours || null,
      viewerCount: parsed.viewerCount || null,
      descriptionPreview: parsed.description.slice(0, 600),
      descriptionForLlm: '',
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

    let savedRecordId = recordId || crypto.randomUUID();
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
        updateProgress({ error: 'Вакансия уже была в очереди', step: 'saving', percent: 70 });
      }
    }

    // Force-close browser — don't wait forever
    try {
      await Promise.race([
        browser.close(),
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
        browser.close(),
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
