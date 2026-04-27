const listEl = document.getElementById('list');
const tpl = document.getElementById('card-tpl');

const vacancyTabsEl = document.querySelector('.tabs-underlined');

let currentStatus = 'pending';
let currentSearchQuery = '';

/** Нормализованные веса для подсказки к скору (как в lib/openrouter-score.mjs) */
let scoreWeights = { vacancy: 0.35, cvMatch: 0.65 };

/** @type {{ id: string, variants: string[], selectedIndex: number } | null} */
let draftModalState = null;

/** @type {ReturnType<typeof setInterval> | null} */
let applyLogRefreshTimer = null;

/** Счётчики по статусам */
let vacancyCounts = { manual: 0, pending: 0, approved: 0, rejected: 0 };

/** Кэш записей по статусам */
let cachedItems = { manual: null, pending: null, approved: null, rejected: null };

/** Состояние для批量ного обновления секции */
let bulkRefreshState = {
active: false,
total: 0,
completed: 0,
};

const BATCH_LIMIT = 20;

/** Сброс кэша — требует перезагрузки при следующем load() */
function invalidateCache() {
  cachedItems = { manual: null, pending: null, approved: null, rejected: null };
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

function needsVacancyBodyRefresh(item) {
const desc = item.descriptionPreview || '';
return desc.trim().length < 80;
}

function getIncompleteCount(items) {
return (items || []).filter(needsVacancyBodyRefresh).length;
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
  const scanLimit = 30; // global limit per session
  
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
    sourcingBtn.textContent = 'Sourcing';
  }
});

// Add Vacancy from clipboard
let addVacancyPollInterval = null;

function resetAddProgress() {
  const fill = document.querySelector('.add-vacancy-progress-fill');
  const text = document.querySelector('.add-vacancy-progress-text');
  if (fill) fill.style.width = '0%';
  if (text) text.textContent = '';
}

function showAddProgress(percent, message) {
 const wrap = document.querySelector('.add-vacancy-progress-wrap');
 if (wrap) wrap.hidden = false;
 const fill = document.querySelector('.add-vacancy-progress-fill');
 const text = document.querySelector('.add-vacancy-progress-text');
 if (fill) fill.style.width = `${percent}%`;
 if (text) text.textContent = message || '';
}

function hideAddProgress() {
  const wrap = document.querySelector('.add-vacancy-progress-wrap');
  if (wrap) wrap.hidden = true;
  resetAddProgress();
}

async function focusAddedVacancy(recordId, url, highlight = true, targetStatus = 'manual') {
  const statusToOpen = ['manual', 'pending', 'approved', 'rejected'].includes(targetStatus)
    ? targetStatus
    : 'approved';

  if (currentSearchQuery) {
    clearSearch();
  }

  if (currentStatus !== statusToOpen) {
    vacancyTabsEl.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    const approvedTab = vacancyTabsEl.querySelector(`[data-status="${statusToOpen}"]`);
    if (approvedTab) approvedTab.classList.add('active');
    currentStatus = statusToOpen;
    listEl.innerHTML = '';
  }

  invalidateCache();
  await load(true);

  const selector = recordId
    ? `[data-record-id="${recordId}"]`
    : `[data-vacancy-url="${url}"]`;
  const newCard = document.querySelector(selector);
  if (!newCard) return;
  newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!highlight) return;
  newCard.classList.add('card--new-highlight');
  setTimeout(() => newCard.classList.remove('card--new-highlight'), 2000);
}

/** Clipboard-add state: recordId of vacancy being added from clipboard */
let clipboardAddRecordId = null;

