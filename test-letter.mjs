import 'dotenv/config';
import { readFileSync } from 'fs';
import {
  getOpenRouterApiKey,
  extractJsonObject,
  resolveOpenRouterModelForRequest,
} from './lib/openrouter-score.mjs';
import { ROOT } from './lib/paths.mjs';
import { buildStyleContextBlock } from './lib/cover-letter-style-context.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const cvBundle = { text: readFileSync('./CV/cv_operations_manager.md', 'utf8') };
const record = {
  title: 'Project Manager (Middle+) к CEO (R&D / New Business)',
  company: 'GGSel',
  salaryRaw: 'от 200 000 до 270 000 ₽',
  url: 'https://hh.ru/vacancy/132396874',
  descriptionForLlm: `Привет! Мы - ggsel, маркетплейс цифровых товаров. Мы ищем Project Manager в прямое подчинение CEO для запуска новых направлений и продуктов. Роль делится на два блока: 1. Исследование и проверка гипотез (≈20%) - Анализ новых рынков и ниш, поиск экспертов, подготовка материалов для CEO. 2. Запуск и развитие проектов (≈80%) - Полный цикл запуска, разработка плана, координация с командами. Hard skills: Уверенный Excel / работа с данными, умение быстро разбираться в новых инструментах (n8n), навыки базовой финансовой оценки проектов (CAC, LTV, unit-экономика).`
};

const apiKey = getOpenRouterApiKey();
const model = resolveOpenRouterModelForRequest();

const atsRules = `
ОБЯЗАТЕЛЬНАЯ СТРУКТУРА ПИСЬМА (все блоки должны быть в каждом варианте):

1. Здравствуйте!
2. Меня заинтересовала работа в вашей компании.
3. Вакансия: [название вакансии]
4. [Input:] 1-2 предложения отзеркаливания: кого ищут и для каких задач. Формат: "Вы ищете [роль], который будет [задачи] и обеспечит [результат]".
5. [ATS-список] 3-5 пунктов по форме "* [требование из вакансии] - [мой опыт]". Точные термины из вакансии.
6. Обо мне: (общее описание)
7. Ключевые достижения: (конкретные результаты)
8. Компетенции: (навыки)
9. Навыки работы с ИИ / Ai: (инструменты)
10. Владею инструментами: (CRM, таблицы, проекты)
11. Опыт: (история работы)
12. Спасибо за уделенное время!
13. Мои контакты: (Telegram, WhatsApp, Email)

ПРАВИЛА ОТСТУПОВ:
- После "Здравствуйте!" ВСЕГДА пустая строка.
- После "Меня заинтересовала работа..." пустая строка.
- После названия вакансии пустая строка.
- После Input-абзаца пустая строка.
- После ATS-списка пустая строка.
- Между ВСЕМИ блоками пустые строки.
- Между "Спасибо за уделенное время!" и "Мои контакты:" пустая строка.

ВАЖНО:
- НЕ используй длинное тире "—", используй короткий дефис "-".
- Не используй заголовки типа "ATS", "Input" в финальном тексте.
- Используй точные термины из вакансии для ATS.`;

const userPrompt = `Напиши три разных варианта сопроводительного письма на русском для отклика на вакансию.
Каждый вариант - структурированное письмо с пустыми строками между блоками.
${atsRules}

ВАКАНСИЯ:
Заголовок: ${record.title}
Компания: ${record.company}
Зарплата: ${record.salaryRaw}
URL: ${record.url}

Описание:
${record.descriptionForLlm.slice(0, 8000)}

РЕЗЮМЕ КАНДИДАТА:
${cvBundle.text.slice(0, 16000)}

Верни СТРОГО один JSON без markdown:
{
  "variants": ["текст варианта 1", "текст варианта 2", "текст варианта 3"]
}`;

console.log('Sending request to OpenRouter...');

const res = await fetch(OPENROUTER_URL, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
    'X-Title': 'hh-ru-apply-cover-letter',
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: 'Ты пишешь сопроводительные письма. Всегда отвечай только JSON с ключом variants (массив из 3 строк). Никакого markdown.',
      },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.55,
    max_tokens: 2500,
  }),
});

const rawText = await res.text();
console.log('Response status:', res.status);

let data;
try {
  data = JSON.parse(rawText);
} catch {
  console.log('Raw response (first 2000 chars):', rawText.slice(0, 2000));
  throw new Error('Not JSON');
}

const text = data?.choices?.[0]?.message?.content;
console.log('Response content (first 1000 chars):', text?.slice(0, 1000));

const parsed = extractJsonObject(text);
console.log('Parsed variants count:', parsed?.variants?.length);

console.log('\n=== VARIANT 1 ===\n');
console.log(parsed.variants[0]);
console.log('\n=== VARIANT 2 ===\n');
console.log(parsed.variants[1]);
console.log('\n=== VARIANT 3 ===\n');
console.log(parsed.variants[2]);