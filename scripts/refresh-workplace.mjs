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

      const result = await page.evaluate(() => {
        const t = s => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
        const employment = t('[data-qa="work-formats-text"]') || t('[data-qa="vacancy-employment-mode"]') || t('[data-qa="vacancy-view-employment-mode"]') || '';

        // Parse languages
        let languages = [];
        const langMatch = document.body.textContent.match(/(Английский|English|Немецкий|Deutsch|Французский|Français|Китайский|Chinese|Испанский|Spanish)\s*—\s*(\S+(?:\s*—\s*\S+)?)/i);
        if (langMatch) {
          const langName = langMatch[1].trim();
          const levelRaw = langMatch[2].trim();
          const levelMatch = levelRaw.match(/(A[12]|B[12]|C[12]|Advanced|Proficiency|Native|Носитель|Средний|Выше среднего|Базовый|Продвинутый|Свободный|Не владею)/i);
          if (levelMatch) {
            languages.push({ name: langName, level: levelMatch[1].trim() });
          } else {
            languages.push({ name: langName, level: levelRaw.split(/[—\s]+/).find(s => /[A-Z0-9]/i.test(s)) || levelRaw });
          }
        }

        const englishLevel = languages.find(l => /английск|english/i.test(l.name || ''))?.level || null;
        return { employment, languages, englishLevel };
      });

      item.employment = result.employment || '';
      item.workplaceType = determineWorkplaceType(result.employment || '', '');
      item.languages = result.languages || [];
      item.englishLevel = result.englishLevel || null;

      const langInfo = result.englishLevel ? ` | EN: ${result.englishLevel}` : '';
      console.log(`  → employment: "${result.employment}" → ${item.workplaceType.join(', ')}${langInfo}`);
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
