# Design Specification — hh-ru-apply Dashboard

## Обзор

Дашборд для управления вакансиями hh.ru. Интерфейс в тёмной теме, минималистичный стиль с акцентом на читаемость и функциональность.

---

## Визуальный стиль

### Общая направленность

- **Тема:** тёмная (dark mode)
- **Эстетика:** утилитарный интерфейс, близкий к IDE/терминалу
- **Шрифт:** Segoe UI, system-ui, sans-serif (macOS: -apple-system)
- **Размер базового шрифта:** ~0.92rem
- **Межстрочный интервал:** 1.45

### Типографика

| Элемент | Размер | Вес | Цвет |
|---------|--------|-----|------|
| Заголовок h1 | 1.35rem | 600 | `--text` |
| Название вакансии (.title-link) | 1.05rem | 600 | `--accent` |
| Мета-информация (.meta) | 0.88rem | 400 | `--muted` |
| Скор | 1.1rem | 700 | зависит от значения |
| Тело текста | 0.92rem | 400 | `--text` |
| Кнопки | 0.9rem | 600 | зависит от типа |
| Тэги | 0.75rem | 400 | `--muted` |

### Иконки и символы

- Эмодзи для кнопок действий: 🔍, ➕, 📝
- Крестик × для закрытия (font-size 1.35rem)
- SVG для иконок действий (refresh, copy)

---

## Цветовая система

### Основные переменные

```css
--bg: #0f1114       /* фон страницы — почти чёрный */
--panel: #181c22    /* фон карточек — тёмно-серый */
--text: #e8eaed     /* основной текст — светло-серый */
--muted: #9aa0a6    /* вторичный текст — приглушённый */
--accent: #7cb7ff   /* акцентный синий — ссылки, активные элементы */
--good: #6bcf7f     /* зелёный — положительные действия */
--bad: #f08080      /* красный — отрицательные действия */
--border: #2a3139   /* границы — едва заметные */
```

### Роль цветов

| Цвет | Использование |
|------|---------------|
| `--bg` | Фон страницы, `<body>` |
| `--panel` | Фон карточек, модалок, дропдаунов |
| `--text` | Заголовки, основной текст |
| `--muted` | Подписи, мета-информация, плейсхолдеры |
| `--accent` | Ссылки, активные табы, фокус |
| `--good` | Кнопка "Подходит", успешные состояния |
| `--bad` | Кнопка "Не подходит", ошибки |
| `--border` | Границы карточек, кнопок, инпутов |

### Цветовая кодировка по значению

**Score (скор вакансии):**
- Зелёный: > 75 — `background: #2d4a35`
- Жёлтый: 50-75 — `background: #3a2f1b` (пока не используется явно)
- Красный: < 50 — `background: #4a2d2d`

**Workplace type badges:**
- Удалёнка: `background: #1b3a2a`, `color: #6ee7a0`
- Гибрид: `background: #3a2f1b`, `color: #e7c96e`
- Офис: `background: #3a1b1b`, `color: #e76e6e`
- Не указано: `background: #2a2a2e`, `color: #999`

**Language level badges:**
- A1, A2, B1: зелёный (`#1b3a2a`)
- B2: жёлтый (`#3a2f1b`)
- C1, C2, Native, Proficiency, etc.: красный (`#3a1b1b`)
- Средний, Базовый, Не владею: серый (`#2a2a2e`)

---

## Компоненты

### Кнопки (`.btn`)

**Базовые стили:**
```css
padding: 0.45rem 1rem;
border-radius: 8px;
font-size: 0.9rem;
font-weight: 600;
```

**Варианты:**
- `.btn.ok` — зелёный фон `#2d4a35`, текст `--good`
- `.btn.bad` — красный фон `#4a2d2d`, текст `--bad`
- Без модификатора — прозрачный фон, текст `--accent`

** Hover:** яркость фона +10%
** Disabled:** `opacity: 0.5`, `cursor: not-allowed`

### Карточка (`.card`)