document.querySelector('.btn-add-vacancy')?.addEventListener('click', async () => {
  const btn = document.querySelector('.btn-add-vacancy');
  btn.disabled = true;

  let clipboardText;
  try {
    clipboardText = await navigator.clipboard.readText();
  } catch (e) {
    showToast('Не удалось прочитать буфер обмена. Дайте разрешение браузера на доступ к буферу.', 'bad');
    btn.disabled = false;
    return;
  }

  const trimmed = clipboardText.trim();
  if (!trimmed) {
    showToast('Буфер обмена пуст', 'bad');
    btn.disabled = false;
    return;
  }

  if (!/^https?:\/\/([^.]+\.)?hh\.ru\/vacancy\/\d+(?:[/?#].*)?$/i.test(trimmed)) {
    showToast('Ссылка не похожа на вакансию hh.ru: ' + trimmed.slice(0, 60), 'bad');
    btn.disabled = false;
    return;
  }

  try {
    const res = await api('/api/vacancy/add-from-clipboard', {
      method: 'POST',
      body: JSON.stringify({ url: trimmed }),
    });

    // Switch to manual tab immediately and show the form with the URL
    vacancyTabsEl.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    const manualTab = vacancyTabsEl.querySelector('[data-status="manual"]');
    if (manualTab) manualTab.classList.add('active');
    currentStatus = 'manual';
    listEl.innerHTML = '';

    // Pre-fill URL and start polling
    clipboardAddRecordId = res.id;
    manualTabState.vacancyId = res.id;
    manualTabState.url = trimmed;
    manualTabState.parsing = true;
    manualTabState.error = null;
    manualTabState.variants = null;
    manualTabState.selectedVariant = 0;

    renderManualTabUI();
    // Populate the URL in the input field
    const urlInput = document.getElementById('manual-url');
    if (urlInput) urlInput.value = trimmed;

    showToast('Вакансия загружается…', 'good');
    startAddVacancyPolling(trimmed, res.id);
  } catch (e) {
    if (e.status === 409 && e.payload?.recordId) {
      // Vacancy already exists — switch to its tab
      vacancyTabsEl.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      const tabToOpen = vacancyTabsEl.querySelector(`[data-status="${e.payload.status}"]`);
      if (tabToOpen) tabToOpen.classList.add('active');
      currentStatus = e.payload.status;
      invalidateCache();
      await load(true);
      showToast('Эта вакансия уже есть в очереди', 'neutral');
    } else {
      showToast(`Ошибка: ${e.message}`, 'bad');
    }
    btn.disabled = false;
  }
});

function startAddVacancyPolling(url, recordId) {
  if (addVacancyPollInterval) {
    clearInterval(addVacancyPollInterval);
  }

  const vacancyIdFromUrl = (u) => {
    const m = u.match(/hh\.ru\/vacancy\/(\d+)/);
    return m ? m[1] : null;
  };
  const expectedVacancyId = vacancyIdFromUrl(url);

  showAddProgress(5, 'Запуск…');

  addVacancyPollInterval = setInterval(async () => {
    try {
      const progress = await api('/api/vacancy/add-progress');

      // Debug log
      console.log('[add-vacancy poll]', JSON.stringify(progress));

      if (progress.percent != null) {
        showAddProgress(progress.percent, progress.message || `${progress.percent}%`);
      }

      if (progress.vacancyId && progress.vacancyId !== expectedVacancyId) {
        clearInterval(addVacancyPollInterval);
        addVacancyPollInterval = null;
        hideAddProgress();
        const btn = document.querySelector('.btn-add-vacancy');
        btn.disabled = false;
        return;
      }

  if (progress.step === 'saving' && progress.percent === 100) {
  clearInterval(addVacancyPollInterval);
  addVacancyPollInterval = null;
  hideAddProgress();

  setTimeout(async () => {
    showToast('Вакансия загружена', 'good');
    const btn = document.querySelector('.btn-add-vacancy');
    btn.disabled = false;

    // Reload manual tab data and show the vacancy
    invalidateCache();
    const items = await api('/api/vacancies?status=manual').then(r => r.items || []);
    const item = items.find(x => x.id === recordId) || items.find(x => x.url === url);
    if (item) {
      // Only update if we're still on the manual tab and the record matches
      if (currentStatus === 'manual') {
        setManualVacancy(item);
        renderManualTabUI();
        populateManualVacancySection(item);
      }
      await runManualCoverLetterGeneration(item.id, {
        fallbackUrl: url,
        successMessage: 'Письмо сгенерировано автоматически',
      });
    }
  }, 400);

  return;
 }

if (progress.error) {
  clearInterval(addVacancyPollInterval);
  addVacancyPollInterval = null;
  hideAddProgress();
  showToast(`Ошибка: ${progress.error}`, 'bad');
  const btn = document.querySelector('.btn-add-vacancy');
  btn.disabled = false;
 }

} catch (e) {
    console.error('Polling error:', e);
  }
}, 500);
}

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
      progressText.textContent = progress.total > 0 ? `${progress.completed}/${progress.total}` : `${progress.completed}`;
    }

// Если завершено - обновляем страницу
    if (!progress.active) {
        clearInterval(sourcingPollInterval);
        sourcingPollInterval = null;
        
        showToast(`Sourcing завершён! Найдено ${progress.total} вакансий`, 'good');
        
        // Включаем кнопку обратно
if (sourcingBtn) {
      sourcingBtn.disabled = false;
      sourcingBtn.textContent = 'Sourcing';
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

if (item.url) {
  node.dataset.vacancyUrl = item.url;
}
if (item.id) {
  node.dataset.recordId = item.id;
}

return node;
}

function onSearchInput(e) {
  const query = e.target.value.trim();
  currentSearchQuery = query;
  const clearBtn = document.getElementById('vacancy-search-clear');
  if (clearBtn) clearBtn.hidden = !query;
  renderVacancyList();
}

function clearSearch() {
  currentSearchQuery = '';
  const input = document.getElementById('vacancy-search');
  if (input) input.value = '';
  const clearBtn = document.getElementById('vacancy-search-clear');
  if (clearBtn) clearBtn.hidden = true;
  renderVacancyList();
}

/** UI для раздела "Вручную" — всегда-visible форма с отображением текущей вакансии */
let manualTabState = {
  /** @type {string|null} current vacancy record id */
  vacancyId: null,
  /** @type {string|null} current vacancy URL */
  url: null,
  /** @type {string[]} letter variants */
  variants: null,
  /** @type {number} selected variant index */
  selectedVariant: 0,
  /** @type {boolean} whether parsing is in progress */
  parsing: false,
  /** @type {string|null} error message */
  error: null,
};

function setManualVacancy(item) {
  if (!item) {
    manualTabState = { vacancyId: null, url: null, variants: null, selectedVariant: 0, parsing: false, error: null };
    return;
  }
  manualTabState.vacancyId = item.id;
  manualTabState.url = item.url;
  manualTabState.selectedVariant = 0;
  manualTabState.error = null;
  // If vacancy already has letter variants, use them
  if (item.coverLetter?.variants?.length) {
    manualTabState.variants = item.coverLetter.variants;
  } else if (item.coverLetter?.approvedText) {
    manualTabState.variants = [item.coverLetter.approvedText];
  } else {
    manualTabState.variants = null;
  }
}

function renderManualTabUI() {
  const { vacancyId, url, variants, selectedVariant, parsing, error } = manualTabState;

  const hasVacancy = !!vacancyId;
  const hasVariants = !!(variants && variants.length);

  // Ensure we always have 3 variants for radio buttons display
  const displayVariants = hasVariants
    ? variants.slice(0, 3)
    : ['', '', ''];
  while (displayVariants.length < 3) {
    displayVariants.push('');
  }

  listEl.innerHTML = `
    <div class="manual-container">
      <!-- Блок 0: Ввод URL -->
      <div class="manual-input-section">
        <label class="manual-label" for="manual-url">Ссылка на вакансию hh.ru</label>
        <div class="manual-input-row">
          <input
            type="url"
            id="manual-url"
            class="manual-url-input"
            placeholder="https://hh.ru/vacancy/12345678"
            value="${url || ''}"
            ${parsing ? 'disabled' : ''}
          />
          <button type="button" class="btn btn-load-vacancy" id="btn-load-vacancy" ${parsing ? 'disabled' : ''}>
            ${parsing ? 'Загрузка…' : 'Загрузить'}
          </button>
        </div>
        ${error ? `<p class="manual-error">${error}</p>` : ''}
      </div>

      <div class="manual-vacancy-section" id="manual-vacancy-section">
        <!-- Блок 1: Заголовок + Скор (скор в правом верхнем углу) -->
        <div class="manual-header-row">
          <div class="manual-title-block">
            <h2 class="manual-page-title">Вручную</h2>
            <h3 class="manual-vacancy-title">${hasVacancy ? '' : '<span class="manual-placeholder">Вставьте ссылку и нажмите «Загрузить»</span>'}</h3>
          </div>
          <div class="manual-score-block" id="manual-score-block" ${hasVacancy ? '' : 'hidden'}>
            <div class="score-row">
              <div class="score-hover-wrap">
                <span class="score" tabindex="0" id="manual-score">—</span>
                <div class="score-tooltip" role="tooltip" id="manual-score-tooltip"></div>
              </div>
              <div class="model-info-wrap">
                <button type="button" class="model-info-btn" id="manual-model-btn" hidden aria-label="Какая модель оценивала">i</button>
                <div class="model-info-panel" id="manual-model-panel" hidden></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Блок 2: Мета-информация -->
        <div class="manual-meta-block">
          <a class="manual-vacancy-link title-link" target="_blank" rel="noopener" ${hasVacancy ? '' : 'hidden'}></a>
          <p class="manual-vacancy-meta meta"></p>
          <div class="manual-badges" id="manual-badges"></div>
          <div class="manual-tags tags" id="manual-tags"></div>
        </div>

        <!-- Блок 3: Описание вакансии -->
        <div class="manual-description" id="manual-description">
          <div class="manual-description-label">Описание вакансии</div>
          <div class="manual-trigger-phrase" id="manual-trigger-phrase" hidden></div>
          <div class="manual-description-text"></div>
        </div>

        <!-- Блок 4: Выбор варианта письма (радио-кнопки как в модалке) -->
        <div class="manual-variants-section" id="manual-variants-section">
          <div class="manual-variants-row">
            <fieldset class="modal-draft-fieldset" id="manual-variant-fieldset" ${hasVariants ? '' : 'disabled'}>
              <legend>Вариант</legend>
              ${displayVariants.map((_, i) => `
                <div class="modal-draft-variant-row">
                  <input
                    type="radio"
                    name="manual-variant"
                    id="manual-variant-${i}"
                    value="${i}"
                    ${i === selectedVariant ? 'checked' : ''}
                    ${hasVariants ? '' : 'disabled'}
                  />
                  <label for="manual-variant-${i}">Вариант ${i + 1}</label>
                </div>
              `).join('')}
            </fieldset>
            <button type="button" class="btn btn-generate-letter" id="btn-generate-letter" ${hasVacancy ? '' : 'disabled'}>
              ${hasVacancy ? 'Сгенерировать письмо' : 'Сначала загрузите вакансию'}
            </button>
          </div>
        </div>

        <!-- Блок 5: Редактирование письма (textarea как в модалке) -->
        <div class="manual-letter-edit-section" id="manual-letter-edit-section">
          <label class="modal-letter-label" for="manual-letter-textarea">
            Текст (правки сохраняются и учитываются при следующей генерации)
          </label>
          <textarea
            class="modal-letter-edit"
            id="manual-letter-textarea"
            rows="12"
            ${hasVariants ? '' : 'disabled'}
          >${hasVariants ? (variants[selectedVariant] || '') : ''}</textarea>

          <!-- Причина отклонения (скрыта по умолчанию) -->
          <div class="manual-decline-reason" id="manual-decline-reason" hidden>
            <label class="manual-decline-label" for="manual-decline-textarea">Причина отклонения</label>
            <textarea
              class="manual-decline-textarea"
              id="manual-decline-textarea"
              rows="3"
              placeholder="Укажите причину отклонения..."
            ></textarea>
            <div class="manual-decline-actions">
              <button type="button" class="btn ok" id="btn-confirm-decline">Подтвердить отклонение</button>
              <button type="button" class="btn" id="btn-cancel-decline">Отмена</button>
            </div>
          </div>

          <!-- Кнопки действий с письмом -->
          <div class="modal-draft-actions manual-letter-actions" id="manual-letter-actions">
            <button type="button" class="btn" id="btn-save-draft" ${hasVariants ? '' : 'disabled'}>Сохранить правки</button>
            <button type="button" class="btn ok" id="btn-approve-letter" ${hasVariants ? '' : 'disabled'}>Утвердить</button>
            <button type="button" class="btn bad" id="btn-decline-letter" ${hasVariants ? '' : 'disabled'}>Отклонить</button>
          </div>
        </div>

        <!-- Блок 6: Финальные действия -->
        <div class="manual-finish-section">
          <button type="button" class="btn btn-clear" id="btn-clear-manual">
            Очистить
          </button>
        </div>
      </div>
    </div>
  `;

  initManualTabHandlers();
}

/** Populate manual vacancy section with vacancy data (called after data loads) */
function populateManualVacancySection(item) {
  setManualVacancy(item);

  const section = document.getElementById('manual-vacancy-section');
  if (!section) {
    // Re-render to show vacancy section
    renderManualTabUI();
    populateManualVacancySection(item);
    return;
  }

  // ===== Блок 1: Заголовок + Скор =====

  // Title
  const titleEl = section.querySelector('.manual-vacancy-title');
  if (titleEl) titleEl.textContent = item.title || 'Без названия';

  // Score block (в правом верхнем углу)
  const scoreBlockEl = document.getElementById('manual-score-block');
  const scoreEl = document.getElementById('manual-score');
  const tooltipEl = document.getElementById('manual-score-tooltip');
  const modelBtn = document.getElementById('manual-model-btn');
  const modelPanel = document.getElementById('manual-model-panel');

  if (scoreBlockEl) scoreBlockEl.hidden = false;

  const overall = item.scoreOverall ?? item.geminiScore;
  const displayOverall = overall != null && overall !== '' ? String(overall) : '—';

  if (scoreEl) {
    scoreEl.textContent = displayOverall;
    // Color coding based on score
    scoreEl.className = 'score';
    if (overall != null && overall !== '') {
      const numScore = Number(overall);
      if (numScore > 75) scoreEl.style.background = 'var(--good)';
      else if (numScore >= 50) scoreEl.style.background = '#e8b923'; // yellow
      else scoreEl.style.background = 'var(--bad)';
    }
  }

  // Tooltip with breakdown
  if (tooltipEl) {
    const wv = scoreWeights.vacancy;
    const wc = scoreWeights.cvMatch;
    const sv = item.scoreVacancy;
    const scm = item.scoreCvMatch;
    const so = item.scoreOverall ?? item.geminiScore;

    if (Number.isFinite(Number(sv)) && Number.isFinite(Number(scm))) {
      tooltipEl.innerHTML = [
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
      tooltipEl.textContent = 'Нет разбивки по компонентам.';
    }
  }

  // Model info button
  if (modelBtn && modelPanel) {
    const modelName = item.openRouterModel ? String(item.openRouterModel).trim() : '';
    if (modelName) {
      modelBtn.hidden = false;
      modelPanel.textContent = `Модель OpenRouter: ${modelName}`;
    } else {
      modelBtn.hidden = true;
    }
  }

  // ===== Блок 2: Мета-информация =====

  // Link
  const linkEl = section.querySelector('.manual-vacancy-link');
  if (linkEl) {
    linkEl.href = item.url || '#';
    linkEl.textContent = item.title || item.url;
    linkEl.hidden = false;
  }

  // Meta: company · salary · country
  const metaEl = section.querySelector('.manual-vacancy-meta');
  if (metaEl) {
    const parts = [
      item.company,
      item.salaryRaw,
      item.area?.name || item.location,
    ].filter(Boolean);
    metaEl.textContent = parts.join(' · ');
  }

  // Badges
  const badgesEl = document.getElementById('manual-badges');
  if (badgesEl) {
    badgesEl.innerHTML = '';

    // Employment format
    if (item.employment) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--employment';
      badge.textContent = item.employment;
      badgesEl.appendChild(badge);
    }

    // Workplace type
    const types = Array.isArray(item.workplaceType) ? item.workplaceType : [item.workplaceType || 'не указано'];
    for (const wt of types) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--workplace';
      badge.setAttribute('data-workplace-type', wt);
      badge.textContent = wt.charAt(0).toUpperCase() + wt.slice(1);
      badgesEl.appendChild(badge);
    }

    // English level
    const langLevel = item.englishLevel || (item.languages?.[0]?.level);
    if (langLevel) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--lang';
      badge.setAttribute('data-level', langLevel);
      badge.textContent = `Английский: ${langLevel}`;
      badgesEl.appendChild(badge);
    }
  }

  // Tags
  const tagsEl = document.getElementById('manual-tags');
  if (tagsEl) {
    tagsEl.innerHTML = '';
    (item.geminiTags || []).forEach((t) => {
      const s = document.createElement('span');
      s.className = 'tag';
      s.textContent = t;
      tagsEl.appendChild(s);
    });
  }

  // ===== Блок 3: Описание вакансии =====

  const descTextEl = section.querySelector('.manual-description-text');
  if (descTextEl) {
    const desc = item.descriptionForLlm || item.descriptionPreview || item.description || '';
    // Format description: paragraphs with empty lines, preserve lists
    descTextEl.innerHTML = formatDescription(desc);
  }

  // Trigger phrase (if exists)
  const triggerEl = document.getElementById('manual-trigger-phrase');
  if (triggerEl && item.triggerPhrase) {
    triggerEl.innerHTML = `<strong>Триггерная фраза:</strong> ${item.triggerPhrase}`;
    triggerEl.hidden = false;
  } else if (triggerEl) {
    triggerEl.hidden = true;
  }

  // ===== Блок 4: Выбор варианта письма =====

  const fieldsetEl = document.getElementById('manual-variant-fieldset');
  if (fieldsetEl) {
    fieldsetEl.disabled = false;
    // Radio buttons are already rendered, just ensure correct one is checked
    const radios = fieldsetEl.querySelectorAll('input[type="radio"]');
    radios.forEach((radio, i) => {
      radio.checked = i === manualTabState.selectedVariant;
      radio.disabled = false;
    });
  }

  // ===== Блок 5: Редактирование письма =====

  const textareaEl = document.getElementById('manual-letter-textarea');
  if (textareaEl) {
    textareaEl.disabled = false;
    const currentText = manualTabState.variants?.[manualTabState.selectedVariant] || '';
    textareaEl.value = currentText;
  }

  // Enable action buttons
  const saveBtn = document.getElementById('btn-save-draft');
  const approveBtn = document.getElementById('btn-approve-letter');
  const declineBtn = document.getElementById('btn-decline-letter');

  if (saveBtn) saveBtn.disabled = false;
  if (approveBtn) approveBtn.disabled = false;
  if (declineBtn) declineBtn.disabled = false;
}

