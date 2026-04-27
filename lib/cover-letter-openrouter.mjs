import fs from 'fs';
import path from 'path';
import {
  getOpenRouterApiKey,
  extractJsonObject,
  resolveOpenRouterModelForRequest,
} from './openrouter-score.mjs';
import { ROOT } from './paths.mjs';
import { buildStyleContextBlock } from './cover-letter-style-context.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const COVER_CANDIDATES = [
  path.join(ROOT, 'config', 'cover-letter.txt'),
  path.join(ROOT, 'config', 'cover-letter.example.txt'),
];

function loadCoverLetterTemplateRaw() {
  for (const fp of COVER_CANDIDATES) {
    if (fs.existsSync(fp)) {
      const t = fs.readFileSync(fp, 'utf8').trim();
      if (t) return t;
    }
  }
  return '';
}

function loadCoverLetterTemplateHint() {
  const t = loadCoverLetterTemplateRaw();
  return t ? t.slice(0, 15000) : '';
}

function normalizeTitleLine(title) {
  const t = String(title || '').trim().replace(/\s+/g, ' ');
  const clean = t.replace(/[.!?]+$/g, '');
  return clean || 'название вакансии';
}

function extractMirrorLine(letterText) {
  const text = String(letterText || '').replace(/\r/g, '');
  const lines = text.split('\n').map((x) => x.trim());
  const direct = lines.find((line) => /^Вы ищете\b/i.test(line));
  return direct || '';
}

function extractAtsBullets(letterText) {
  const text = String(letterText || '').replace(/\r/g, '');
  const beforeAbout = text.split(/\n\s*Обо мне:\s*/i)[0] || text;
  const bullets = beforeAbout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\*/.test(line))
    .map((line) => line.replace(/^\*\s*/, '* ').replace(/\s+/g, ' '))
    .filter((line) => line.includes(' - '));
  return bullets.slice(0, 5);
}

function inferFallbackAtsBullets(desc = '') {
  const d = String(desc || '').toLowerCase();
  const out = [];
  const push = (line) => {
    if (line && !out.includes(line)) out.push(line);
  };

  if (d.includes('excel')) {
    push('* Уверенный Excel / работа с данными - строю отчеты и аналитические сводки в Excel и Google Sheets.');
  }
  if (d.includes('n8n')) {
    push('* Умение быстро разбираться в новых инструментах (например, n8n) - автоматизирую процессы через n8n и no-code.');
  }
  if (d.includes('cac') || d.includes('ltv') || d.includes('unit-эконом')) {
    push('* Навыки базовой финансовой оценки проектов (CAC, LTV, unit-экономика) - использую финансовые метрики при запуске и развитии проектов.');
  }
  if (d.includes('самостоятель') || d.includes('проактив')) {
    push('* Высокая самостоятельность и проактивность - самостоятельно веду проекты от идеи до результата.');
  }
  if (d.includes('запуск') || d.includes('полный цикл')) {
    push('* Полный цикл запуска: от идеи до реализации - запускал и масштабировал бизнес-направления с нуля.');
  }
  if (d.includes('коммуникац')) {
    push('* Сильные коммуникационные навыки - координировал работу кросс-функциональных команд и внешних партнеров.');
  }

  while (out.length < 3) {
    push('* Ориентация на результат, а не на процесс - довожу задачи до измеримого результата по срокам и метрикам.');
  }
  return out.slice(0, 5);
}

function buildLetterFromTemplate({ template, title, mirrorLine, atsBullets }) {
  const lines = String(template || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      if (line.includes('[название вакансии из заголовка]')) {
        return line.replace('[название вакансии из заголовка]', normalizeTitleLine(title));
      }
      return line;
    });

  const safeMirror =
    String(mirrorLine || '').trim() ||
    `Вы ищете ${normalizeTitleLine(title)}, который будет решать ключевые задачи вакансии и обеспечит ожидаемый результат.`;

  const safeAts = Array.isArray(atsBullets) && atsBullets.length ? atsBullets : [];

  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith('[Input:')) {
      out.push(safeMirror);
      continue;
    }
    if (line.trim().startsWith('[ATS-список:')) {
      out.push(...safeAts);
      continue;
    }
    out.push(line);
  }

  return out.join('\n').replace(/—/g, '-').replace(/–/g, '-').trim();
}

function applyStructuralTemplate(rawVariant, record, templateRaw) {
  const mirrorLine = extractMirrorLine(rawVariant);
  const atsBullets = extractAtsBullets(rawVariant);
  const completeAts =
    atsBullets.length >= 3 ? atsBullets : [...atsBullets, ...inferFallbackAtsBullets(record?.descriptionForLlm)];

  return buildLetterFromTemplate({
    template: templateRaw,
    title: record?.title || '',
    mirrorLine,
    atsBullets: completeAts.slice(0, 5),
  });
}

export function normalizeVariants(raw) {
  const arr = Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
  while (arr.length < 3) {
    arr.push(arr[arr.length - 1] || 'Здравствуйте! Готов обсудить сотрудничество.');
  }
  return arr.slice(0, 3);
}

/**
 * @param {object} record — запись из очереди (vacancies-queue)
 * @param {{ text: string }} cvBundle
 */
