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

  const userPrompt = `Напиши три разных варианта короткого сопроводительного письма на русском для отклика на вакансию.
Каждый вариант — 4–8 предложений, по-человечески, без markdown.
Учитывай резюме кандидата и текст вакансии; подчеркни релевантный опыт фактами, не лозунгами.
${antiAiRules}
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
            'Ты помогаешь одному соискателю писать короткие сопроводительные письма на русском: звучат естественно, без канцелярита и клише нейросетей. Если даны эталоны — копируй только стиль, не содержание. Ответ только одним JSON-объектом с ключом variants (массив из трёх строк), без ``` и без текста до/после.',
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
  const variants = normalizeVariants(parsed.variants);
  const usedModel = data?.model || model;

  return { variants, providerModel: usedModel };
}