/** Format description with proper paragraphs and lists */
function formatDescription(desc) {
  if (!desc) return '<p>Описание не загружено.</p>';

  // Split into lines
  const lines = desc.split('\n').filter(line => line.trim());

  let html = '';
  let inList = false;
  let listType = null; // 'ul' or 'ol'

  for (const line of lines) {
    const trimmed = line.trim();
    const isBullet = trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ');
    const isNumbered = /^\d+[.)]/.test(trimmed);

    // Check if this is a requirements or tasks section header
    const isSectionHeader = /(требования|задачи|обязанности|обязательные требования|ключевые обязанности)/i.test(trimmed);

    if (isSectionHeader) {
      if (inList) {
        html += listType === 'ul' ? '</ul>' : '</ol>';
        inList = false;
        listType = null;
      }
      html += `<p><strong>${trimmed}</strong></p>`;
    } else if (isBullet) {
      if (!inList || listType !== 'ul') {
        if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
        html += '<ul>';
        inList = true;
        listType = 'ul';
      }
      const content = trimmed.replace(/^[-•*]\s*/, '');
      html += `<li>${content}</li>`;
    } else if (isNumbered) {
      if (!inList || listType !== 'ol') {
        if (inList) html += listType === 'ul' ? '</ul>' : '</ol>';
        html += '<ol>';
        inList = true;
        listType = 'ol';
      }
      const content = trimmed.replace(/^\d+[.)]\s*/, '');
      html += `<li>${content}</li>`;
    } else {
      if (inList) {
        html += listType === 'ul' ? '</ul>' : '</ol>';
        inList = false;
        listType = null;
      }
      html += `<p>${trimmed}</p>`;
    }
  }

  if (inList) {
    html += listType === 'ul' ? '</ul>' : '</ol>';
  }

  return html;
}

