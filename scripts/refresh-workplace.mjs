/**
 * Обновляет employment и workplaceType для ВСЕХ существующих вакансий.
 * Заходит на каждую страницу hh.ru, парсит поле employment.
 *
 * Usage: node scripts/refresh-workplace.mjs
 */

import { chromium } from 'playwright';
import { loadQueue, saveQueue } from '../lib/store.mjs';
import { sessionProfilePath } from '../lib/paths.mjs';
import { determineWorkplaceType } from '../lib/filters.mjs';
import fs from 'fs';

const headless = process.env.HH_HEADLESS === '1';

function sleepMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const queue = loadQueue();
  console.log(`Всего вакансий: ${queue.length}`);

  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    console.error('Нет профиля Chromium. Сначала: npm run login');
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(profile, { headless, viewport: { width: 1280, height: 800 } });
  const page = ctx.pages()[0] || await ctx.newPage();

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (!item.url) {
      console.log(`[${i + 1}/${queue.length}] Пропуск (нет URL): ${item.title || item.id}`);
      continue;
    }

    try {
      console.log(`[${i + 1}/${queue.length}] ${item.title}`);
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleepMs(3000);

      // Проверяем не редиректнуло ли на логин
      const currentUrl = page.url();
      if (currentUrl.includes('/logon') || currentUrl.includes('/account/login')) {
        console.error(`  → Авторизация слетела! Останов.`);
        break;
      }

      const employment = await page.evaluate(() => {
        const t = s => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
        return t('[data-qa="work-formats-text"]') || t('[data-qa="vacancy-employment-mode"]') || t('[data-qa="vacancy-view-employment-mode"]') || '';
      });

      item.employment = employment || '';
      item.workplaceType = determineWorkplaceType(employment || '', '');

      console.log(`  → employment: "${employment}" → ${item.workplaceType.join(', ')}`);
      updated++;

      // Сохраняем каждые 5 записей на случай обрыва
      if (updated % 5 === 0) {
        saveQueue(queue);
      }
    } catch (e) {
      console.error(`  → ОШИБКА: ${e.message}`);
      errors++;
    }

    // Пауза между запросами
    if (i < queue.length - 1) {
      await sleepMs(2000 + Math.random() * 1000);
    }
  }

  saveQueue(queue);
  console.log(`\nГотово. Обновлено: ${updated}, Ошибки: ${errors}`);

  // Статистика
  const counts = {};
  for (const item of queue) {
    const types = item.workplaceType || ['не указано'];
    for (const t of (Array.isArray(types) ? types : [types])) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  console.log('Итого (по типам):', counts);

  await ctx.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
