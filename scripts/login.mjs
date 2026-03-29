/**
 * Первый вход: открывается Chromium с постоянным профилем в data/session/chromium-profile.
 * Войдите на hh.ru вручную, затем нажмите Enter в терминале — профиль сохранится для npm run apply.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SESSION_DIR = process.env.HH_SESSION_DIR
  ? path.resolve(process.cwd(), process.env.HH_SESSION_DIR)
  : path.join(ROOT, 'data', 'session');
const PERSISTENT_PROFILE = path.join(SESSION_DIR, 'chromium-profile');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

async function main() {
  ensureDir(SESSION_DIR);
  const ctx = await chromium.launchPersistentContext(PERSISTENT_PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: 'ru-RU',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://hh.ru/', { waitUntil: 'domcontentloaded' });

  await waitEnter(
    'Войдите в аккаунт hh.ru в открытом окне. Когда закончите, нажмите Enter здесь: '
  );

  await ctx.close();
  console.log('Профиль сохранён:', PERSISTENT_PROFILE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