/** Sync textarea value to current variant before switching */
function syncManualTextareaToVariant() {
  const ta = document.getElementById('manual-letter-textarea');
  if (!ta || !manualTabState.variants) return;
  manualTabState.variants[manualTabState.selectedVariant] = ta.value;
}

async function refreshManualVacancyById(vacancyId, fallbackUrl = null) {
  const response = await api('/api/vacancies?status=manual');
  const items = response.items || [];
  const item = items.find((x) => x.id === vacancyId) || (fallbackUrl ? items.find((x) => x.url === fallbackUrl) : null);
  if (!item) return null;
  setManualVacancy(item);
  manualTabState.url = item.url || fallbackUrl || manualTabState.url || null;
  renderManualTabUI();
  populateManualVacancySection(item);
  return item;
}

async function runManualCoverLetterGeneration(vacancyId, options = {}) {
  const { fallbackUrl = null, successMessage = 'Письмо сгенерировано' } = options;
  if (!vacancyId) {
    showToast('Сначала загрузите вакансию', 'bad');
    return null;
  }

  const generateBtn = document.getElementById('btn-generate-letter');
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Генерация…';
  }

  try {
    await requestCoverLetterGenerate(vacancyId, false);
    const item = await refreshManualVacancyById(vacancyId, fallbackUrl);
    showToast(successMessage, 'good');
    return item;
  } catch (e) {
    showToast('Ошибка генерации: ' + e.message, 'bad');
    return null;
  } finally {
    const freshGenerateBtn = document.getElementById('btn-generate-letter');
    if (freshGenerateBtn) {
      freshGenerateBtn.disabled = !manualTabState.vacancyId;
      freshGenerateBtn.textContent = manualTabState.vacancyId
        ? 'Сгенерировать письмо'
        : 'Сначала загрузите вакансию';
    }
  }
}

