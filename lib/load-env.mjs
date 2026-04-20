import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { ROOT } from './paths.mjs';

/**
 * Порядок (последние файлы перекрывают предыдущие): .env → .env.local → config/secrets.local.env
 */
export function loadEnv() {
  const tryLoad = (rel) => {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) dotenv.config({ path: p, override: true });
  };
  tryLoad('.env');
  tryLoad('.env.local');
  tryLoad(path.join('config', 'secrets.local.env'));

  const stripQuotes = (v) => {
    if (!v || !/^["']/.test(v)) return v;
    return v.replace(/^["'\s]+|["'\s]+$/g, '');
  };
  if (process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = stripQuotes(process.env.GEMINI_API_KEY);
  }
  const envKeys = [
    'OpenRouter_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL',
    'OPENROUTER_ALLOW_PAID',
    'OPENROUTER_HTTP_REFERER',
  ];
  for (const name of envKeys) {
    if (process.env[name]) process.env[name] = stripQuotes(process.env[name]);
  }
}
