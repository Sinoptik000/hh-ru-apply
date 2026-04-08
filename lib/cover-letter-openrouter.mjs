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

function loadCoverLetterTemplateHint() {
  for (const fp of COVER_CANDIDATES) {
    if (fs.existsSync(fp)) {
      const t = fs.readFileSync(fp, 'utf8').trim();
      if (t) return t.slice(0, 2000);
    }
  }
  return '';
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
БЛОК «INPUT» (сразу после названия вакансии, перед «Обо мне»):
- Начни с 1-2 предложений отзеркаливания сути вакансии: кого ищут и для каких задач.
- Формат: «Вы ищете [роль], который будет [ключевые задачи] и обеспечит [требования/результат]».
- Используй формулировки максимально близко к тексту вакансии.
- НЕ используй длинное тире «—», НИКОГДА. Используй короткий дефис «-».

ATS-СПИСОК (сразу после INPUT, перед «Обо мне»):
- Вставь маркированный список из 3-5 ключевых требований вакансии.
- Каждое требование привяжи к конкретному опыту/результату из резюме.
- Используй те же термины что в вакансии - ATS ищет точные совпадения.
- Формат: "* [требование из вакансии] - [мой релевантный опыт/результат]".
- Не заменяй профессиональные термины синонимами.

ПРАВИЛА ОТСТУПОВ:
- После «Здравствуйте!» ВСЕГДА делай пустую строку (это отдельный блок).
- Между «Спасибо за уделенное время!» и «Мои контакты:» ВСЕГДА делай пустую строку.
- Делай пустую строку между КАЖДЫМ блоком письма.
- Не используй заголовков «ATS» или «Мост» в финальном тексте - это только внутренние метки.`;

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

  // Постобработка: заменяем длинное тире на короткий дефис
  const variants = rawVariants.map((v) => v.replace(/—/g, '-').replace(/–/g, '-'));

  const usedModel = data?.model || model;

  return { variants, providerModel: usedModel };
}
