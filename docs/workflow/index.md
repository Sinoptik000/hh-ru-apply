# Workflow Documentation

Документация по процессам (workflows) в hh-ru-apply.

## Процессы

| Процесс | Файл | Описание |
|---------|------|----------|
| Жизненный цикл вакансии | [vacancy-lifecycle.md](vacancy-lifecycle.md) | От сбора до отклика |
| Генерация писем | [cover-letter-flow.md](cover-letter-flow.md) | Как создаются варианты |

## Быстрый старт

1. Собрать вакансии: `npm run vacancies` или `npm run scan-tg`
2. Оценить: `npm run harvest`
3. В дашборде: просмотреть, сгенерировать письмо, утвердить
4. Откликнуться: `npm run hh-apply-chat -- --id=<uuid>`