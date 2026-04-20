/**
 * Извлечение полей со страницы вакансии hh.ru (зависит от вёрстки).
 */

export async function parseVacancyPage(page) {
  // Ждём дополнительно после domcontentloaded — описание на hh.ru подгружается динамически
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const t = (sel) =>
      document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

    // Утилита: найти текст по regex и вернуть значение после label
    const getByText = (container, labelPattern, valuePattern) => {
      const el = container.querySelector('[class*="vacancy-"]') || container;
      const text = el.textContent || '';
      const labelMatch = text.match(labelPattern);
      if (!labelMatch) return '';
      const afterLabel = labelMatch[0];
      const valueMatch = afterLabel.match(valuePattern);
      if (valueMatch) return valueMatch[1] || valueMatch[0];
      // fallback: всё что после label до следующего заглавного
      return afterLabel.replace(labelPattern, '').split(/[,\n]/)[0].trim();
    };

    const title = t('[data-qa="vacancy-title"]') || t('h1');
    const company = t('[data-qa="vacancy-company-name"]') || t('a[data-qa="vacancy-company-name"]');
    const salary = t('[data-qa="vacancy-salary"]');

    // Ищем основной блок с инфой о вакансии — он содержит salary и другие поля
    const infoBlock = document.querySelector('[class*="vacancy-info"]') ||
      document.querySelector('[data-qa="vacancy-salary"]')?.closest('[class*="vacancy"]') ||
      document.querySelector('.vacancy-base-info') ||
      document.querySelector('[class*="vacancy-description"]')?.closest('section') ||
      document.querySelector('section') ||
      document.body;

    // Опыт
    const experience = t('[data-qa="vacancy-experience"]') ||
      (() => {
        const el = Array.from(document.querySelectorAll('p, span, div')).find(e =>
          /опыт\s*работы\s*:?\s*\S/i.test(e.textContent)
        );
        return el ? el.textContent.replace(/.*опыт\s*работы\s*:\s*/i, '').trim() : '';
      })();

    // Занятость / формат
    const employment = t('[data-qa="work-formats-text"]') ||
      t('[data-qa="vacancy-employment-mode"]') ||
      t('[data-qa="vacancy-view-employment-mode"]');

    // Адрес
    const address = t('[data-qa="vacancy-view-location"]') ||
      t('[data-qa="vacancy-view-raw-address"]');

    // Выплаты — ищем "Выплаты: раз в месяц"
    const paymentSchedule = (() => {
      const el = Array.from(document.querySelectorAll('p, span')).find(e =>
        /выплаты\s*:?\s*/i.test(e.textContent)
      );
      return el ? el.textContent.replace(/.*выплаты\s*:\s*/i, '').trim() : '';
    })();

    // График — ищем "График: 5/2"
    const schedule = (() => {
      const el = Array.from(document.querySelectorAll('p, span')).find(e =>
        /график\s*:?\s*/i.test(e.textContent)
      );
      return el ? el.textContent.replace(/.*график\s*:\s*/i, '').trim() : '';
    })();

    // Рабочие часы — ищем "Рабочие часы: 8"
    const workHours = (() => {
      const el = Array.from(document.querySelectorAll('[class*="vacancy"] p, [class*="vacancy"] span, [class*="vacancy"] div')).find(e =>
        /рабочие\s*часы\s*:?\s*\d/i.test(e.textContent)
      );
      return el ? el.textContent.replace(/.*рабочие\s*часы\s*:\s*/i, '').trim() : '';
    })();

    // Сколько человек смотрит вакансию
    const viewerCount = (() => {
      // Ищем элемент содержащий "смотрят" или "смотрит" вакансию
      const el = Array.from(document.querySelectorAll('p, span, div')).find(e =>
        /смотрет/i.test(e.textContent) && /ваканс/i.test(e.textContent)
      );
      if (!el) return null;
      // Ищем число в дочернем элементе: "25 человек"
      const childMatch = el.innerHTML.match(/(\d+)\s*(?:человек|чел\.?)/i);
      if (childMatch) return childMatch[1];
      // Ищем в тексте элемента
      const match = el.textContent.match(/(\d+)\s*(?:человек|чел\.?)/i);
      return match ? match[1] : null;
    })();

    // Оформление — sibling сразу после "Оформление:"
    const employmentType = (() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      // Ищем элемент с текстом "Оформление:"
      const labelEl = allEls.find(e => /^оформление\s*:\s*$/i.test(e.textContent.trim()));
      if (!labelEl) return '';
      // Сначала пробуем nextElementSibling
      let sibling = labelEl.nextElementSibling;
      if (sibling && sibling.textContent.trim()) {
        return sibling.textContent.replace(/\s+/g, ' ').trim();
      }
      // Fallback: ищем через parent.childNodes
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

    // Описание вакансии: пробуем разные селекторы (hh.ru вёрстка меняется)
    let description =
      t('[data-qa="vacancy-description"]') ||
      t('[data-qa="vacancy-view-vacancyDescription"]') ||
      t('.vacancy-description') ||
      t('.vacancy-section') ||
      t('[itemprop="description"]') ||
      t('.bloko-text') ||
      document.querySelector('[class*="vacancy-description"]')?.textContent?.replace(/\s+/g, ' ')?.trim() ||
      // Backup: ищем основной контент страницы по тексту вакансии внутри main/section
      (() => {
        // Ищем в <article> или <section role="main"> — типичный контейнер описания
        const article = document.querySelector('article') || document.querySelector('section[role="main"]') || document.querySelector('main');
        if (!article) return '';
        // Берём весь текст из article, но ограничиваем длину
        return article.textContent.replace(/\s+/g, ' ').trim().slice(0, 15000);
      })() ||
      '';

    // Извлекаем уровень языка из текста страницы (на hh.ru нет отдельного data-qa)
    // Формат: "Английский — B1 — Средний" или "English — Advanced"
    let languages = [];
    const langMatch = document.body.textContent.match(/(Английский|English|Немецкий|Deutsch|Французский|Français|Китайский|Chinese|Испанский|Spanish)\s*—\s*(\S+(?:\s*—\s*\S+)?)/i);
    if (langMatch) {
      const langName = langMatch[1].trim();
      const levelRaw = langMatch[2].trim();
      // Берём первый уровень (A1, B2, C1, Advanced и т.д.)
      const levelMatch = levelRaw.match(/(A[12]|B[12]|C[12]|Advanced|Proficiency|Native|Носитель|Средний|Выше среднего|Базовый|Продвинутый|Свободный|Не владею)/i);
      if (levelMatch) {
        languages.push({ name: langName, level: levelMatch[1].trim() });
      } else {
        languages.push({ name: langName, level: levelRaw.split(/[—\s]+/).find(s => /[A-Z0-9]/i.test(s)) || levelRaw });
      }
    }

    if (description.length > 12_000) description = `${description.slice(0, 12_000)}…`;

    const blob = [title, company, salary, experience, employment, address, description]
      .join('\n')
      .toLowerCase();

    return {
      title,
      company,
      salaryRaw: salary,
      experience,
      employment,
      address,
      paymentSchedule,   // "Выплаты: раз в месяц"
      employmentType,     // "Оформление: Договор ГПХ..."
      schedule,           // "График: 5/2"
      workHours,          // "Рабочие часы: 8"
      viewerCount,        // сколько человек смотрит
      description,
      languages,
      textBlob: blob,
    };
  });
}

export function vacancyIdFromUrl(url) {
  const m = String(url).match(/\/vacancy\/(\d+)/);
  return m ? m[1] : null;
}
