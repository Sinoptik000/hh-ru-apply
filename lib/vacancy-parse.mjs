/**
 * Извлечение полей со страницы вакансии hh.ru.
 *
 * Актуальные data-qa атрибуты (проверено 2025-04):
 *   vacancy-title, vacancy-experience, vacancy-company-name,
 *   vacancy-description, vacancy-salary, work-formats-text,
 *   common-employment-text, work-schedule-by-days-text, working-hours-text,
 *   vacancy-view-location, vacancy-view-raw-address
 */

/**
 * Ожидает появления ключевого элемента описания вакансии.
 * Включает прокрутку для загрузки ленивого контента.
 */
export async function waitForVacancyContent(page, timeoutMs = 25_000) {
  // Ждём основных элементов
  try {
    await page.waitForSelector(
      '[data-qa="vacancy-description"], [data-qa="vacancy-title"], .vacancy-description, [class*="vacancy-description"]',
      { timeout: timeoutMs, state: 'attached' }
    );
  } catch {
    // Если не дождались — продолжаем, возможно контент уже есть
  }

  // Прокручиваем страницу чтобы спровоцировать загрузку ленивого контента
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight / 2);
  });
  await page.waitForTimeout(800);

  // Ещё раз прокручиваем вниз для полной загрузки
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(800);

  // Возвращаемся наверх
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);

  // Ждём стабилизации React
  await page.waitForTimeout(1000);
}