function initManualTabHandlers() {
  const urlInput = document.getElementById('manual-url');
  const loadBtn = document.getElementById('btn-load-vacancy');
  const generateBtn = document.getElementById('btn-generate-letter');
  const clearBtn = document.getElementById('btn-clear-manual');

  // Блок 5: Кнопки действий с письмом
  const saveDraftBtn = document.getElementById('btn-save-draft');
  const approveBtn = document.getElementById('btn-approve-letter');
  const declineBtn = document.getElementById('btn-decline-letter');
  const confirmDeclineBtn = document.getElementById('btn-confirm-decline');
  const cancelDeclineBtn = document.getElementById('btn-cancel-decline');
  const declineReasonSection = document.getElementById('manual-decline-reason');

  // Блок 1: Model info button
  const modelBtn = document.getElementById('manual-model-btn');
  const modelPanel = document.getElementById('manual-model-panel');

  // Блок 4: Radio buttons for variant selection
  const variantRadios = document.querySelectorAll('input[name="manual-variant"]');

  // Load vacancy from URL
  loadBtn?.addEventListener('click', async () => {
    const url = urlInput?.value?.trim();
    if (!url) {
      showToast('Вставьте URL вакансии', 'bad');
      return;
    }
    if (!/^https?:\/\/([^.]+\.)?hh\.ru\/vacancy\/\d+(?:[/?#].*)?$/i.test(url)) {
      showToast('Это не похоже на ссылку hh.ru вакансии', 'bad');
      return;
    }

    loadBtn.disabled = true;
    loadBtn.textContent = 'Загрузка…';
    manualTabState.parsing = true;
    manualTabState.error = null;
    manualTabState.url = url;

    try {
      const res = await api('/api/vacancy/add-from-clipboard', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      showToast('Вакансия загружается…', 'good');

      // Poll until done, then show
      await pollManualVacancy(res.id, url);
    } catch (e) {
      manualTabState.error = e.message;
      manualTabState.parsing = false;
      loadBtn.disabled = false;
      loadBtn.textContent = 'Загрузить';
      showToast('Ошибка: ' + e.message, 'bad');
      renderManualTabUI();
    }
  });

  // ===== Блок 4: Переключение вариантов (радио-кнопки) =====
  variantRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      const idx = parseInt(radio.value);
      if (!Number.isFinite(idx) || idx < 0 || idx > 2) return;

      // Save current textarea content before switching
      syncManualTextareaToVariant();

      manualTabState.selectedVariant = idx;

      // Update textarea with new variant text
      const ta = document.getElementById('manual-letter-textarea');
      if (ta && manualTabState.variants) {
        ta.value = manualTabState.variants[idx] || '';
      }
    });
  });

  // ===== Блок 5: Сохранить правки =====
  saveDraftBtn?.addEventListener('click', async () => {
    if (!manualTabState.vacancyId || !manualTabState.variants) {
      showToast('Нет данных для сохранения', 'bad');
      return;
    }

    // Sync current textarea to variant
    syncManualTextareaToVariant();

    const btnSave = document.getElementById('btn-save-draft');
    const btnApprove = document.getElementById('btn-approve-letter');
    const btnDecline = document.getElementById('btn-decline-letter');

    btnSave.disabled = btnApprove.disabled = btnDecline.disabled = true;

    try {
      await api('/api/cover-letter/save-draft', {
        method: 'POST',
        body: JSON.stringify({ id: manualTabState.vacancyId, variants: manualTabState.variants }),
      });
      showToast('Правки сохранены', 'good');
      invalidateCache();
    } catch (e) {
      alert(e.message);
    } finally {
      btnSave.disabled = btnApprove.disabled = btnDecline.disabled = false;
    }
  });

  // ===== Блок 5: Утвердить =====
  approveBtn?.addEventListener('click', async () => {
    if (!manualTabState.vacancyId) {
      showToast('Нет загруженной вакансии', 'bad');
      return;
    }

    // Sync current textarea to variant
    syncManualTextareaToVariant();

    const text = manualTabState.variants?.[manualTabState.selectedVariant] || '';
    if (!text.trim()) {
      alert('Введите или выберите текст письма.');
      return;
    }

    const btnSave = document.getElementById('btn-save-draft');
    const btnApprove = document.getElementById('btn-approve-letter');
    const btnDecline = document.getElementById('btn-decline-letter');

    btnSave.disabled = btnApprove.disabled = btnDecline.disabled = true;

    try {
      await api('/api/cover-letter/action', {
        method: 'POST',
        body: JSON.stringify({ id: manualTabState.vacancyId, action: 'approve', text }),
      });
      showToast('Письмо утверждено', 'good');

      // Сброс формы и переключение на вкладку "Подходят"
      manualTabState = { vacancyId: null, url: null, variants: null, selectedVariant: 0, parsing: false, error: null };
      invalidateCache();
      vacancyTabsEl.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      const approvedTab = vacancyTabsEl.querySelector('[data-status="approved"]');
      if (approvedTab) approvedTab.classList.add('active');
      currentStatus = 'approved';
      listEl.innerHTML = '';
      await load(true);
    } catch (e) {
      alert(e.message);
      btnSave.disabled = btnApprove.disabled = btnDecline.disabled = false;
    }
  });

  // ===== Блок 5: Отклонить (показать поле причины) =====
  declineBtn?.addEventListener('click', () => {
    if (!manualTabState.vacancyId) {
      showToast('Нет загруженной вакансии', 'bad');
      return;
    }
    // Показываем секцию с причиной
    if (declineReasonSection) {
      declineReasonSection.hidden = false;
      // Прокручиваем к ней
      declineReasonSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    // Фокус на textarea причины
    const reasonTa = document.getElementById('manual-decline-textarea');
    if (reasonTa) reasonTa.focus();
  });

  // ===== Блок 5: Отмена отклонения =====
  cancelDeclineBtn?.addEventListener('click', () => {
    if (declineReasonSection) {
      declineReasonSection.hidden = true;
    }
    const reasonTa = document.getElementById('manual-decline-textarea');
    if (reasonTa) reasonTa.value = '';
  });

  // ===== Блок 5: Подтвердить отклонение =====
  confirmDeclineBtn?.addEventListener('click', async () => {
    if (!manualTabState.vacancyId) return;

    const reasonTa = document.getElementById('manual-decline-textarea');
    const reason = reasonTa?.value?.trim() || '';

    const btnSave = document.getElementById('btn-save-draft');
    const btnApprove = document.getElementById('btn-approve-letter');
    const btnDecline = document.getElementById('btn-decline-letter');

    btnSave.disabled = btnApprove.disabled = btnDecline.disabled = true;
    if (confirmDeclineBtn) confirmDeclineBtn.disabled = true;
    if (cancelDeclineBtn) cancelDeclineBtn.disabled = true;

    try {
      await api('/api/action', {
        method: 'POST',
        body: JSON.stringify({
          id: manualTabState.vacancyId,
          action: 'reject',
          reason: reason,
        }),
      });
      showToast('Вакансия отклонена', 'neutral');

      // Сброс формы
      manualTabState = { vacancyId: null, url: null, variants: null, selectedVariant: 0, parsing: false, error: null };
      invalidateCache();
      renderManualTabUI();
      showToast('Форма очищена', 'neutral');
    } catch (e) {
      alert(e.message);
      btnSave.disabled = btnApprove.disabled = btnDecline.disabled = false;
      if (confirmDeclineBtn) confirmDeclineBtn.disabled = false;
      if (cancelDeclineBtn) cancelDeclineBtn.disabled = false;
    }
  });

  // ===== Блок 1: Model info toggle =====
  if (modelBtn && modelPanel) {
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = modelPanel.hidden;
      document.querySelectorAll('.model-info-panel').forEach((p) => {
        p.hidden = true;
      });
      if (open) modelPanel.hidden = false;
    });

    modelPanel.addEventListener('click', (e) => e.stopPropagation());
  }

  // Generate letter button (manual mode)
  generateBtn?.addEventListener('click', async () => {
    await runManualCoverLetterGeneration(manualTabState.vacancyId, {
      fallbackUrl: manualTabState.url,
      successMessage: 'Письмо сгенерировано',
    });
  });

  // ===== Блок 6: Очистить =====
  clearBtn?.addEventListener('click', async () => {
    const hasVacancy = !!manualTabState.vacancyId;
    const hasInput = !!(manualTabState.url || document.getElementById('manual-url')?.value?.trim());

    if (!hasVacancy && !hasInput) {
      showToast('Страница уже пуста', 'neutral');
      return;
    }

    if (hasVacancy) {
      // Удаляем с сервера без подтверждения как указано в ТЗ
      clearBtn.disabled = true;
      try {
        await api('/api/dismiss', {
          method: 'POST',
          body: JSON.stringify({ id: manualTabState.vacancyId }),
        });
      } catch (e) {
        showToast('Ошибка при удалении: ' + e.message, 'bad');
        clearBtn.disabled = false;
        return;
      } finally {
        clearBtn.disabled = false;
      }
    }

    // Сбрасываем состояние и перерисовываем пустой UI
    manualTabState = { vacancyId: null, url: null, variants: null, selectedVariant: 0, parsing: false, error: null };
    invalidateCache();
    renderManualTabUI();
    showToast('Страница очищена', 'neutral');
  });
}

