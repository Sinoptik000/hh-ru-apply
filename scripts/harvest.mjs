/**
 * Сбор вакансий: поиск → парсинг → фильтры → оценка через OpenRouter (бесплатные модели по умолчанию) → data/vacancies-queue.json.
 *
 * Перед запуском: npm run login, в secrets — OpenRouter_API_KEY.
 * Флаги: --skip-llm | --skip-gemini — без вызова LLM (score=0).
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { loadSearchKeywords } from '../lib/load-keywords.mjs';
import { sessionProfilePath, ROOT, SKIPPED_FILE, DATA_DIR } from '../lib/paths.mjs';
import { loadPreferences } from '../lib/preferences.mjs';
import { parseVacancyPage, vacancyIdFromUrl } from '../lib/vacancy-parse.mjs';
import { runHardFilters } from '../lib/filters.mjs';
import { loadCvBundle } from '../lib/cv-load.mjs';
import {
  getOpenRouterApiKey,
  scoreVacancyWithOpenRouter,
} from '../lib/openrouter-score.mjs';
import { addVacancyRecord, knownVacancyIds } from '../lib/store.mjs';
import { loadRejectedVacancyIds } from '../lib/rejected-ids.mjs';

const DEFAULT_KEYWORDS_FILE = path.join(ROOT, 'config', 'search-keywords.txt');

const headless = process.env.HH_HEADLESS === '1';
const skipLlm =
  process.argv.includes('--skip-llm') || process.argv.includes('--skip-gemini');
const stayOpen = process.argv.includes('--stay-open');
const sessionLimit = Math.min(40, Math.max(1, Number(process.env.HH_SESSION_LIMIT ?? process.env.HH_MAX_TOTAL ?? 7) || 7));
const perKeyLimit = Math.min(30, Math.max(1, Number(process.env.HH_PER_KEYWORD_LIMIT || 8) || 8));

const openDelayMin = Math.max(0, Number(process.env.HH_OPEN_DELAY_MIN_MS || 3000) || 3000);
const openDelayMax = Math.max(openDelayMin, Number(process.env.HH_OPEN_DELAY_MAX_MS || 5000) || 5000);
const searchJitterMin = Math.max(0, Number(process.env.HH_SEARCH_JITTER_MIN_MS || 1000) || 1000);
const searchJitterMax = Math.max(searchJitterMin, Number(process.env.HH_SEARCH_JITTER_MAX_MS || 2000) || 2000);

const keywordsPath = path.resolve(
  process.cwd(),
  (process.env.HH_KEYWORDS_FILE || '').trim() || DEFAULT_KEYWORDS_FILE
);

function randomIntInclusive(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function looksLikeLoginUrl(url) {
  const u = url.toLowerCase();
  return u.includes('/account/login') || u.includes('oauth.hh.ru') || u.includes('/logon');
}

function buildSearchUrl(text) {
  const params = new URLSearchParams();
  params.set('text', text);
  params.set('ored_clusters', 'true');
  const area = (process.env.HH_AREA || '').trim();
  if (area) params.set('area', area);
  return `https://hh.ru/search/vacancy?${params.toString()}`;
}

async function collectVacancyUrls(page) {
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/vacancy/"]')) {
      const href = a.href || '';
      const m = href.match(/\/vacancy\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(`https://hh.ru/vacancy/${id}`);
    }
    return out;
  });
}

function logSkipped(payload) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(SKIPPED_FILE, `${JSON.stringify({ ...payload, at: new Date().toISOString() })}\n`, 'utf8');
}

async function main() {
  const prefs = loadPreferences();

  if (!skipLlm && !getOpenRouterApiKey()) {
    console.error('Нужен OpenRouter_API_KEY (или OPENROUTER_API_KEY) в .env / .env.local / config/secrets.local.env');
    console.error('Шаблон: config/secrets.example.env  |  Либо: npm run harvest -- --skip-llm');
    process.exit(1);
  }

  if (!fs.existsSync(keywordsPath)) {
    console.error('Файл ключей не найден:', keywordsPath);
    process.exit(1);
  }

  const keywords = loadSearchKeywords(keywordsPath);
  if (!keywords.length) {
    console.error('Нет ключей в', keywordsPath);
    process.exit(1);
  }

  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    console.error('Нет профиля Chromium. Сначала: npm run login');
    process.exit(1);
  }

  const cvBundle = await loadCvBundle();
  for (const w of cvBundle.warnings) console.warn('[CV]', w);
  if (!cvBundle.text.trim()) {
    console.error('Нет текста CV — положите .pdf или .txt в папку CV/');
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(profile, {
    headless,
    viewport: { width: 1280, height: 800 },
    locale: 'ru-RU',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://hh.ru/applicant', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    if (looksLikeLoginUrl(page.url())) {
      console.error('Сессия не активна. Выполните: npm run login');
      process.exit(1);
    }

    if (stayOpen) {
      console.log('🔧 Режим --stay-open: браузер открыт, сбор вакансий будет запущен.');
      console.log('Для запуска сбора нажмите Enter в терминале (или подождите 5 секунд).');
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        process.stdin.once('data', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    const seenIds = knownVacancyIds();
    const rejectedIds = loadRejectedVacancyIds();
    const urls = [];
    const globalSeen = new Set();

    for (const key of keywords) {
      if (urls.length >= sessionLimit) break;
      await page.goto(buildSearchUrl(key), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleepMs(randomIntInclusive(searchJitterMin, searchJitterMax));
      const found = await collectVacancyUrls(page);
      let n = 0;
      for (const u of found) {
        if (urls.length >= sessionLimit) break;
        if (n >= perKeyLimit) break;
        const id = vacancyIdFromUrl(u);
        if (!id || globalSeen.has(id) || seenIds.has(id) || rejectedIds.has(id)) continue;
        globalSeen.add(id);
        urls.push({ url: u, query: key });
        n++;
      }
      console.log(`Ключ «${key}»: +${n} URL (в очереди на обход ${urls.length})`);
    }

    if (!urls.length) {
      console.log('Нет новых ссылок (все уже в очереди, в списке отклонённых или пустая выдача).');
      return;
    }

    let added = 0;
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) {
        const pause = randomIntInclusive(openDelayMin, openDelayMax);
        console.log(`Пауза ${pause} мс…`);
        await sleepMs(pause);
      }

      const { url, query } = urls[i];
      const vacancyId = vacancyIdFromUrl(url);
      console.log(`Парсинг ${i + 1}/${urls.length}`, url);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const parsed = await parseVacancyPage(page);

      const filter = runHardFilters(parsed, prefs);
      if (!filter.pass) {
        console.log(`  SKIP [${filter.stage}]: ${filter.reason}`);
        logSkipped({
          vacancyId,
          url,
          query,
          stage: filter.stage,
          reason: filter.reason,
          title: parsed.title,
        });
        continue;
      }

      let llm = {
        score: 0,
        scoreVacancy: 0,
        scoreCvMatch: 0,
        scoreOverall: 0,
        summary: skipLlm ? '(LLM отключён — npm run harvest -- --skip-llm)' : '',
        risks: '',
        matchCv: 'unknown',
        tags: [],
        providerModel: null,
      };

      if (!skipLlm) {
        try {
          llm = await scoreVacancyWithOpenRouter(
            {
              title: parsed.title,
              company: parsed.company,
              salaryRaw: parsed.salaryRaw,
              description: parsed.description,
              url,
            },
            cvBundle,
            prefs
          );
          console.log(
            `  OpenRouter: итог ${llm.scoreOverall} (вакансия ${llm.scoreVacancy}, CV ${llm.scoreCvMatch}) — ${llm.providerModel || '?'}`
          );
        } catch (e) {
          console.error('  OpenRouter error:', e.message);
          llm.summary = `Ошибка OpenRouter: ${e.message}`;
        }
      }

      const record = {
        id: crypto.randomUUID(),
        vacancyId,
        url,
        searchQuery: query,
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

      if (addVacancyRecord(record)) {
        added++;
        console.log('  → В очередь дашборда');
      } else {
        console.log('  → Уже была в очереди, пропуск');
      }
    }

    console.log(`\nГотово. Новых записей в очереди: ${added}. Запустите: npm run dashboard`);

    if (stayOpen) {
      console.log('Браузер открыт. Закройте окно для завершения.');
      await new Promise((resolve) => {
        ctx.on('close', resolve);
        process.on('SIGINT', async () => { await ctx.close(); resolve(); });
        process.on('SIGTERM', async () => { await ctx.close(); resolve(); });
      });
      console.log('Браузер закрыт.');
    }
  } finally {
    if (!stayOpen) {
      await ctx.close();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
