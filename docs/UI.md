# UI Navigation Map

## Base URL

- `http://127.0.0.1:3849`

## Canonical Routes

- `/` -> redirect to `/vacancies/manual`
- `/vacancies/manual` -> tab `Добавить`
- `/vacancies/pending` -> tab `На проверке`
- `/vacancies/approved` -> tab `Подходят`
- `/vacancies/rejected` -> tab `Отклонённые`
- `/logs/apply-chat` -> modal `Лог отклика hh`
- `/sourcing/keywords` -> opened keywords dropdown
- `/sourcing/progress` -> visible sourcing progress state
- `/tools/codegen-hh` -> codegen action route

## Deep Links

- `/vacancies/:status/:id` -> open section and focus vacancy card
- `/vacancies/:status/:id` -> open full-screen modal `vacancy-detail-modal`
- `/vacancies/:status/:id/draft` -> open draft modal for vacancy
- `/vacancies/:status/:id/letter` -> open approved letter modal for vacancy

`status` values: `manual | pending | approved | rejected`.

## Fallback Rules

- Unknown route redirects to `/vacancies/manual`.
- Missing `:id` for deep link keeps target tab and shows notification.

## Vacancy Detail Modal

- ID: `#vacancy-detail-modal`
- Trigger: click on `.title-link` in vacancy card inside tabs (`manual | pending | approved | rejected`)
- Close: `Esc`, close button `×`, click on backdrop, button `Назад к списку`

### Layout

- Full-screen modal dialog `modal-dialog--vacancy-detail`
- Header:
  - Vacancy title
  - Company
  - Status
  - Score (`scoreOverall`, `scoreVacancy`, `scoreCvMatch`)
  - OpenRouter model
  - Actions: `Открыть на hh.ru`, `Назад к списку`
- Body (2 columns):
  - Left:
    - URL, salary, searchQuery, created/updated time
    - AI analysis: summary, risks, tags
    - Full description (not collapsed)
  - Right:
    - Template select (`operations | sales`)
    - Letter variant select (from `coverLetter.variants`)
    - Editable letter textarea
    - Actions: `Сохранить`, `Утвердить`, `Отклонить`, `Сгенерировать заново`
- Footer:
  - `coverLetter.status`
  - last save/update time