async function pollManualVacancy(recordId, url) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const progress = await api('/api/vacancy/add-progress');
        if (progress.step === 'saving' && progress.percent === 100) {
          clearInterval(interval);
          manualTabState.parsing = false;
          // Load the vacancy record
          const items = await api('/api/vacancies?status=manual').then(r => r.items || []);
          const item = items.find(x => x.id === recordId) || items.find(x => x.url === url);
          if (item) {
            setManualVacancy(item);
            manualTabState.url = url;
            renderManualTabUI();
            populateManualVacancySection(item);
            await runManualCoverLetterGeneration(item.id, {
              fallbackUrl: url,
              successMessage: 'Письмо сгенерировано автоматически',
            });
          } else {
            manualTabState.error = 'Вакансия не найдена после загрузки';
            renderManualTabUI();
          }
          resolve();
          return;
        }
        if (progress.error) {
          clearInterval(interval);
          manualTabState.parsing = false;
          manualTabState.error = progress.error;
          renderManualTabUI();
          reject(new Error(progress.error));
          return;
        }
      } catch (e) {
        clearInterval(interval);
        manualTabState.parsing = false;
        reject(e);
      }
    }, 500);
  });
}

function renderVacancyList() {
  const items = cachedItems[currentStatus];

  if (items === null || items === undefined) {
    listEl.innerHTML = '';
    syncVacancyTabs();
    return;
  }

  listEl.innerHTML = '';

  let filtered = items;
  if (currentSearchQuery) {
    const q = currentSearchQuery.toLowerCase();
    filtered = items.filter((v) => {
      const titleMatch = (v.title || '').toLowerCase().includes(q);
      const companyMatch = (v.company || '').toLowerCase().includes(q);
      const tagsMatch = (v.geminiTags || []).some((t) => t.toLowerCase().includes(q));
      const queryMatch = (v.searchQuery || '').toLowerCase().includes(q);
      return titleMatch || companyMatch || tagsMatch || queryMatch;
    });
  }

  if (!filtered.length) {
    listEl.innerHTML = currentSearchQuery
      ? '<p class="empty">Ничего не найдено.</p>'
      : '<p class="empty">Пусто.</p>';
    syncVacancyTabs();
    return;
  }

filtered.forEach((it) => listEl.appendChild(renderCard(it)));
syncVacancyTabs();
updateRefreshSectionButton();
}

