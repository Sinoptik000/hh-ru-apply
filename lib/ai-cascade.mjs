/**
 * Каскадный вызов AI-провайдеров с fallback.
 * Перебирает провайдеры по приоритету, при ошибке — переходит к следующему.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPreferences } from './preferences.mjs';
import { loadRecentFeedback } from './feedback-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROVIDERS_CONFIG = path.join(ROOT, 'config', 'ai-providers.json');

function loadProvidersConfig() {
  if (!fs.existsSync(PROVIDERS_CONFIG)) {
    return { providers: [], fallback: {} };
  }
  return JSON.parse(fs.readFileSync(PROVIDERS_CONFIG, 'utf-8'));
}

function getApiKey(envKey) {
  return (process.env[envKey] || '').trim();
}

function shouldRetry(status, text) {
  const { fallback } = loadProvidersConfig();
  const errorStatuses = fallback.onErrorStatuses || [429, 500, 502, 503, 504];
  if (errorStatuses.includes(status)) return true;
  if (fallback.onEmptyResponse && (!text || !text.trim())) return true;
  return false;
}

function logFailure(name, error, attempt) {
  console.warn(`[AI-Cascade] ${name} (попытка ${attempt}): ${error.message}`);
}

async function callWithRetry(provider, messages, maxRetries) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callProvider(provider, messages);
      if (result.content && result.content.trim()) {
        return result;
      }
      if (!shouldRetry(result.status || 200, result.content)) {
        return result;
      }
      lastError = new Error(`Пустой ответ (попытка ${attempt}/${maxRetries})`);
      if (provider.name) logFailure(provider.name, lastError, attempt);
    } catch (e) {
      lastError = e;
      if (provider.name) logFailure(provider.name, e, attempt);
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError || new Error('Все попытки исчерпаны');
}

async function callProvider(provider, messages) {
  const { name, endpoint, model, envKey, maxTokens, temperature, freeOnly, freeModels } = provider;
  const apiKey = getApiKey(envKey);
  if (!apiKey) {
    throw new Error(`Нет API-ключа: ${envKey}`);
  }

  if (name === 'google') {
    return callGoogle(provider, messages);
  }

  // Определяем модель для запроса
  let requestModel = model;
  if (freeOnly && name === 'openrouter') {
    requestModel = resolveFreeOpenRouterModel();
  } else if (freeOnly && freeModels?.length > 0) {
    // Для Groq и других — берём первую из списка бесплатных
    requestModel = freeModels[0];
  }

  // OpenRouter и Groq (OpenAI-совместимый интерфейс)
  // Список моделей для перебора
  const modelsToTry = (freeOnly && freeModels?.length > 0)
    ? [...freeModels]
    : [requestModel];

  let lastError;
  for (const tryModel of modelsToTry) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(name === 'openrouter' ? {
            'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
            'X-Title': 'hh-ru-apply',
          } : {}),
        },
        body: JSON.stringify({
          model: tryModel,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(provider.timeoutMs || 30000),
      });

      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`${name} ${res.status}: ${rawText.slice(0, 500)}`);
      }

      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`${name}: не JSON в ответе: ${rawText.slice(0, 300)}`);
      }

      const content = data?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        throw new Error(`${name}: пустой ответ`);
      }

      return {
        content,
        model: data?.model || tryModel,
        status: res.status,
        raw: data,
      };
    } catch (e) {
      lastError = e;
      if (provider.name) logFailure(`${provider.name} (${tryModel})`, e, 1);
    }
  }

  throw lastError || new Error(`${name}: все модели недоступны`);
}

async function callGoogle(provider, messages) {
  const { endpoint, model, envKey, maxTokens, temperature, freeOnly, freeModels } = provider;
  const apiKey = getApiKey(envKey);

  // Список моделей для перебора
  const modelsToTry = freeOnly && freeModels?.length > 0
    ? [...freeModels]
    : [model];

  let lastError;
  for (const modelName of modelsToTry) {
    try {
      const url = endpoint.replace('{model}', modelName);
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const res = await fetch(`${url}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
          },
        }),
        signal: AbortSignal.timeout(provider.timeoutMs || 30000),
      });

      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`google ${res.status}: ${rawText.slice(0, 500)}`);
      }

      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`google: не JSON в ответе: ${rawText.slice(0, 300)}`);
      }

      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content || !content.trim()) {
        throw new Error('google: пустой ответ');
      }

      return {
        content,
        model: modelName,
        status: res.status,
        raw: data,
      };
    } catch (e) {
      lastError = e;
      if (provider.name) logFailure(`${provider.name} (${modelName})`, e, 1);
    }
  }

  throw lastError || new Error('Все модели Google недоступны');
}

function resolveFreeOpenRouterModel() {
  const raw = (process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus-preview:free').trim();
  if (raw === 'openrouter/free') return raw;
  if (raw.endsWith(':free')) return raw;
  return 'qwen/qwen3.6-plus-preview:free';
}

export function getEnabledProviders() {
  const { providers } = loadProvidersConfig();
  return providers
    .filter(p => p.enabled && getApiKey(p.envKey))
    .sort((a, b) => a.priority - b.priority);
}

export async function scoreVacancyCascade(vacancy, cvBundle, prefs) {
  const providers = getEnabledProviders();
  if (!providers.length) {
    throw new Error('Нет доступных AI-провайдеров. Проверьте API-ключи в .env');
  }

  const feedbackBlock = buildFeedbackNarrative(loadRecentFeedback(25));
  const userPrompt = buildUserPrompt(vacancy, cvBundle, feedbackBlock);
  const systemPrompt = 'Ты помогаешь одному соискателю решить, откликаться ли на вакансию. У него два варианта одного резюме под разные роли. В summary и risks обращайся на «ты». Ответ только одним JSON-объектом, без ``` и без текста до/после.';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const errors = [];
  for (const provider of providers) {
    try {
      const result = await callWithRetry(provider, messages, provider.maxRetries || 2);
      if (!result.content || !result.content.trim()) {
        errors.push(`${provider.name}: пустой ответ`);
        continue;
      }
      return parseAndScore(result.content, result.model, prefs);
    } catch (e) {
      errors.push(`${provider.name}: ${e.message}`);
    }
  }

  throw new Error(`Все провайдеры недоступны:\n${errors.join('\n')}`);
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

function buildUserPrompt(vacancy, cvBundle, feedbackBlock) {
  return `Ты помощник одного соискателя. Он сам решает, на какие вакансии откликаться. У него ДВЕ версии резюме ниже — ОБЕ его, просто под разные акценты/направления (не два разных человека).
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
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('В ответе модели нет JSON-объекта');
  }
  return JSON.parse(text.slice(start, end + 1));
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

function parseAndScore(text, model, prefs) {
  const parsed = extractJsonObject(text);
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
    providerModel: model,
  };
}