export async function parseVacancyPage(page) {
  await waitForVacancyContent(page);
  return page.evaluate(() => {
    const t = (sel) =>
      document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

    // --- Основные поля ---
    const title = t('[data-qa="vacancy-title"]') || t('h1');
    const company = t('[data-qa="vacancy-company-name"]') || t('a[data-qa="vacancy-company-name"]');
    const salary = t('[data-qa="vacancy-salary"]');

    // --- Опыт ---
    // Актуально: <span data-qa="vacancy-experience">3–6 лет</span>
    const experience = t('[data-qa="vacancy-experience"]') ||
      (() => {
        const el = Array.from(document.querySelectorAll('p, span, div')).find(e =>
          /опыт\s*работы\s*:?\s*\S/i.test(e.textContent) && e.textContent.length < 200
        );
        return el ? el.textContent.replace(/.*опыт\s*работы\s*:\s*/i, '').trim() : '';
      })();

    // --- Занятость ---
    // Актуально: <div data-qa="common-employment-text">Полная занятость</div>
    const employment =
      t('[data-qa="common-employment-text"]') ||
      t('[data-qa="work-formats-text"]') ||
      t('[data-qa="vacancy-employment-mode"]') ||
      t('[data-qa="vacancy-view-employment-mode"]');

    // --- График ---
    // Актуально: <span data-qa="work-schedule-by-days-text">5/2</span>
    const schedule =
      (() => {
        const el = document.querySelector('[data-qa="work-schedule-by-days-text"]');
        if (el) return el.textContent.replace(/\s+/g, ' ').trim();
        // fallback: ищем "График:" в тексте
        const byText = Array.from(document.querySelectorAll('p, span')).find(e =>
          /^график\s*:/i.test(e.textContent.trim())
        );
        return byText ? byText.textContent.replace(/.*график\s*:\s*/i, '').trim() : '';
      })();

    // --- Рабочие часы ---
    // Актуально: <span data-qa="working-hours-text">8 часов</span>
    const workHours =
      (() => {
        const el = document.querySelector('[data-qa="working-hours-text"]');
        if (el) return el.textContent.replace(/\s+/g, ' ').trim();
        // fallback
        const byText = Array.from(document.querySelectorAll('p, span')).find(e =>
          /рабочие\s*часы\s*:?\s*\d/i.test(e.textContent)
        );
        return byText ? byText.textContent.replace(/.*рабочие\s*часы\s*:\s*/i, '').trim() : '';
      })();

    // --- Формат работы (удалённо/гибрид/офис) ---
    // Актуально: <p data-qa="work-formats-text">Формат работы: удалённо или гибрид</p>
    const workFormat =
      (() => {
        const el = document.querySelector('[data-qa="work-formats-text"]');
        if (el) return el.textContent.replace(/\s+/g, ' ').trim();
        return '';
      })();

    // --- Адрес ---
    const address =
      t('[data-qa="vacancy-view-location"]') ||
      t('[data-qa="vacancy-view-raw-address"]');

    // --- Выплаты ---
    const paymentSchedule = (() => {
      const el = Array.from(document.querySelectorAll('p, span')).find(e =>
        /выплаты\s*:?\s*/i.test(e.textContent) && e.textContent.length < 200
      );
      return el ? el.textContent.replace(/.*выплаты\s*:\s*/i, '').trim() : '';
    })();

    // --- Оформление ---
    const employmentType = (() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      const labelEl = allEls.find(e => /^оформление\s*:\s*$/i.test(e.textContent.trim()));
      if (!labelEl) return '';
      let sibling = labelEl.nextElementSibling;
      if (sibling && sibling.textContent.trim()) {
        return sibling.textContent.replace(/\s+/g, ' ').trim();
      }
      const parent = labelEl.parentElement;
      if (parent) {
        const siblings = Array.from(parent.childNodes).filter(n => n.nodeType === 1);
        const idx = siblings.indexOf(labelEl);
        if (idx >= 0 && idx < siblings.length - 1) {
          const next = siblings[idx + 1];
          if (next && next.textContent.trim()) {
            return next.textContent.replace(/\s+/g, ' ').trim();
          }
        }
      }
      return '';
    })();

    // --- Сколько человек смотрят вакансию ---
    const viewerCount = (() => {
      const el = Array.from(document.querySelectorAll('p, span, div')).find(e =>
        /смотрет/i.test(e.textContent) && /ваканс/i.test(e.textContent) && e.textContent.length < 300
      );
      if (!el) return null;
      const childMatch = el.innerHTML.match(/(\d+)\s*(?:человек|чел\.?)/i);
      if (childMatch) return childMatch[1];
      const match = el.textContent.match(/(\d+)\s*(?:человек|чел\.?)/i);
      return match ? match[1] : null;
    })();

    // --- Описание вакансии ---
    // Пробуем множество селекторов для максимальной совместимости
    let description = '';

    // Приоритет 1: data-qa атрибуты (основной способ hh.ru)
    const descSelectors = [
      '[data-qa="vacancy-description"]',
      '[data-qa="vacancy-view-vacancyDescription"]',
      '[data-qa="vacancy-view-description"]',
      '.g-user-content',
    ];
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) {
        description = el.textContent.replace(/\s+/g, ' ').trim();
        break;
      }
    }

    // Приоритет 2: классы содержащие vacancy-description
    if (!description || description.length < 100) {
      const els = document.querySelectorAll('[class*="vacancy-description"], [class*="VacancyDescription"], .vacancy-section, .vacancy__info');
      for (const el of els) {
        const text = el.textContent.trim();
        if (text.length > 200) {
          description = text.replace(/\s+/g, ' ').trim();
          break;
        }
      }
    }

    // Приоритет 3: ищем по текстовым паттернам вакансии (Требования, Обязанности, Условия)
    if (!description || description.length < 100) {
      const allDivs = document.querySelectorAll('div, article, section');
      for (const el of allDivs) {
        const text = el.textContent || '';
        // Ищем блоки с типичными заголовками вакансий
        if ((/требования|обязанности|условия|задачи|о\s*компании/i.test(text)) &&
            text.length > 500 && text.length < 50000) {
          description = text.replace(/\s+/g, ' ').trim();
          break;
        }
      }
    }

    // Приоритет 4: itemprop="description" или main/article
    if (!description || description.length < 100) {
      const el = document.querySelector('[itemprop="description"]') ||
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.querySelector('section[role="main"]');
      if (el) {
        const text = el.textContent.trim();
        if (text.length > 200) {
          description = text.replace(/\s+/g, ' ').trim().slice(0, 20000);
        }
      }
    }

    // Приоритет 5: крайний fallback - ищем самый большой текстовый блок
    if (!description || description.length < 100) {
      let maxLen = 0;
      let bestEl = null;
      const candidates = document.querySelectorAll('div, section, article');
      for (const el of candidates) {
        const text = el.textContent || '';
        if (text.length > maxLen && text.length < 100000) {
          maxLen = text.length;
          bestEl = el;
        }
      }
      if (bestEl && maxLen > 500) {
        description = bestEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 20000);
      }
    }

    // --- Языки ---
    let languages = [];
    const langMatch = document.body.textContent.match(
      /(Английский|English|Немецкий|Deutsch|Французский|Français|Китайский|Chinese|Испанский|Spanish)\s*—\s*(\S+(?:\s*—\s*\S+)?)/i
    );
    if (langMatch) {
      const langName = langMatch[1].trim();
      const levelRaw = langMatch[2].trim();
      const levelMatch = levelRaw.match(
        /(A[12]|B[12]|C[12]|Advanced|Proficiency|Native|Носитель|Средний|Выше среднего|Базовый|Продвинутый|Свободный|Не владею)/i
      );
      if (levelMatch) {
        languages.push({ name: langName, level: levelMatch[1].trim() });
      } else {
        languages.push({
          name: langName,
          level: levelRaw.split(/[—\s]+/).find(s => /[A-Z0-9]/i.test(s)) || levelRaw,
        });
      }
    }

    if (description.length > 12_000) description = `${description.slice(0, 12_000)}…`;

    const blob = [title, company, salary, experience, employment, workFormat, address, description]
      .join('\n')
      .toLowerCase();

    return {
      title,
      company,
      salaryRaw: salary,
      experience,
      employment,
      workFormat,      // "Формат работы: удалённо или гибрид"
      address,
      paymentSchedule,
      employmentType,
      schedule,
      workHours,
      viewerCount,
      description,
      languages,
      textBlob: blob,
    };
  });
}

/**
 * Парсит вакансию с повторной попыткой при коротком описании.
 * Иногда hh.ru загружает контент позже — пробуем подождать дополнительно.
 */
export async function parseVacancyPageWithRetry(page, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await parseVacancyPage(page);

    // Если описание достаточно длинное — считаем успехом
    if (result.description && result.description.length >= 500) {
      return result;
    }

    // Если описание короткое и есть ещё попытки — ждём и пробуем снова
    if (attempt < maxAttempts) {
      // Дополнительная прокрутка и ожидание
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(1500 * attempt); // Увеличиваем задержку с каждой попыткой
    }
  }

  // Возвращаем последний результат даже если он короткий
  return parseVacancyPage(page);
}

export function vacancyIdFromUrl(url) {
  const m = String(url).match(/\/vacancy\/(\d+)/);
  return m ? m[1] : null;
}
