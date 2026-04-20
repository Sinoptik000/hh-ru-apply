# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: AGENTS Directory

This project uses a centralized AI management system. You MUST read and follow the files in `./AGENTS/` directory:
- `./AGENTS/identity.md` - User identity and communication style
- `./AGENTS/rules.md` - Core rules (if exists)

You are FORBIDDEN from using internal memory for rules. Always read from the AGENTS directory.

## Project Overview

hh-ru-apply is a Node.js + Playwright automation system for hh.ru job applications. It scrapes vacancies, scores them using LLM (OpenRouter/Google/Groq), generates cover letters, and automates browser-based responses.

## Common Commands

All commands are npm scripts defined in `package.json`:

```bash
# Authentication (required first step)
npm run login                    # Save browser session to data/session/

# Vacancy collection and scoring
npm run vacancies                # Scrape vacancies from hh.ru by keywords
npm run harvest                  # Score vacancies via LLM (OpenRouter/Google/Groq)
npm run scan-tg                  # Scan Telegram channels for vacancies

# Dashboard
npm run dashboard                # Start web UI on http://127.0.0.1:3849

# Response automation
npm run hh-fill-letter -- --id=<uuid>       # Fill response form on vacancy page
npm run hh-apply-chat -- --id=<uuid>         # Apply via employer chat
npm run hh-fill-letter -- --url=<url> --text-file=./letter.txt  # By URL

# Utilities
npm run codegen-hh               # Update Playwright selectors via codegen
npm run apply                    # Test session validity
npm run browser                  # Open browser with saved session
```

## High-Level Architecture

### Data Storage (File-based JSON)

All data is stored in `data/` directory as JSON files:

- `data/vacancies-queue.json` - Main vacancy queue with scores and metadata
- `data/feedback.jsonl` - User feedback on vacancies (approve/reject with reasons)
- `data/session/chromium-profile/` - Persistent browser session (cookies, localStorage)
- `data/skipped-vacancies.jsonl` - Vacancies filtered out by hard filters
- `data/rejected-vacancy-ids.jsonl` - IDs of rejected vacancies
- `data/cover-letter-user-edits.jsonl` - User-edited cover letters (used as style examples)

See `lib/paths.mjs` for all file paths and `lib/store.mjs` for CRUD operations.

### AI Cascade System

Multi-provider fallback for LLM calls in `lib/ai-cascade.mjs`:

1. **OpenRouter** (priority 1) - Uses free models by default (`openrouter/free` or `:free` models)
2. **Google Gemini** (priority 2) - Flash models
3. **Groq** (priority 3) - Llama models

Configuration in `config/ai-providers.json`. Each provider has `freeOnly` flag and `freeModels` list.

Key function: `scoreVacancyCascade(vacancy, cvBundle, prefs)` returns three scores:
- `scoreVacancy` (0-100) - How relevant the vacancy is
- `scoreCvMatch` (0-100) - How well CV covers requirements
- `scoreOverall` (0-100) - Weighted combination for final decision

### Browser Automation

Playwright with persistent context in `data/session/chromium-profile/`:

- Session is created via `npm run login` and reused across scripts
- Human-like delays configured via `HH_*_DELAY_*` env variables
- Selectors isolated in `lib/hh-response-selectors.mjs` and `lib/hh-chat-selectors.mjs`

### Dashboard Architecture

- **Server:** `scripts/dashboard-server.mjs` - Express-like HTTP server
- **Frontend:** `dashboard/public/app.js` - Vanilla JS, no framework
- **Port:** 3849 (configurable via `DASHBOARD_PORT`)
- **API:** REST endpoints at `/api/*` (see dashboard-server.mjs for routes)

### Vacancy Lifecycle

1. **Collection:** `open-vacancies.mjs` or `scan-telegram.mjs` → adds to queue
2. **Scoring:** `harvest.mjs` → calls AI cascade, adds scores and summary
3. **Review:** Dashboard → user views, generates cover letter, approves/rejects
4. **Response:** `hh-apply-chat.mjs` or `hh-fill-response-letter.mjs` → browser automation

### Cover Letter Generation

Templates and examples stored in `config/`:
- `config/cover-letter.txt` - Base template
- `config/cover-letter-style-examples.txt` - User's previous letters as style examples

Generation via `lib/cover-letter-openrouter.mjs` using AI cascade with style context from `lib/cover-letter-style-context.mjs`.

## Configuration Files

- `.env` - Environment variables (API keys, delays, limits)
- `config/ai-providers.json` - AI provider priority and settings
- `config/preferences.json` - User preferences (score weights, etc.)
- `config/search-keywords.txt` - One search query per line
- `CV/` - User resumes in .md, .txt, or .pdf format

## Key Environment Variables

```bash
HH_SESSION_DIR=./data/session           # Browser profile location
HH_HEADLESS=0                           # Show/hide browser window
HH_MAX_TOTAL=7                          # Max vacancies per run
HH_OPEN_DELAY_MIN_MS=3000               # Min delay between page opens
HH_OPEN_DELAY_MAX_MS=5000               # Max delay between page opens
OpenRouter_API_KEY=...                  # For LLM scoring
GOOGLE_API_KEY=...                      # Fallback AI provider
GROQ_API_KEY=...                        # Fallback AI provider
DASHBOARD_PORT=3849                     # Dashboard port
```

## ES Modules

This project uses ES modules (`"type": "module"` in package.json). Always use:
- `import/export` syntax
- `.mjs` extension for modules
- `fileURLToPath` for `__dirname` equivalent

## Docker Support

```bash
docker compose up -d                    # Start dashboard
docker compose run --rm dashboard npm run <command>
```

Data persisted via volume to local `data/` directory.
