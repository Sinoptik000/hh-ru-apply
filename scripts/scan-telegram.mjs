/**
 * Поиск вакансий по ключевым словам в сохранённой сессии, краткий разбор карточек,
 * отправка в Telegram для ручного решения об отклике.
 *
 * Важно: один процесс = один Chromium с профилем. Не запускайте параллельно с открытым `npm run login`.
 *
 * Использование:
 *   npm run scan-tg -- golang разработчик   # слова из argv
 *   HH_KEYWORDS="go,микросервисы" npm run scan-tg
 *   npm run scan-tg -- --dry-run golang     # только консоль, без Telegram
 *
 * Переменные .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, HH_SCAN_LIMIT, HH_PAUSE_MS, HH_AREA, HH_HEADLESS
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { addVacancyRecord } from '../lib/store.mjs';
import { runHardFilters } from '../lib/filters.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SESSION_DIR = process.env.HH_SESSION_DIR
  ? path.resolve(process.cwd(), process.env.HH_SESSION_DIR)
  : path.join(ROOT, 'data', 'session');
const PERSISTENT_PROFILE = path.join(SESSION_DIR, 'chromium-profile');

const headless = process.env.HH_HEADLESS === '1';
const dryRun = process.argv.includes('--dry-run');
const webMode = process.argv.includes('--web');
const limit = Math.min(50, Math.max(1, Number(process.env.HH_SCAN_LIMIT || 10) || 10));
const pauseMs = Math.max(500, Number(process.env.HH_PAUSE_MS || 2500) || 2500);

// Загрузка preferences
const prefsPath = process.env.HH_PREFS_FILE || path.join(ROOT, 'config', 'preferences.json');
let prefs = {};
try {
  prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
} catch {}

function parseSalary(salaryText) {
  if (!salaryText) return null;
  const cleaned = salaryText.replace(/\s/g, '').replace(/–/g, '-');
  const match = cleaned.match(/(\d[\d\s]*)/);
  if (!match) return null;
  return Number(match[1].replace(/\s/g, ''));
}

function detectWorkFormat(desc, fullText) {
  const text = (desc + ' ' + fullText).toLowerCase();
  const { officeOnlyPatterns = [], remotePositivePatterns = [], hybridPatterns = [] } = prefs;

  for (const p of officeOnlyPatterns) {
    if (text.includes(p.toLowerCase())) return 'office';
  }
  if (text.includes('офис') && !text.includes('не ') && !text.includes('без ')) {
    if (text.includes('офис обязателен') || text.includes('только офис') || text.includes('в офисе ежедневно')) {
      return 'office';
    }
  }
  for (const p of hybridPatterns) {
    if (text.includes(p.toLowerCase())) return 'hybrid';
  }
  for (const p of remotePositivePatterns) {
    if (text.includes(p.toLowerCase())) return 'remote';
  }
  return 'unknown';
}

function passesFormatFilter(format) {
  const { requireRemote = false, allowHybrid = false, allowUnknownFormat = false } = prefs;
  if (format === 'office') return false;
  if (format === 'remote') return true;
  if (format === 'hybrid') return allowHybrid;
  if (format === 'unknown') return allowUnknownFormat || (!requireRemote && !allowHybrid);
  return true;
}

function passesSalaryFilter(salaryText) {
  const filter = runHardFilters({ title: '', company: '', salaryRaw: salaryText || '', employment: '', address: '', description: '' }, prefs);
  return filter.pass || filter.stage !== 'salary';
}

function checkVacancy(card) {
  const filter = runHardFilters({
    title: card.title || '',
    company: card.company || '',
    salaryRaw: card.salary || '',
    employment: '',
    address: '',
    description: card.desc || '',
  }, prefs);
  return {
    formatOk: filter.pass || filter.stage !== 'remote',
    salaryOk: filter.pass || filter.stage !== 'salary',
    remoteReason: filter.remoteReason || filter.reason || '',
  };
}

function looksLikeLoginUrl(url) {
  const u = url.toLowerCase();
  return u.includes('/account/login') || u.includes('oauth.hh.ru') || u.includes('/logon');
}

function keywordsFromArgs() {
  const argv = process.argv.slice(2).filter((a) => a !== '--dry-run' && !a.startsWith('--'));
  if (argv.length) return argv.join(' ').trim();
  const raw = process.env.HH_KEYWORDS || '';
  const parts = raw
    .split(/[|,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.join(' ').trim();
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

async function scrapeVacancyCard(page, vacancyUrl) {
  await page.goto(vacancyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
    const title = t('h1[data-qa="vacancy-title"]') || t('h1');
    const company =
      t('[data-qa="vacancy-company-name"]') ||
      t('a[data-qa="vacancy-company-name"]') ||
      t('[data-qa="vacancy-serp__vacancy-employer"]');
    const salary = t('[data-qa="vacancy-salary"]');
let desc =
 t('[data-qa="vacancy-description"]') ||
 t('[data-qa="vacancy-view-vacancyDescription"]') ||
 t('.vacancy-description') ||
 t('.vacancy-section') ||
 t('[itemprop="description"]') ||
 t('.bloko-text') ||
 document.querySelector('[class*="vacancy-description"]')?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
    if (desc.length > 3500) desc = `${desc.slice(0, 3500)}…`;
    return { title, company, salary, desc };
  });
}

async function sendTelegram(botToken, chatId, text) {
  const cap = 3900;
  for (let i = 0; i < text.length; i += cap) {
    const chunk = text.slice(i, i + cap);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram ${res.status}: ${body}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const query = keywordsFromArgs();
  if (!query) {
    console.error(
      'Укажите ключевые слова: npm run scan-tg -- ваш запрос\nили HH_KEYWORDS в .env'
    );
    process.exit(1);
  }

  if (!dryRun && !webMode && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    console.error(
      'Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env, либо запуск с флагом --dry-run или --web'
    );
    process.exit(1);
  }

  if (!fs.existsSync(PERSISTENT_PROFILE)) {
    console.error('Профиль не найден. Сначала: npm run login\n', PERSISTENT_PROFILE);
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(PERSISTENT_PROFILE, {
    headless,
    viewport: { width: 1280, height: 800 },
    locale: 'ru-RU',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://hh.ru/applicant', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(1500);
    if (looksLikeLoginUrl(page.url())) {
      console.error('Сессия не активна. Выполните: npm run login');
      process.exit(1);
    }

    const searchUrl = buildSearchUrl(query);
    console.log('Поиск:', searchUrl);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);

    let urls = await collectVacancyUrls(page);
    urls = urls.slice(0, limit);
    if (!urls.length) {
      console.log('Вакансии на первой странице не найдены (селекторы/выдача могли измениться).');
      return;
    }

    console.log(`Найдено ссылок (до лимита ${limit}):`, urls.length);

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    let sentCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`[${i + 1}/${urls.length}]`, url);
      let card;
      try {
        card = await scrapeVacancyCard(page, url);
      } catch (e) {
        console.error('  ошибка страницы:', e.message);
        continue;
      }

      // Проверка по фильтрам
      const check = checkVacancy(card);
      if (!check.formatOk || !check.salaryOk) {
        const reasons = [];
        if (!check.formatOk) reasons.push(check.remoteReason || 'формат не подходит');
        if (!check.salaryOk) reasons.push('зарплата ниже минимума');
        console.log(`  пропуск: ${reasons.join(', ')}`);
        skippedCount++;
        continue;
      }

      const formatBadge = check.remoteReason.includes('удалён') ? '🏠' : check.remoteReason.includes('Гибрид') ? '🔄' : '❓';

      const block = [
        `${formatBadge} ${card.title || '(без названия)'}`,
        card.company ? `🏢 ${card.company}` : null,
        card.salary ? `💰 ${card.salary}` : null,
        '',
        card.desc || '(описание не распознано — проверьте вёрстку hh.ru)',
        '',
        url,
      ]
        .filter(Boolean)
        .join('\n');

      if (dryRun) {
        console.log('---');
        console.log(block);
        console.log('---');
      } else if (webMode) {
        // Сохраняем в очередь дашборда
        const vacancyIdMatch = url.match(/\/vacancy\/(\d+)/);
        const vacancyId = vacancyIdMatch ? vacancyIdMatch[1] : url;
        const saved = addVacancyRecord({
          id: `scan_${Date.now()}_${vacancyId}`,
          vacancyId,
          url,
          title: card.title || '',
          company: card.company || '',
          salaryRaw: card.salary || '',
          descriptionPreview: card.desc?.slice(0, 600) || '',
          descriptionForLlm: card.desc || '',
          status: 'pending',
          workFormat: check.format,
          scannedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        console.log(`  сохранено: ${saved ? 'да' : 'нет (дубликат)'}`);
      } else {
        await sendTelegram(botToken, chatId, block);
      }
      sentCount++;

      await new Promise((r) => setTimeout(r, pauseMs));
    }

    if (!dryRun && !webMode) {
      const summary = `Готово: отправлено ${sentCount}, пропущено ${skippedCount} вакансий по запросу «${query}».`;
      await sendTelegram(botToken, chatId, summary);
    }
    console.log(`Готово: сохранено/отправлено ${sentCount}, пропущено ${skippedCount}.`);
    if (webMode) {
      console.log(`Вакансии добавлены в дашборд: http://127.0.0.1:${process.env.DASHBOARD_PORT || 3849}`);
    }
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
