/**
 * Вакансия → «Откликнуться» → мастер модалки → при наличии текста письмо в форму отклика → отправить → чат → письмо в чате.
 *
 * Автоматическая отправка отклика и сообщения может противоречить правилам hh.ru — используйте осознанно.
 *
 *   node scripts/hh-apply-chat-letter.mjs --id=<uuid>
 *   --stay-open   — ждать Enter перед закрытием браузера
 *   --dry-run     — открыть чат, но не вставлять письмо
 *   --no-submit   — только открыть форму отклика, не нажимать «Отправить»
 *
 * HH_HEADLESS=1 — headless (для отладки обычно без headless).
 * HH_FAST=1 — быстрый режим (без «человеческих» пауз и посимвольного ввода).
 * HH_PLAYWRIGHT_CHANNEL=chrome — системный Chrome вместо bundled Chromium (опционально).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { chromium } from 'playwright';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { sessionProfilePath, DATA_DIR } from '../lib/paths.mjs';
import { getVacancyRecord } from '../lib/store.mjs';
import { clickVacancyResponseButton, expandCoverLetterSectionIfPresent, fillCoverLetterFieldIfPresent } from '../lib/hh-response-selectors.mjs';
import { vacancyIdFromUrl } from '../lib/vacancy-parse.mjs';
import { betweenMajorSteps } from '../lib/hh-human-delay.mjs';
import {
  prepareVacancyResponseModal,
  submitVacancyResponseIfPresent,
  openEmployerChatAfterResponse,
  sendLetterInChat,
} from '../lib/hh-chat-selectors.mjs';

const headless = process.env.HH_HEADLESS === '1';
const stayOpen = process.argv.includes('--stay-open');
const dryRun = process.argv.includes('--dry-run');
const noSubmit = process.argv.includes('--no-submit');

function parseArgs() {
  let id = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--id=')) id = a.slice(5).trim();
  }
  return { id };
}

function waitEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function looksLikeLoginUrl(url) {
  const u = url.toLowerCase();
  return u.includes('/account/login') || u.includes('oauth.hh.ru') || u.includes('/logon');
}

async function saveErrorScreenshot(page, err) {
  try {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const shot = path.join(DATA_DIR, `hh-apply-chat-error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.error('[hh-apply-chat] Скриншот ошибки:', shot, err?.message || err);
  } catch {
    /* ignore */
  }
}

async function main() {
  const { id } = parseArgs();
  if (!id) {
    console.error('Укажите --id=<uuid записи из data/vacancies-queue.json>');
    process.exit(1);
  }

  const rec = getVacancyRecord(id);
  if (!rec) {
    console.error('Запись не найдена:', id);
    process.exit(1);
  }
  const letter = String(rec.coverLetter?.approvedText || '').trim();
  if (!letter && !dryRun) {
    console.error(
      'Нет утверждённого письма (coverLetter.approvedText). Утвердите в дашборде («Черновик письма» → Утвердить) или используйте --dry-run.'
    );
    process.exit(1);
  }
  if (!rec.url) {
    console.error('У записи нет url');
    process.exit(1);
  }

  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    console.error('Профиль не найден. Сначала: npm run login\n', profile);
    process.exit(1);
  }

  const vacancyId = rec.vacancyId || vacancyIdFromUrl(rec.url) || '';

  let tmpDir = null;
  let tmpFile = null;
  if (letter && !dryRun) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-letter-'));
    tmpFile = path.join(tmpDir, 'cover-letter.txt');
    fs.writeFileSync(tmpFile, letter, 'utf8');
  }

  const launchOpts = {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'ru-RU',
  };
  const ch = String(process.env.HH_PLAYWRIGHT_CHANNEL || '').trim();
  if (ch) launchOpts.channel = ch;
  const ctx = await chromium.launchPersistentContext(profile, launchOpts);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    const humanTyping = process.env.HH_FAST !== '1';
    const humanClicks = process.env.HH_FAST !== '1';

    const step = (name) => console.log(`[hh-apply-chat] step=${name}`);

    step(`start recordId=${id} url=${rec.url}`);
    console.log('[hh-apply-chat] Открываю вакансию:', rec.url);
    await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await betweenMajorSteps(page);
    step('open_vacancy');

    if (looksLikeLoginUrl(page.url())) {
      throw new Error('Редирект на логин. Выполните: npm run login');
    }

    const btn = await clickVacancyResponseButton(page, 12_000, { humanClicks });
    console.log('[hh-apply-chat] Клик:', btn);
    step('click_response');

    if (noSubmit) {
      console.log('[hh-apply-chat] --no-submit: форма открыта, отправку и чат не трогаем.');
      if (stayOpen) await waitEnter('Enter — закрыть браузер: ');
      return;
    }

    await prepareVacancyResponseModal(page);
    await betweenMajorSteps(page);
    step('modal_prepare_1');

    if (letter) {
      await expandCoverLetterSectionIfPresent(page);
      const filled = await fillCoverLetterFieldIfPresent(page, letter, 20_000, { humanTyping });
      if (filled) console.log('[hh-apply-chat] Письмо в форме отклика:', filled);
      else console.log('[hh-apply-chat] Поле письма в форме не найдено (возможно необязательно).');
      step('fill_letter');
      await prepareVacancyResponseModal(page);
      await betweenMajorSteps(page);
      step('modal_prepare_2');
    }

    const submitted = await submitVacancyResponseIfPresent(page);
    if (!submitted) {
      throw new Error(
        'Не найдена кнопка отправки отклика. Обновите submitVacancyResponseIfPresent в lib/hh-chat-selectors.mjs (Playwright Codegen).'
      );
    }
    console.log('[hh-apply-chat] Отправка отклика:', submitted);
    step('submit_response');
    await betweenMajorSteps(page);

    await openEmployerChatAfterResponse(page, { vacancyId });
    step('open_chat');
    await betweenMajorSteps(page);

    if (dryRun) {
      console.log('[hh-apply-chat] --dry-run: письмо в чат не вставлялось.');
      step('done_dry_run');
      if (stayOpen) await waitEnter('Enter — закрыть браузер: ');
      return;
    }

    await sendLetterInChat(page, { text: letter, tempFilePath: tmpFile, humanTyping });
    console.log('[hh-apply-chat] Готово: письмо отправлено в чат (проверьте в браузере).');
    console.log('[hh-apply-chat] SUCCESS: сценарий завершён без исключений (exit 0).');
    step('send_chat_done');

    if (stayOpen) {
      await waitEnter('Enter — закрыть браузер: ');
    }
  } catch (e) {
    await saveErrorScreenshot(page, e);
    throw e;
  } finally {
    await ctx.close();
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