function syncVacancyTabs() {
  const tabItems = vacancyTabsEl.querySelectorAll('[class*="tab-"]:not(.tab-badge)');
  tabItems.forEach((b) => {
    if (!b.dataset.status) return;
    const status = b.dataset.status;
    const count = vacancyCounts[status] ?? 0;

    // Обновляем badge если есть
    const badge = b.querySelector('.tab-badge');
    if (badge) {
      badge.textContent = count;
      badge.dataset.count = count;
    }

    // Обновляем active состояние
    const isActive = status === currentStatus;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', isActive);
  });
}

function updateRefreshSectionButton() {
    const btn = document.getElementById('btn-refresh-section');
    const lbl = document.getElementById('refresh-section-label');
    if (!btn) return;
    const items = cachedItems[currentStatus];
    if (items === null) {
        btn.hidden = true;
        if (lbl) lbl.hidden = true;
        return;
    }
    const incompleteCount = getIncompleteCount(items);
    if (incompleteCount === 0 || bulkRefreshState.active) {
        btn.hidden = true;
        if (lbl) lbl.hidden = true;
        return;
    }
    btn.hidden = false;
    if (lbl) {
        lbl.hidden = false;
        const text = incompleteCount > BATCH_LIMIT ? `${BATCH_LIMIT}+` : incompleteCount;
        lbl.innerHTML = `${text} <span>вакансий</span>`;
    }
}

