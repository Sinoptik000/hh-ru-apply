import fs from 'fs';
import { chromium } from 'playwright';
import { sessionProfilePath } from './paths.mjs';
import { parseVacancyPageWithRetry, waitForVacancyContent } from './vacancy-parse.mjs';

async function parseInPage(page, vacancyUrl) {
  // Используем networkidle для полной загрузки всех API-запросов
  await page.goto(vacancyUrl, { waitUntil: 'networkidle', timeout: 90_000 });
  // Ждём появления контента (React SPA) с прокруткой
  await waitForVacancyContent(page, 30_000);
  // Парсим с повторной попыткой если описание короткое
  return parseVacancyPageWithRetry(page, 3);
}

function looksParsedOk(parsed) {
  const d = String(parsed?.description || '').trim();
  return d.length >= 80;
}

/**
 * Загружает вакансию через Playwright ТОЛЬКО через persistent-профиль.
 * Без сессии авторизации hh.ru скрывает часть данных.
 *
 * Требует: npm run login (для создания профиля сессии)
 */
export async function fetchVacancyTextFromHh(vacancyUrl) {
  const headless = process.env.HH_HEADLESS !== '0';

  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    throw new Error(
      'Профиль сессии не найден. Выполните: npm run login чтобы создать сессию авторизации на hh.ru'
    );
  }

  const ctx = await chromium.launchPersistentContext(profile, {
    headless,
    viewport: { width: 1280, height: 800 },
    locale: 'ru-RU',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await ctx.newPage();
    const parsed = await parseInPage(page, vacancyUrl);

    if (!looksParsedOk(parsed)) {
      throw new Error(
        'Описание вакансии пустое. Возможно, сессия устарела — выполните: npm run login'
      );
    }

    return parsed;
  } finally {
    await ctx.close().catch(() => {});
  }
}
