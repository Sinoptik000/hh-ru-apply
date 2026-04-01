# OpenRouter (оценка вакансий)

## Ключ

1. Зарегистрируйтесь на [openrouter.ai](https://openrouter.ai/), создайте API key.
2. В **`config/secrets.local.env`** (или `.env` / `.env.local`):

   ```
   OpenRouter_API_KEY=sk-or-v1-...
   ```

   Допустимо и имя **`OPENROUTER_API_KEY`**. Без пробелов вокруг `=`.

## Только бесплатные модели (по умолчанию)

Скрипт принимает модель только если:

- **`openrouter/free`** — маршрутизатор, сам выбирает доступную бесплатную модель, или  
- id заканчивается на **`:free`** (например `google/gemma-2-9b-it:free`).

Переменная **`OPENROUTER_MODEL`**, если не задана: в коде используется **`qwen/qwen3.6-plus-preview:free`**. Чтобы снова доверить выбор модели OpenRouter, задайте **`OPENROUTER_MODEL=openrouter/free`**.

Чтобы разрешить **платные** модели (не для тестового «только free» режима):

```
OPENROUTER_ALLOW_PAID=1
OPENROUTER_MODEL=anthropic/claude-3.5-haiku
```

## Запросы

Используется endpoint `https://openrouter.ai/api/v1/chat/completions` (совместим с OpenAI Chat).

Заголовки `HTTP-Referer` и `X-Title` — по [рекомендации OpenRouter](https://openrouter.ai/docs); при желании задайте `OPENROUTER_HTTP_REFERER`.

## Три скора (кандидат решает, откликаться ли)

В одном запросе модель возвращает:

- **scoreVacancy** (0–100) — насколько объявление само по себе уместно под ваш профиль (без детальной сверки с CV).
- **scoreCvMatch** (0–100) — насколько ваши резюме из `CV/` перекрывают требования вакансии.
- **scoreOverall** (0–100) — стоит ли в целом откликаться; если модель дала некорректное значение, итог пересчитывается как взвешенная сумма двух первых.

Веса в `config/preferences.json`: **`llmScoreWeights.vacancy`** и **`llmScoreWeights.cvMatch`** (сумма нормализуется к 1).

Промпт сформулирован от лица **соискателя** (советы «вам», отклик).

Резюме в `CV/` поддерживаются **`.md`**, `.txt` и `.pdf`.

## Команды

- `npm run harvest` — сбор и оценка вакансий.
- `npm run dashboard` — очередь на http://127.0.0.1:3849
