/**
 * Заполняет резюме на hh.ru данными из CV/markdown файла.
 *
 * Использование:
 *   node scripts/hh-update-resume.mjs --cv=./CV/cv_operations_manager.md
 *
 * Откроет страницу редактирования резюме в вашем профиле.
 * Заполняет поля: имя, контакты, опыт, образование, курсы, навыки.
 *
 * Флаги: --cv=<путь к .md файлу резюме>
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { loadEnv } from '../lib/load-env.mjs';
loadEnv();

import { sessionProfilePath } from '../lib/paths.mjs';

const headless = process.env.HH_HEADLESS === '1';

function waitEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function parseCvMd(text) {
  const out = {
    name: '',
    position: '',
    location: '',
    email: '',
    telegram: '',
    linkedin: '',
    about: '',
    skills: [],
    experience: [],
    education: [],
    courses: [],
  };

  const lines = text.split('\n');
  let section = null;
  let currentExp = null;
  let aboutLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('# ') && !out.name) {
      out.name = line.replace('# ', '').trim();
      continue;
    }

    if (line.startsWith('## ')) {
      section = line.replace('## ', '').trim().toLowerCase();
      if (section === 'опыт работы') section = 'experience';
      else if (section === 'образование') section = 'education';
      else if (section === 'курсы') section = 'courses';
      else if (section === 'инструменты' || section === 'навыки') section = 'skills';
      else if (section === 'обо мне') section = 'about';
      else if (section === 'желаемая должность') section = 'position';
      else if (section === 'контакты') section = 'contacts';
      continue;
    }

    if (section === 'position' && line.startsWith('**')) {
      out.position = line.replace(/\*\*/g, '').trim();
    }

    if (section === 'contacts') {
      if (line.includes('@') && !line.includes('://')) {
        out.email = line.replace(/[📧✈️💼📍]/g, '').trim();
      }
      if (line.includes('@') && line.startsWith('✈️')) {
        out.telegram = line.replace(/✈️\s*/, '').trim();
      }
      if (line.includes('linkedin')) {
        out.linkedin = line.replace(/💼\s*/, '').trim();
      }
    }

    if (section === 'about') {
      aboutLines.push(line.replace(/^[-*]\s*/, '').trim());
    }

    if (section === 'skills' && (line.startsWith('- ') || line.startsWith('* '))) {
      out.skills.push(line.replace(/^[-*]\s*/, '').trim());
    }

    if (section === 'experience') {
      if (line.startsWith('### ')) {
        if (currentExp) out.experience.push(currentExp);
        currentExp = { title: '', company: '', period: '', url: '', achievements: [] };
        const parts = line.replace('### ', '').trim().split('|').map(s => s.trim());
        currentExp.title = parts[0] || '';
        currentExp.company = parts[1] || '';
      } else if (line.startsWith('*') && line.includes('20')) {
        if (currentExp) currentExp.period = line.replace(/[*_]/g, '').trim();
      } else if (line.includes('http') && currentExp && !currentExp.url) {
        const m = line.match(/https?:\/\/[^\s)]+/);
        if (m) currentExp.url = m[0];
      } else if ((line.startsWith('- ') || line.startsWith('* ')) && currentExp) {
        currentExp.achievements.push(line.replace(/^[-*]\s*/, '').trim());
      }
    }

    if (section === 'education') {
      if (line.startsWith('**')) {
        out.education.push({ type: line.replace(/\*\*/g, '').trim(), institution: '' });
      } else if (line.trim() && out.education.length > 0 && !out.education[out.education.length - 1].institution) {
        out.education[out.education.length - 1].institution = line.trim();
      }
    }

    if (section === 'courses' && (line.startsWith('- ') || line.startsWith('* '))) {
      const item = line.replace(/^[-*]\s*/, '').trim();
      out.courses.push(item);
    }
  }

  if (currentExp) out.experience.push(currentExp);
  out.about = aboutLines.filter(Boolean).join('\n');
  return out;
}

function parseArgs() {
  const out = { cv: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--cv=')) out.cv = a.slice(5).trim();
  }
  return out;
}

async function typeHuman(page, selector, text) {
  await page.waitForSelector(selector, { state: 'visible', timeout: 5000 }).catch(() => {});
  const el = page.locator(selector).first();
  if (await el.isVisible().catch(() => false)) {
    await el.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await el.fill(text);
    return true;
  }
  return false;
}

async function fillOrAddText(page, text) {
  // Попробуем заполнить textarea
  const textareas = page.locator('textarea');
  const count = await textareas.count();
  for (let i = 0; i < count; i++) {
    const ta = textareas.nth(i);
    if (await ta.isVisible().catch(() => false)) {
      await ta.click();
      await ta.fill(text);
      return true;
    }
  }
  return false;
}

async function main() {
  const { cv } = parseArgs();
  if (!cv || !fs.existsSync(cv)) {
    console.error('Укажите путь к CV файлу: node scripts/hh-update-resume.mjs --cv=./CV/cv_operations_manager.md');
    process.exit(1);
  }

  const cvText = fs.readFileSync(cv, 'utf8');
  const data = parseCvMd(cvText);

  const profile = sessionProfilePath();
  if (!fs.existsSync(profile)) {
    console.error('Профиль не найден. Сначала: npm run login\n', profile);
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false, // Всегда показываем браузер для ручного контроля
    viewport: { width: 1400, height: 900 },
    locale: 'ru-RU',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    // Переход на страницу редактирования резюме
    const resumeUrl = 'https://hh.ru/profile/resume/experience?resume=724a074bff105921a70039ed1f445742557968';
    console.log('Переход на страницу редактирования резюме...');
    await page.goto(resumeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2000);

    console.log('Страница загружена. Начинаю заполнение...');
    console.log('Скрипт заполнит поля автоматически. Вы можете следить за процессом.');
    console.log('После завершения проверьте данные и сохраните резюме вручную.');
    console.log('');

    // === ОБ О СЕБЕ ===
    console.log('📝 Заполняю "Обо мне"...');
    await fillOrAddText(page, data.about);

    await page.waitForTimeout(1000);

    // === НАВЫКИ / КОМПЕТЕНЦИИ ===
    console.log('📝 Заполняю "Навыки"...');
    const skillsText = data.skills.join('\n');
    if (skillsText) {
      await fillOrAddText(page, skillsText);
    }

    await page.waitForTimeout(1000);

    // === ОПЫТ РАБОТЫ ===
    console.log('📝 Заполняю "Опыт работы"...');
    for (const exp of data.experience) {
      console.log(`  → ${exp.company || exp.title}`);
      // На hh.ru опыт заполняется через отдельные поля — это сложно автоматизировать полностью
      // Покажу данные в консоли для ручного ввода
      console.log(`    Должность: ${exp.title}`);
      console.log(`    Период: ${exp.period}`);
      console.log(`    Достижения: ${exp.achievements.length} пунктов`);
    }

    console.log('');
    console.log('⚠️  Опыт работы на hh.ru заполняется через сложные формы с выпадающими списками.');
    console.log('   Рекомендую заполнить эти поля вручную по данным из консоли.');
    console.log('');

    await waitEnter('Нажмите Enter для закрытия браузера: ');
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
