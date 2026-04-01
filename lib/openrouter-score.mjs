import { loadRecentFeedback } from './feedback-context.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Дефолт при отсутствии OPENROUTER_MODEL (и для free, и для allow paid без env). */
export const DEFAULT_OPENROUTER_MODEL = 'qwen/qwen3.6-plus-preview:free';

export function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('В ответе модели нет JSON-объекта');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function buildFeedbackNarrative(entries) {
  if (!entries.length) return '';
  const lines = entries
    .filter((e) => e.action === 'reject' && e.reason)
    .slice(-12)
    .map((e) => `- «${(e.title || '').slice(0, 80)}»: ${e.reason}`);
  if (!lines.length) return '';
  return `\nРанее вы отклоняли вакансии с такими формулировками (учти при отклике):\n${lines.join('\n')}\n`;
}

export function getOpenRouterApiKey() {
  return (
    process.env.OpenRouter_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    ''
  ).trim();
}

export function resolveFreeOpenRouterModel() {
  const raw = (process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL).trim();
  if (raw === 'openrouter/free') return raw;
  if (raw.endsWith(':free')) return raw;
  throw new Error(
    `OPENROUTER_MODEL="${raw}" — не бесплатный вариант. Используйте "openrouter/free" или id модели с суффиксом ":free". Для платных моделей задайте OPENROUTER_ALLOW_PAID=1 (не рекомендуется для тестов).`
  );
}

export function resolveOpenRouterModelForRequest() {
  const allowPaid = process.env.OPENROUTER_ALLOW_PAID === '1';
  if (allowPaid) {
    return (process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL).trim();
  }
  return resolveFreeOpenRouterModel();
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(100, Math.max(0, Math.round(x)));
}

function normalizedWeights(prefs) {
  const w = prefs?.llmScoreWeights || {};
  let v = Number(w.vacancy);
  let c = Number(w.cvMatch);
  if (!Number.isFinite(v)) v = 0.35;
  if (!Number.isFinite(c)) c = 0.65;
  const sum = v + c;
  if (sum <= 0) return { v: 0.35, c: 0.65 };
  return { v: v / sum, c: c / sum };
}

function resolveThreeScores(parsed, prefs) {
  const legacy = Number(parsed.score);
  const svRaw = parsed.scoreVacancy;
  const scRaw = parsed.scoreCvMatch;
  const soRaw = parsed.scoreOverall;

  let scoreVacancy = clampScore(svRaw);
  let scoreCvMatch = clampScore(scRaw);

  if (
    !Number.isFinite(Number(svRaw)) &&
    !Number.isFinite(Number(scRaw)) &&
    Number.isFinite(legacy)
  ) {
    const o = clampScore(legacy);
    return {
      scoreVacancy: o,
      scoreCvMatch: o,
      scoreOverall: o,
    };
  }

  let scoreOverall = clampScore(soRaw);
  const overallValid = Number.isFinite(Number(soRaw)) && Number(soRaw) >= 0 && Number(soRaw) <= 100;
  if (!overallValid) {
    const { v, c } = normalizedWeights(prefs);
    scoreOverall = clampScore(v * scoreVacancy + c * scoreCvMatch);
  }

  return { scoreVacancy, scoreCvMatch, scoreOverall };
}

/**
 * @param {{ title: string, company: string, salaryRaw: string, description: string, url: string }} vacancy
 * @param {{ text: string }} cvBundle
 * @param {object} prefs — preferences.json (в т.ч. llmScoreWeights)
 */
export async function scoreVacancyWithOpenRouter(vacancy, cvBundle, prefs) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error(
      'Нет OpenRouter_API_KEY или OPENROUTER_API_KEY (см. config/secrets.example.env)'
    );
  }

  const model = resolveOpenRouterModelForRequest();
  const feedbackBlock = buildFeedbackNarrative(loadRecentFeedback(25));

  const userPrompt = `Ты помощник одного соискателя. Он сам решает, на какие вакансии откликаться. У него ДВЕ версии резюме ниже — ОБЕ его, просто под разные акценты/направления (не два разных человека).
Жёсткие фильтры (зарплата, удалёнка и т.д.) уже применены скриптом до тебя.
${feedbackBlock}
Оцени вакансию с его точки зрения: стоит ли тратить время на отклик.

Смысл полей scoreVacancy / scoreCvMatch / scoreOverall — целые от 0 до 100:
- scoreVacancy: насколько сама вакансия по тексту объявления уместна и интересна для его профиля (домен, уровень, тип роли, красные флаги). Без построчной сверки с резюме.
- scoreCvMatch: насколько его оба резюме перекрывают требования вакансии; насколько обоснован отклик с этими CV.
- scoreOverall: насколько в целом имеет смысл откликаться (совмести оба сигнала).

Поле summary: кратко для него, обращение на «ты»; без сухого от третьего лица про «кандидата».

Поле risks: нюансы и зоны внимания при отклике с ЕГО двумя резюме. Пиши ТОЛЬКО на «ты» / «у тебя» (например: «У тебя больше опыта в X, а в вакансии упор на Y»). НЕ пиши «кандидаты», «кандидат», «соискатели» — это всегда один и тот же человек с двумя версиями CV.

matchCv: primary | secondary | both | none — какое резюме логичнее вести первым (первый файл в блоке «МОИ РЕЗЮМЕ» = primary, второй = secondary).

Верни СТРОГО один JSON без markdown и без текста до/после:
{
  "scoreVacancy": 0,
  "scoreCvMatch": 0,
  "scoreOverall": 0,
  "summary": "",
  "risks": "",
  "matchCv": "both",
  "tags": []
}
(подставь свои числа и строки вместо примеров)

ВАКАНСИЯ:
Заголовок: ${vacancy.title}
Компания: ${vacancy.company}
Зарплата (как на сайте): ${vacancy.salaryRaw}
URL: ${vacancy.url}

Описание (фрагмент):
${vacancy.description.slice(0, 8000)}

МОИ РЕЗЮМЕ (два варианта):
${cvBundle.text.slice(0, 18_000)}
`;

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
      'X-Title': 'hh-ru-apply',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Ты помогаешь одному соискателю решить, откликаться ли на вакансию. У него два варианта одного резюме под разные роли. В summary и risks обращайся на «ты». Ответ только одним JSON-объектом, без ``` и без текста до/после.',
        },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.35,
      max_tokens: 1200,
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
  const usedModel = data?.model || model;
  const { scoreVacancy, scoreCvMatch, scoreOverall } = resolveThreeScores(parsed, prefs);

  return {
    score: scoreOverall,
    scoreVacancy,
    scoreCvMatch,
    scoreOverall,
    summary: String(parsed.summary || '').trim(),
    risks: String(parsed.risks || '').trim(),
    matchCv: String(parsed.matchCv || 'none').trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    rawModelText: text.slice(0, 2000),
    providerModel: usedModel,
  };
}
