const listEl = document.getElementById('list');
const tpl = document.getElementById('card-tpl');

const vacancyTabsEl = document.querySelector('.vacancy-tabs');

let currentStatus = 'pending';

/** Нормализованные веса для подсказки к скору (как в lib/openrouter-score.mjs) */
let scoreWeights = { vacancy: 0.35, cvMatch: 0.65 };

/** @type {{ id: string, variants: string[], selectedIndex: number } | null} */
let draftModalState = null;

/** @type {ReturnType<typeof setInterval> | null} */
let applyLogRefreshTimer = null;

/** Счётчики по статусам */
let vacancyCounts = { pending: 0, approved: 0, rejected: 0 };

/** Кэш записей по статусам */
let cachedItems = { pending: null, approved: null, rejected: null };

/** Сброс кэша — требует перезагрузки при следующем load() */
function invalidateCache() {
  cachedItems = { pending: null, approved: null, rejected: null };
}

// Проверяем активный sourcing при загрузке страницы
checkActiveSourcing();

document.addEventListener('click', () => {
  document.querySelectorAll('.model-info-panel').forEach((p) => {
    p.hidden = true;
  });
});

function showToast(message, variant = 'neutral') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast--${variant}`;
  t.setAttribute('role', 'status');
  t.textContent = message;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--visible'));
  const hide = () => {
    t.classList.remove('toast--visible');
    setTimeout(() => t.remove(), 280);
  };
  setTimeout(hide, 2600);
}

async function api(path, opts = {}) {
  const url =
    typeof path === 'string' && path.startsWith('/')
      ? new URL(path, window.location.origin).toString()
      : path;
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const looksHtml = /^\s*</.test(text);
    const hint =
      r.status === 404 && (text.trim() === 'Not found' || looksHtml)
        ? 'Ответ не JSON (часто 404 у статики). Запустите дашборд: npm run dashboard и откройте http://127.0.0.1:3849'
        : text.slice(0, 400) || r.statusText;
    const err = new Error(hint);
    err.status = r.status;
    throw err;
  }
  if (!r.ok) {
    const err = new Error(data.error || r.statusText);
    err.status = r.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function requestCoverLetterGenerate(id, force = false) {
  return api('/api/cover-letter/generate', {
    method: 'POST',
    body: JSON.stringify({ id, force }),
  });
}

function closeDraftModal() {
  const modal = document.getElementById('draft-modal');
  if (!modal) return;
  modal.hidden = true;
  draftModalState = null;
  document.removeEventListener('keydown', onDraftModalEscape);
}

function onDraftModalEscape(e) {
  if (e.key === 'Escape') closeDraftModal();
}

function closeApprovedLetterModal() {
  const modal = document.getElementById('approved-letter-modal');
  if (!modal) return;
  modal.hidden = true;
  document.removeEventListener('keydown', onApprovedModalEscape);
}

function closeApplyLogModal() {
  if (applyLogRefreshTimer != null) {
    clearInterval(applyLogRefreshTimer);
    applyLogRefreshTimer = null;
  }
  const modal = document.getElementById('apply-log-modal');
  if (!modal) return;
  modal.hidden = true;
  document.removeEventListener('keydown', onApplyLogModalEscape);
}

function onApplyLogModalEscape(e) {
  if (e.key === 'Escape') closeApplyLogModal();
}

async function refreshApplyLogModal() {
  const modal = document.getElementById('apply-log-modal');
  if (!modal) return;
  const pre = modal.querySelector('.apply-log-pre');
  const pathEl = modal.querySelector('.apply-log-path');
  pathEl.textContent = 'data/hh-apply-chat.log';
  pre.textContent = 'Загрузка…';
  try {
    const data = await api('/api/hh-apply-chat-log?lines=120');
    const rel = data.relativePath || data.path || 'data/hh-apply-chat.log';
    pathEl.textContent = rel && rel !== '.' ? rel : 'data/hh-apply-chat.log';
    if (!data.exists) {
      pre.textContent =
        'Файла лога ещё нет. Нажмите «Отклик в браузере» на карточке с утверждённым письмом — тогда появится Chromium и запись в лог.';
      return;
    }
    pre.textContent = data.text || '(пусто)';
  } catch (e) {
    pre.textContent = `Ошибка: ${e.message}`;
  }
}

function openApplyLogModal() {
  const modal = document.getElementById('apply-log-modal');
  if (!modal) return;
  if (applyLogRefreshTimer != null) {
    clearInterval(applyLogRefreshTimer);
    applyLogRefreshTimer = null;
  }
  modal.hidden = false;
  document.addEventListener('keydown', onApplyLogModalEscape);
  refreshApplyLogModal();
  applyLogRefreshTimer = setInterval(() => refreshApplyLogModal(), 2500);
}

function onApprovedModalEscape(e) {
  if (e.key === 'Escape') closeApprovedLetterModal();
}

function openApprovedLetterModal(item) {
  const modal = document.getElementById('approved-letter-modal');
  if (!modal) return;
  const text = String(item.coverLetter?.approvedText || '').trim();
  modal.querySelector('.modal-vacancy-approved').textContent = item.title || item.url || '';
  modal.querySelector('.modal-approved-text').textContent = text;
  modal.hidden = false;
  document.addEventListener('keydown', onApprovedModalEscape);
}

function openDraftModal(item) {
  const modal = document.getElementById('draft-modal');
  if (!modal) return;
  const body = modal.querySelector('.modal-draft-body');
  const vacEl = modal.querySelector('.modal-vacancy');
  vacEl.textContent = item.title || item.url || '';
  body.innerHTML = '';

  const raw = item.coverLetter?.variants || [];
  const variants = raw.length ? raw.map((s) => String(s)) : [];
  if (!variants.length) {
    const p = document.createElement('p');
    p.className = 'modal-empty';
    p.textContent = 'Нет вариантов.';
    body.appendChild(p);
    modal.hidden = false;
    document.addEventListener('keydown', onDraftModalEscape);
    draftModalState = null;
    return;
  }

  while (variants.length < 3) {
    variants.push(variants[variants.length - 1] || '');
  }
  variants.splice(3);

  const name = `draft-v-${item.id}`;
  let selectedIndex = 0;

  const fieldset = document.createElement('fieldset');
  fieldset.className = 'modal-draft-fieldset';
  const legend = document.createElement('legend');
  legend.textContent = 'Вариант';
  fieldset.appendChild(legend);

  variants.forEach((_, i) => {
    const row = document.createElement('div');
    row.className = 'modal-draft-variant-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.id = `${name}-${i}`;
    input.value = String(i);
    if (i === 0) input.checked = true;
    const label = document.createElement('label');
    label.htmlFor = `${name}-${i}`;
    label.textContent = `Вариант ${i + 1}`;
    row.appendChild(input);
    row.appendChild(label);
    fieldset.appendChild(row);
  });

  const lbl = document.createElement('label');
  lbl.className = 'modal-letter-label';
  lbl.htmlFor = `${name}-edit`;
  lbl.textContent = 'Текст (правки сохраняются и учитываются при следующей генерации)';

  const ta = document.createElement('textarea');
  ta.className = 'modal-letter-edit';
  ta.id = `${name}-edit`;
  ta.rows = 12;
  ta.value = variants[0] || '';

  const actions = document.createElement('div');
  actions.className = 'modal-draft-actions';

  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.className = 'btn';
  btnSave.textContent = 'Сохранить правки';

  const btnApprove = document.createElement('button');
  btnApprove.type = 'button';
  btnApprove.className = 'btn ok';
  btnApprove.textContent = 'Утвердить';

  const btnDecline = document.createElement('button');
  btnDecline.type = 'button';
  btnDecline.className = 'btn bad';
  btnDecline.textContent = 'Отклонить';

  actions.appendChild(btnSave);
  actions.appendChild(btnApprove);
  actions.appendChild(btnDecline);

  body.appendChild(fieldset);
  body.appendChild(lbl);
  body.appendChild(ta);
  body.appendChild(actions);

  draftModalState = { id: item.id, variants, selectedIndex: 0 };

  function syncTextareaToVariant() {
    if (!draftModalState) return;
    draftModalState.variants[draftModalState.selectedIndex] = ta.value;
  }

  fieldset.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name !== name || t.type !== 'radio') return;
    syncTextareaToVariant();
    const idx = Number(t.value);
    if (!Number.isFinite(idx) || idx < 0 || idx > 2) return;
    draftModalState.selectedIndex = idx;
    ta.value = draftModalState.variants[idx] ?? '';
  });

  btnSave.addEventListener('click', async () => {
    syncTextareaToVariant();
    btnSave.disabled = btnApprove.disabled = btnDecline.disabled = true;
    try {
      await api('/api/cover-letter/save-draft', {
        method: 'POST',
        body: JSON.stringify({ id: item.id, variants: draftModalState.variants }),
      });
      showToast('Правки сохранены', 'good');
      invalidateCache();
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      btnSave.disabled = btnApprove.disabled = btnDecline.disabled = false;
    }
  });

  btnApprove.addEventListener('click', async () => {
    syncTextareaToVariant();
    const text = ta.value.trim();
    if (!text) {
      alert('Введите или выберите текст письма.');
      return;
    }
    btnSave.disabled = btnApprove.disabled = btnDecline.disabled = true;
    try {
      await api('/api/cover-letter/action', {
        method: 'POST',
        body: JSON.stringify({ id: item.id, action: 'approve', text }),
      });
      showToast('Письмо утверждено', 'good');
      closeDraftModal();
      invalidateCache();
      await load();
    } catch (e) {
      alert(e.message);
      btnSave.disabled = btnApprove.disabled = btnDecline.disabled = false;
    }
  });

  btnDecline.addEventListener('click', async () => {
    if (!confirm('Отклонить черновик?')) return;
    btnSave.disabled = btnApprove.disabled = btnDecline.disabled = true;
    try {
      await api('/api/cover-letter/action', {
        method: 'POST',
        body: JSON.stringify({ id: item.id, action: 'decline' }),
      });
      showToast('Черновик отклонён', 'neutral');
      closeDraftModal();
      invalidateCache();
      await load();
    } catch (e) {
      alert(e.message);
      btnSave.disabled = btnApprove.disabled = btnDecline.disabled = false;
    }
  });

  modal.hidden = false;
  document.addEventListener('keydown', onDraftModalEscape);
}

const draftModalEl = document.getElementById('draft-modal');
draftModalEl?.querySelector('[data-close-modal]')?.addEventListener('click', closeDraftModal);
draftModalEl?.querySelector('.modal-close')?.addEventListener('click', closeDraftModal);

const approvedModalEl = document.getElementById('approved-letter-modal');
approvedModalEl?.querySelector('[data-close-approved-modal]')?.addEventListener('click', closeApprovedLetterModal);
approvedModalEl?.querySelector('.modal-close--approved')?.addEventListener('click', closeApprovedLetterModal);

// Keywords dropdown
const keywordsBtn = document.querySelector('.btn-keywords');
const keywordsDropdown = document.querySelector('.keywords-list');
const keywordsContent = document.getElementById('keywords-content');
const keywordsCloseBtn = document.querySelector('.keywords-close');

let keywordsLoaded = false;

keywordsBtn?.addEventListener('click', async () => {
  if (keywordsDropdown.hidden) {
    // Показываем dropdown
    keywordsDropdown.hidden = false;
    
    // Загружаем ключевые слова если ещё не загружены
    if (!keywordsLoaded) {
      await loadKeywords();
    }
  } else {
    // Скрываем dropdown
    keywordsDropdown.hidden = true;
  }
});

keywordsCloseBtn?.addEventListener('click', () => {
  keywordsDropdown.hidden = true;
});

// Закрыть dropdown при клике вне его
document.addEventListener('click', (e) => {
  if (!keywordsDropdown.hidden && 
      !keywordsDropdown.contains(e.target) && 
      e.target !== keywordsBtn) {
    keywordsDropdown.hidden = true;
  }
});

async function loadKeywords() {
  try {
    const res = await api('/api/sourcing/load-keywords');
    if (res.keywords?.length) {
      keywordsContent.innerHTML = res.keywords
        .map(kw => `<div class="keyword-item">${kw}</div>`)
        .join('');
      keywordsLoaded = true;
    } else {
      keywordsContent.innerHTML = '<div class="keyword-item empty">Файл ключевых слов пуст</div>';
      keywordsLoaded = true;
    }
  } catch (e) {
    keywordsContent.innerHTML = `<div class="keyword-item empty">Ошибка загрузки: ${e.message}</div>`;
  }
}

// Sourcing - запускаем сразу без модалки
let sourcingPollInterval = null;

document.querySelector('.btn-sourcing')?.addEventListener('click', async () => {
  // Проверяем не запущен ли уже sourcing
  try {
    const currentProgress = await api('/api/sourcing/progress');
    if (currentProgress.active) {
      showToast('Sourcing уже запущен! Дождитесь завершения.', 'neutral');
      return;
    }
  } catch (e) {
    // Игнорируем ошибки проверки
  }

  // Загружаем ключевые слова из файла
  let keywords;
  try {
    const res = await api('/api/sourcing/load-keywords');
    if (!res.keywords?.length) {
      showToast('Файл ключевых слов пуст или не найден', 'neutral');
      return;
    }
    keywords = res.keywords;
  } catch (e) {
    showToast(`Ошибка загрузки ключей: ${e.message}`, 'bad');
    return;
  }

  // Показываем прогресс-бар
  const progressWrap = document.querySelector('.sourcing-progress-wrap');
  const progressFill = document.querySelector('.sourcing-progress-fill');
  const progressText = document.querySelector('.sourcing-progress-text');
  if (progressWrap) progressWrap.hidden = false;
  if (progressFill) progressFill.style.width = '0%';
  if (progressText) progressText.textContent = `0/${keywords.length}`;

  // Запускаем процесс
  const scanLimit = 10; // default
  
  try {
    const sourcingBtn = document.querySelector('.btn-sourcing');
    sourcingBtn.disabled = true;
    sourcingBtn.textContent = '⏳ Поиск...';
    
    const res = await api('/api/sourcing/start', {
      method: 'POST',
      body: JSON.stringify({ keywords, scanLimit }),
    });
    showToast(`Sourcing запущен: ${keywords.length} запросов`, 'good');

    // Запускаем polling прогресса
    startSourcingPolling(keywords.length, sourcingBtn);
  } catch (e) {
    showToast(`Ошибка sourcing: ${e.message}`, 'bad');
    if (progressWrap) progressWrap.hidden = true;
    const sourcingBtn = document.querySelector('.btn-sourcing');
    sourcingBtn.disabled = false;
    sourcingBtn.textContent = '🔍 Sourcing';
  }
});
const applyLogModalEl = document.getElementById('apply-log-modal');
applyLogModalEl?.querySelector('[data-close-apply-log]')?.addEventListener('click', closeApplyLogModal);
applyLogModalEl?.querySelector('.modal-close--apply-log')?.addEventListener('click', closeApplyLogModal);
applyLogModalEl?.querySelector('.btn-refresh-apply-log')?.addEventListener('click', () => refreshApplyLogModal());

function startSourcingPolling(total, sourcingBtn) {
  // Очищаем предыдущий интервал если есть
  if (sourcingPollInterval) {
    clearInterval(sourcingPollInterval);
  }

  const progressFill = document.querySelector('.sourcing-progress-fill');
  const progressText = document.querySelector('.sourcing-progress-text');

  // Polling каждые 2 секунды
  sourcingPollInterval = setInterval(async () => {
    try {
      const progress = await api('/api/sourcing/progress');
      
      if (progressFill) {
        progressFill.style.width = `${progress.percent}%`;
      }
      if (progressText) {
        // Показываем вакансии: обработано/всего
        progressText.textContent = `${progress.completed}/${progress.total}`;
      }

      // Если завершено - обновляем страницу
      if (!progress.active && progress.percent === 100) {
        clearInterval(sourcingPollInterval);
        sourcingPollInterval = null;
        
        showToast(`Sourcing завершён! Найдено ${progress.total} вакансий`, 'good');
        
        // Включаем кнопку обратно
        if (sourcingBtn) {
          sourcingBtn.disabled = false;
          sourcingBtn.textContent = '🔍 Sourcing';
        }
        
        // Скрываем прогресс-бар через 2 секунды и обновляем страницу
        const progressWrap = document.querySelector('.sourcing-progress-wrap');
        setTimeout(() => {
          if (progressWrap) progressWrap.hidden = true;
          // Автообновление страницы
          window.location.reload();
        }, 2000);
      }
    } catch (e) {
      console.error('Ошибка polling прогресса:', e);
    }
  }, 2000);
}

approvedModalEl?.querySelector('.btn-copy-approved')?.addEventListener('click', async () => {
  const pre = approvedModalEl.querySelector('.modal-approved-text');
  const t = pre?.textContent || '';
  try {
    await navigator.clipboard.writeText(t);
    showToast('Скопировано в буфер', 'good');
  } catch {
    showToast('Не удалось скопировать', 'bad');
  }
});

function bindDismiss(node, item) {
  const dismissBtn = node.querySelector('.card-dismiss');
  if (!dismissBtn) return;
  dismissBtn.addEventListener('click', async () => {
    if (!confirm('Удалить эту запись из очереди? (без «подходит / не подходит»)')) return;
    dismissBtn.disabled = true;
    try {
      await api('/api/dismiss', {
        method: 'POST',
        body: JSON.stringify({ id: item.id }),
      });
      showToast('Запись удалена из очереди', 'neutral');
      invalidateCache();
      await load();
    } catch (e) {
      alert(e.message);
      dismissBtn.disabled = false;
    }
  });
}

function renderCard(item) {
  const node = tpl.content.firstElementChild.cloneNode(true);

  bindDismiss(node, item);

  const scoreEl = node.querySelector('.score');
  const overall = item.scoreOverall ?? item.geminiScore;
  const displayOverall = overall != null && overall !== '' ? String(overall) : '—';
  scoreEl.textContent = displayOverall;
  scoreEl.setAttribute(
    'aria-label',
    displayOverall === '—'
      ? 'Нет скора'
      : `Итоговый балл ${displayOverall}, наведи для расшифровки`
  );

  const tooltip = node.querySelector('.score-tooltip');
  const wv = scoreWeights.vacancy;
  const wc = scoreWeights.cvMatch;
  const sv = item.scoreVacancy;
  const scm = item.scoreCvMatch;
  const so = item.scoreOverall ?? item.geminiScore;
  if (Number.isFinite(Number(sv)) && Number.isFinite(Number(scm))) {
    tooltip.innerHTML = [
      '<strong>Вакансия</strong> (оценка модели): ',
      String(sv),
      '<br><strong>Сходство с твоими CV</strong>: ',
      String(scm),
      '<br><strong>Итог на карточке</strong>: ',
      so != null && so !== '' ? String(so) : '—',
      '<br><br>Если модель не вернула свой <code>scoreOverall</code>, итог считается как ',
      `<code>${wv.toFixed(2)}×</code>вакансия + <code>${wc.toFixed(2)}×</code>CV (веса из preferences.json).`,
    ].join('');
  } else {
    tooltip.textContent =
      'Нет разбивки по компонентам. Добавь записи через npm run harvest с включённым LLM (без --skip-llm).';
  }

  const modelBtn = node.querySelector('.model-info-btn');
  const modelPanel = node.querySelector('.model-info-panel');
  const modelName = item.openRouterModel ? String(item.openRouterModel).trim() : '';
  if (modelName) {
    modelBtn.hidden = false;
    modelPanel.textContent = `Модель OpenRouter: ${modelName}`;
    modelPanel.addEventListener('click', (e) => e.stopPropagation());
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = modelPanel.hidden;
      document.querySelectorAll('.model-info-panel').forEach((p) => {
        p.hidden = true;
      });
      if (open) modelPanel.hidden = false;
    });
  }

  const a = node.querySelector('.title-link');
  a.href = item.url;
  a.textContent = item.title || item.url;

  const meta = node.querySelector('.meta');
  const parts = [
    item.company,
    item.salaryRaw,
    item.salaryEstimate?.ok ? `≈${item.salaryEstimate.minUsd}–${item.salaryEstimate.maxUsd} USD/мес` : '',
    item.searchQuery ? `запрос: ${item.searchQuery}` : '',
  ].filter(Boolean);
  meta.textContent = parts.join(' · ');

  // Workplace type badges (может быть несколько)
  const workplaceBadges = node.querySelector('.workplace-badges');
  workplaceBadges.innerHTML = '';
  const workplaceTypes = item.workplaceType || ['не указано'];
  const types = Array.isArray(workplaceTypes) ? workplaceTypes : [workplaceTypes];
  for (const wt of types) {
    const badge = document.createElement('span');
    badge.className = 'workplace-badge';
    badge.setAttribute('data-workplace-type', wt);
    badge.textContent = wt.charAt(0).toUpperCase() + wt.slice(1);
    workplaceBadges.appendChild(badge);
  }

  // Language row
  const langRow = node.querySelector('.language-row');
  const langBadge = node.querySelector('.language-badge');
  const englishLevel = item.englishLevel;
  if (englishLevel) {
    langRow.hidden = false;
    langBadge.setAttribute('data-level', englishLevel);
    langBadge.textContent = englishLevel;
  } else {
    langRow.hidden = true;
  }

  node.querySelector('.summary').textContent = item.geminiSummary || '';
  const risks = node.querySelector('.risks');
  risks.textContent = item.geminiRisks ? `Нюансы: ${item.geminiRisks}` : '';
  risks.hidden = !item.geminiRisks;

  const tags = node.querySelector('.tags');
  (item.geminiTags || []).forEach((t) => {
    const s = document.createElement('span');
    s.className = 'tag';
    s.textContent = t;
    tags.appendChild(s);
  });

  const cl = item.coverLetter;
  const draftBtn = node.querySelector('.cover-draft-btn');
  const regenBtn = node.querySelector('.btn-regenerate-letter');
  const viewLetterBtn = node.querySelector('.btn-view-approved');

  if (cl?.status === 'pending' && (cl?.variants || []).length) {
    draftBtn.hidden = false;
    draftBtn.addEventListener('click', () => openDraftModal(item));
  }

  if (cl?.status === 'declined') {
    regenBtn.hidden = false;
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      try {
        await requestCoverLetterGenerate(item.id, false);
        showToast('Новые варианты готовы', 'good');
        invalidateCache();
        await load();
      } catch (e) {
        if (e.status === 409) {
          const ok = confirm(
            'Уже есть утверждённое письмо. Пересоздать и заменить черновиком?'
          );
          if (ok) {
            try {
              await requestCoverLetterGenerate(item.id, true);
              showToast('Новые варианты готовы', 'good');
              invalidateCache();
              await load();
            } catch (e2) {
              alert(e2.message);
            }
          }
        } else {
          alert(e.message);
        }
      } finally {
        regenBtn.disabled = false;
      }
    });
  }

  if (cl?.status === 'approved' && String(cl?.approvedText || '').trim()) {
    viewLetterBtn.hidden = false;
    viewLetterBtn.addEventListener('click', () => openApprovedLetterModal(item));
  }

  const applyChatBtn = node.querySelector('.btn-apply-chat');
  const approvedLetter =
    cl?.status === 'approved' && String(cl?.approvedText || '').trim();
  if (approvedLetter) {
    applyChatBtn.disabled = false;
    applyChatBtn.removeAttribute('title');
    applyChatBtn.addEventListener('click', async () => {
      applyChatBtn.disabled = true;
      try {
        const res = await api('/api/hh-launch-apply-chat', {
          method: 'POST',
          body: JSON.stringify({ id: item.id }),
        });
        const pid = res.pid != null ? ` PID ${res.pid}.` : '';
        const logHint = res.logFile ? ` Лог: ${res.logFile}` : '';
        showToast(
          `Запущен Chromium (отдельный процесс).${pid}${logHint} Лог отклика открыт — обновляется каждые 2.5 с.`,
          'neutral'
        );
        openApplyLogModal();
      } catch (e) {
        alert(e.message);
      } finally {
        applyChatBtn.disabled = false;
      }
    });
  }

  const actions = node.querySelector('.actions');
  const doneReason = node.querySelector('.done-reason');

  if (item.status === 'pending') {
    actions.hidden = false;
    const ta = actions.querySelector('.reason');
    const ok = actions.querySelector('.ok');
    const bad = actions.querySelector('.bad');
    const coverBtn = actions.querySelector('.btn-cover');
    const refreshBtn = actions.querySelector('.btn-refresh-vacancy');

    coverBtn.addEventListener('click', async () => {
      coverBtn.disabled = true;
      refreshBtn.disabled = true;
      try {
        await requestCoverLetterGenerate(item.id, false);
        showToast('Сопроводительное сгенерировано', 'good');
        invalidateCache();
        await load();
      } catch (e) {
        if (e.status === 409) {
          const confirmed = confirm(
            'Письмо уже утверждено. Пересоздать черновик? (утверждённый текст будет сброшен до нового согласования)'
          );
          if (confirmed) {
            try {
              await requestCoverLetterGenerate(item.id, true);
              showToast('Новые варианты готовы', 'good');
              invalidateCache();
              await load();
            } catch (e2) {
              alert(e2.message);
            }
          }
        } else {
          alert(e.message);
        }
      } finally {
        coverBtn.disabled = false;
        refreshBtn.disabled = false;
      }
    });

    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      coverBtn.disabled = true;
      ok.disabled = true;
      bad.disabled = true;
      try {
        const refreshRes = await api('/api/vacancy/refresh-body', {
          method: 'POST',
          body: JSON.stringify({ id: item.id }),
        });
        if (refreshRes.scoreUpdated) {
          showToast('Текст с hh.ru и оценка (OpenRouter) обновлены', 'good');
        } else if (refreshRes.scoreError) {
          showToast(`Текст обновлён с hh.ru. Оценка: ${refreshRes.scoreError}`, 'neutral');
        } else {
          showToast('Текст вакансии обновлён с hh.ru', 'good');
        }
        invalidateCache();
        await load();
      } catch (e) {
        alert(e.message);
        refreshBtn.disabled = false;
        coverBtn.disabled = false;
        ok.disabled = false;
        bad.disabled = false;
      }
    });

    const send = async (action) => {
      ok.disabled = bad.disabled = true;
      try {
        await api('/api/action', {
          method: 'POST',
          body: JSON.stringify({
            id: item.id,
            action,
            reason: ta.value.trim(),
          }),
        });
        if (action === 'approve') {
          showToast('Сохранено: подходит', 'good');
        } else {
          showToast('Сохранено: не подходит', 'bad');
        }
        invalidateCache();
        await load();
      } catch (e) {
        alert(e.message);
        ok.disabled = bad.disabled = false;
      }
    };
    ok.addEventListener('click', () => send('approve'));
    bad.addEventListener('click', () => send('reject'));
  } else {
    doneReason.textContent = item.feedbackReason
      ? `Комментарий: ${item.feedbackReason}`
      : '';
  }

  return node;
}

function syncVacancyTabs() {
  vacancyTabsEl.querySelectorAll('.tab').forEach((b) => {
    const status = b.dataset.status;
    const count = vacancyCounts[status] ?? 0;
    const baseLabel = b.dataset.baseLabel || b.textContent.replace(/\s*\(\d+\)\s*$/, '');
    if (!b.dataset.baseLabel) b.dataset.baseLabel = baseLabel;
    b.textContent = `${baseLabel} (${count})`;
    b.classList.toggle('active', status === currentStatus);
  });
}

async function load(forceRefresh = false) {
  listEl.innerHTML = '';
  try {
    try {
      const { preferences } = await api('/api/preferences');
      const w = preferences?.llmScoreWeights;
      if (w) {
        let v = Number(w.vacancy);
        let c = Number(w.cvMatch);
        if (Number.isFinite(v) && Number.isFinite(c) && v + c > 0) {
          const sum = v + c;
          scoreWeights = { vacancy: v / sum, cvMatch: c / sum };
        }
      }
    } catch {
      scoreWeights = { vacancy: 0.35, cvMatch: 0.65 };
    }

    // Если есть кэш для текущего статуса и не требуется обновление — используем его
    if (!forceRefresh && cachedItems[currentStatus] !== null) {
      const items = cachedItems[currentStatus];
      vacancyCounts[currentStatus] = items.length;
      // Обновляем счётчики для остальных статусов из кэша если есть
      for (const status of ['pending', 'approved', 'rejected']) {
        if (cachedItems[status] !== null && status !== currentStatus) {
          vacancyCounts[status] = cachedItems[status].length;
        }
      }
      if (!items.length) {
        listEl.innerHTML = '<p class="empty">Пусто.</p>';
        syncVacancyTabs();
        return;
      }
      items.forEach((it) => listEl.appendChild(renderCard(it)));
      syncVacancyTabs();
      return;
    }

    // Загружаем все записи параллельно для подсчёта + отображения
    const allData = await Promise.all(
      ['pending', 'approved', 'rejected'].map((status) =>
        api(`/api/vacancies?status=${encodeURIComponent(status)}`).then(({ items }) => ({ status, items }))
      )
    );

    // Обновляем кэш и счётчики
    for (const { status, items } of allData) {
      cachedItems[status] = items;
      vacancyCounts[status] = items.length;
    }

    // Отображаем текущую вкладку
    const currentData = allData.find((d) => d.status === currentStatus);
    const { items } = currentData;
    if (!items.length) {
      listEl.innerHTML = '<p class="empty">Пусто.</p>';
      syncVacancyTabs();
      return;
    }
    items.forEach((it) => listEl.appendChild(renderCard(it)));
    syncVacancyTabs();
  } catch (e) {
    listEl.innerHTML = `<p class="err">${e.message}</p>`;
  }
}

vacancyTabsEl.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    vacancyTabsEl.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentStatus = btn.dataset.status;
    // Если данные уже в кэше — отображаем сразу, иначе загружаем
    if (cachedItems[currentStatus] !== null) {
      listEl.innerHTML = '';
      const items = cachedItems[currentStatus];
      if (!items.length) {
        listEl.innerHTML = '<p class="empty">Пусто.</p>';
        syncVacancyTabs();
        return;
      }
      items.forEach((it) => listEl.appendChild(renderCard(it)));
      syncVacancyTabs();
    } else {
      load();
    }
  });
});

syncVacancyTabs();

// Проверка активного sourcing при загрузке
async function checkActiveSourcing() {
  try {
    const progress = await api('/api/sourcing/progress');
    
    if (progress.active && progress.total > 0) {
      // Sourcing ещё идёт - показываем прогресс
      const progressWrap = document.querySelector('.sourcing-progress-wrap');
      const progressFill = document.querySelector('.sourcing-progress-fill');
      const progressText = document.querySelector('.sourcing-progress-text');
      const sourcingBtn = document.querySelector('.btn-sourcing');

      if (progressWrap) progressWrap.hidden = false;
      if (progressFill) progressFill.style.width = `${progress.percent}%`;
      if (progressText) progressText.textContent = `${progress.completed}/${progress.total}`;
      
      // Отключаем кнопку и меняем текст
      if (sourcingBtn) {
        sourcingBtn.disabled = true;
        sourcingBtn.textContent = '⏳ Поиск...';
      }

      // Возобновляем polling
      startSourcingPolling(progress.total, sourcingBtn);
    }
  } catch (e) {
    // Игнорируем ошибки при проверке
    console.error('Ошибка проверки активного sourcing:', e);
  }
}
load();