```css
background: var(--panel);
border: 1px solid var(--border);
border-radius: 12px;
padding: 1rem 2.25rem 1rem 1.1rem;
margin-bottom: 1rem;
```

**Состояние новой карточки** (добавлена только что):
```css
border-color: #4CAF50;
box-shadow: 0 0 16px rgba(76, 175, 80, 0.35);
animation: pulse-highlight 0.6s ease-in-out 3;
```

### Поле ввода (`.vacancy-search`)

```css
flex: 1;
padding: 0.45rem 2rem 0.45rem 0.75rem;
border-radius: 8px;
border: 1px solid var(--border);
background: var(--panel);
color: var(--text);
font-size: 0.92rem;
```

**Контейнер** (`.search-bar`):
```css
display: flex;
align-items: center;
gap: 0.5rem;
margin-bottom: 0.75rem;
position: relative;
max-width: 52rem;
padding: 0 1.5rem;
margin-left: auto;
margin-right: auto;
```

**Фокус:**
```css
border-color: var(--accent);
box-shadow: 0 0 0 2px rgba(124, 183, 255, 0.15);
```

### Табы (`.tab`)

**Неактивный:**
```css
background: var(--panel);
border: 1px solid var(--border);
color: var(--muted);
```

**Активный:**
```css
color: var(--text);
border-color: var(--accent);
```

### Модалки (`.modal`)

```css
position: fixed;
inset: 0;
z-index: 2000;
background: rgba(0, 0, 0, 0.55); /* backdrop */
```

**Диалог:**
```css
background: var(--panel);
border: 1px solid var(--border);
border-radius: 12px;
padding: 1rem 1.15rem 1.25rem;
box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
```

---

## Анимации и переходы

| Элемент | Свойство | Длительность | easing |
|---------|----------|--------------|--------|
| Карточка | border-color, box-shadow | 0.3s | ease |
| Тултип score | opacity | 0.12s | ease |
| Sourcing progress | width | 0.5s | ease |
| Add vacancy progress | width | 0.3s | ease |
| Toast | opacity, transform | 0.25s | ease |

**Keyframes:**
```css
@keyframes pulse-highlight {
  0%, 100% { box-shadow: 0 0 16px rgba(76, 175, 80, 0.35); }
  50% { box-shadow: 0 0 28px rgba(76, 175, 80, 0.6); }
}
```

---

## Spacing система

**Используется rem/em для относительных размеров.**

| Элемент | Значение |
|---------|----------|
| Отступ страницы | 1.5rem ( sides), 1rem (top) |
| Отступ между карточками | 1rem (margin-bottom) |
| Gap между flex-элементами | 0.5rem, 0.75rem |
| Padding карточки | 1rem 2.25rem 1rem 1.1rem |
| Padding кнопок | 0.4rem 0.85rem |
| Border-radius | 8px (кнопки, инпуты), 12px (карточки, модалки) |

---

## Z-index слои

| Слой | Значение | Использование |
|------|----------|---------------|
| Карточки | auto | базовый |
| Score tooltip | 60 | всплывающая подсказка |
| Model info panel | 70 | панель информации о модели |
| Keywords dropdown | 100 | выпадающий список |
| Toast | 1000 | уведомления |
| Modal backdrop | 2000 | затемнение фона |
| Modal dialog | 2001 | диалоговое окно |

---

## Состояния компонентов

### Пустые состояния (`.empty`)

```css
color: var(--muted);
padding: 2rem 0;
```

### Ошибка (`.err`)

```css
color: var(--bad);
padding: 1rem;
```

### Toast variants

| Вариант | Background | Border | Text |
|---------|------------|--------|------|
| good | `#1e3328` | `#2d5c40` | `--good` |
| bad | `#332222` | `#5c2d2d` | `#f0a0a0` |
| neutral | `--panel` | `--border` | `--text` |

---

## Шрифты (fallback chain)

```css
font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
```

Для моноширинного текста (логи):
```css
font-family: ui-monospace, "Cascadia Code", "Fira Code", monospace;
```