function setRefreshSectionLoading(loading, total) {
    const btn = document.getElementById('btn-refresh-section');
    const lbl = document.getElementById('refresh-section-label');
    if (!btn) return;
    bulkRefreshState.active = loading;
    bulkRefreshState.total = total;
    bulkRefreshState.completed = 0;
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
    if (loading) {
        btn.style.setProperty('--progress', '0%');
        if (lbl) lbl.textContent = `0 / ${total}`;
    } else {
        btn.style.setProperty('--progress', '100%');
        setTimeout(() => btn.style.removeProperty('--progress'), 600);
        if (lbl) lbl.hidden = true;
    }
}

function updateRefreshSectionProgress(completed, total) {
    const btn = document.getElementById('btn-refresh-section');
    const lbl = document.getElementById('refresh-section-label');
    if (!btn) return;
    bulkRefreshState.completed = completed;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    btn.style.setProperty('--progress', `${pct}%`);
    if (lbl) lbl.textContent = `${completed} / ${total}`;
}

async function refreshIncompleteInSection() {
const items = cachedItems[currentStatus];
if (!items) {
console.error('cachedItems[currentStatus] is null. Current status:', currentStatus);
showToast('Данные не загружены. Переключитесь на раздел.', 'bad');
return;
}
const incomplete = items.filter(needsVacancyBodyRefresh);
if (incomplete.length === 0) return;
const batch = incomplete.slice(0, BATCH_LIMIT);
setRefreshSectionLoading(true, batch.length);
let success = 0;
let failed = 0;
try {
for (const item of batch) {
try {
const res = await api('/api/vacancy/refresh-body', {
method: 'POST',
body: JSON.stringify({ id: item.id }),
});
if (res.ok) success++;
else failed++;
} catch (e) {
failed++;
console.error(`Failed to refresh vacancy ${item.id}:`, e);
}
updateRefreshSectionProgress(success + failed, batch.length);
}
invalidateCache();
await load();
} catch (e) {
console.error('Bulk refresh failed:', e);
showToast(`Ошибка: ${e.message}`, 'bad');
} finally {
setRefreshSectionLoading(false);
const remaining = getIncompleteCount(cachedItems[currentStatus] || []);
if (remaining > 0) {
showToast(`Обновлено ${success} из ${batch.length}. Ещё ${remaining} — нажмите ещё раз`, failed ? 'neutral' : 'good');
} else {
showToast(`Обновлено ${success} из ${batch.length}${failed ? ` (${failed} ошибок)` : ''}`, failed ? 'neutral' : 'good');
}
}
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
      for (const status of ['manual', 'pending', 'approved', 'rejected']) {
        if (cachedItems[status] !== null && status !== currentStatus) {
          vacancyCounts[status] = cachedItems[status].length;
        }
      }
      // Manual tab uses dedicated UI instead of card list
      if (currentStatus === 'manual') {
        // Find the first manual vacancy (most recent) to show in the manual form
        const first = (items && items.length > 0) ? items[items.length - 1] : null;
        setManualVacancy(first);
        renderManualTabUI();
        if (first) populateManualVacancySection(first);
      } else {
        renderVacancyList();
      }
      return;
    }

    // Загружаем все записи параллельно для подсчёта + отображения
    const allData = await Promise.all(
      ['manual', 'pending', 'approved', 'rejected'].map((status) =>
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
    // Manual tab uses dedicated UI instead of card list
    if (currentStatus === 'manual') {
      const first = (items && items.length > 0) ? items[items.length - 1] : null;
      setManualVacancy(first);
      renderManualTabUI();
      if (first) populateManualVacancySection(first);
    } else {
      renderVacancyList();
    }
  } catch (e) {
    listEl.innerHTML = `<p class="err">${e.message}</p>`;
  }
}

vacancyTabsEl.querySelectorAll('.tab-underlined-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    vacancyTabsEl.querySelectorAll('.tab-underlined-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentStatus = btn.dataset.status;
    // Если данные уже в кэше — отображаем сразу, иначе загружаем
    if (cachedItems[currentStatus] !== null) {
      if (currentStatus === 'manual') {
        const items = cachedItems[currentStatus] || [];
        const first = items.length > 0 ? items[items.length - 1] : null;
        setManualVacancy(first);
        renderManualTabUI();
        if (first) populateManualVacancySection(first);
      } else {
        renderVacancyList();
      }
    } else {
      load();
    }
    updateRefreshSectionButton();
  });
});

syncVacancyTabs();
updateRefreshSectionButton();

const searchInput = document.getElementById('vacancy-search');
const clearBtn = document.getElementById('vacancy-search-clear');
if (searchInput) searchInput.addEventListener('input', onSearchInput);
if (clearBtn) clearBtn.addEventListener('click', clearSearch);

const refreshSectionBtn = document.getElementById('btn-refresh-section');
if (refreshSectionBtn) {
refreshSectionBtn.addEventListener('click', () => {
if (!bulkRefreshState.active) {
refreshIncompleteInSection();
}
});
}

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