export async function generateCoverLetterVariants(record, cvBundle) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error(
      'Нет OpenRouter_API_KEY или OPENROUTER_API_KEY (см. config/secrets.example.env)'
    );
  }

  const desc =
    (record.descriptionForLlm && String(record.descriptionForLlm)) ||
    (record.descriptionPreview && String(record.descriptionPreview)) ||
    '';
  const summary = String(record.geminiSummary || '').trim();
  const risks = String(record.geminiRisks || '').trim();
  const tags = Array.isArray(record.geminiTags) ? record.geminiTags.join(', ') : '';

  const templateRaw = loadCoverLetterTemplateRaw();
  const templateHint = loadCoverLetterTemplateHint();
  const templateBlock = templateHint
    ? `\nПример структуры/тона (не копируй дословно, адаптируй):\n${templateHint}\n`
    : '';

  const styleBlockRaw = buildStyleContextBlock({
    maxChars: Number(process.env.COVER_LETTER_STYLE_MAX_CHARS) || 5000,
    maxItemsFromQueue: Number(process.env.COVER_LETTER_STYLE_QUEUE_ITEMS) || 4,
  });
  const styleBlock = styleBlockRaw
    ? `\nНиже — эталоны того, КАК автор уже писал сопроводительные (имитируй ритм, длину фраз, тёплость и прямоту; не переноси факты и формулировки из эталонов — пиши заново под эту вакансию).\n\n${styleBlockRaw}\n`
    : '';

  const model = resolveOpenRouterModelForRequest();

  const antiAiRules = `
Жёстко избегай признаков «нейросетевого» текста:
- не начинай с «Уважаемые рекрутеры/меня зовут/я пишу вам, чтобы…» шаблонно;
- не используй цепочки прилагательных и пустые усилители («глубокие знания», «уникальный опыт», «идеально подхожу»);
- не перечисляй качества списком без привязки к фактам из резюме;
- допускай разговорные короткие фразы, одно уместное «я» — как у живого человека;
- конкретика из вакансии и CV, не общие слова про «динамичную компанию».`;

  const atsRules = `
ОБЯЗАТЕЛЬНАЯ СТРУКТУРА ПИСЬМА (все блоки должны быть в каждом варианте):

1. Здравствуйте!
2. Меня заинтересовала работа в вашей компании.
3. Интересна вакансия: [название вакансии]
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
- После «Здравствуйте!» ВСЕГДА пустая строка.
- После «Меня заинтересовала работа...» пустая строка.
- После названия вакансии пустая строка.
- После Input-абзаца пустая строка.
- После ATS-списка пустая строка.
- Между ВСЕМИ блоками (Обо мне, Достижения, Компетенции и т.д.) пустые строки.
- Между «Спасибо за уделенное время!» и «Мои контакты:» пустая строка.

ВАЖНО:
- НЕ используй длинное тире «—», используй короткий дефис «-».
- Не используй заголовки типа «ATS», «Input» в финальном тексте - это внутренние метки.
- Используй точные термины из вакансии для ATS.`;

  const userPrompt = `Напиши три разных варианта сопроводительного письма на русском для отклика на вакансию.
Каждый вариант - структурированное письмо с пустыми строками между блоками.
НЕ используй длинное тире «—», НИКОГДА. Используй короткий дефис «-».
Учитывай резюме кандидата и текст вакансии; подчеркни релевантный опыт фактами, не лозунгами.
${antiAiRules}
${atsRules}
${styleBlock}
${templateBlock}
ВАКАНСИЯ:
Заголовок: ${record.title || ''}
Компания: ${record.company || ''}
Зарплата: ${record.salaryRaw || ''}
URL: ${record.url || ''}

Описание:
${desc.slice(0, 8000)}

Краткий разбор (модель-оценка): ${summary}
Риски: ${risks}
Теги: ${tags}

РЕЗЮМЕ КАНДИДАТА:
${cvBundle.text.slice(0, 16_000)}

Верни СТРОГО один JSON без markdown и без текста до/после:
{
  "variants": ["текст варианта 1", "текст варианта 2", "текст варианта 3"]
}`;

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
          content:
            'Ты помогаешь одному соискателю писать сопроводительные письма на русском: звучат естественно, без канцелярита и клише нейросетей. Если даны эталоны - копируй только стиль, не содержание. Для прохождения ATS-фильтров вставляй 3-5 ключевых формулировок из требований вакансии. НИКОГДА не используй длинное тире «—», используй короткий дефис «-». Делай пустую строку после «Здравствуйте!», между каждым блоком и между «Спасибо за уделенное время!» и «Мои контакты:». Ответ только одним JSON-объектом с ключом variants (массив из трёх строк), без ``` и без текста до/после.',
        },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.55,
      max_tokens: 2500,
    }),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${rawText.slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`OpenRouter: не JSON в теле ответа: ${rawText.slice(0, 300)}`);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new Error('OpenRouter: пустой ответ choices[0].message.content');
  }

  const parsed = extractJsonObject(text);
  const rawVariants = normalizeVariants(parsed.variants);

  // Постобработка: фиксируем структуру по шаблону и нормализуем тире
  const variants = rawVariants.map((v) =>
    templateRaw ? applyStructuralTemplate(v, record, templateRaw) : v.replace(/—/g, '-').replace(/–/g, '-')
  );

  const usedModel = data?.model || model;

  return { variants, providerModel: usedModel };
}
