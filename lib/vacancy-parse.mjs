/**
 * Извлечение полей со страницы вакансии hh.ru (зависит от вёрстки).
 */

export async function parseVacancyPage(page) {
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const t = (sel) =>
      document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

    const title = t('[data-qa="vacancy-title"]') || t('h1');
    const company = t('[data-qa="vacancy-company-name"]') || t('a[data-qa="vacancy-company-name"]');
    const salary = t('[data-qa="vacancy-salary"]');
    const experience = t('[data-qa="vacancy-experience"]');
    const employment = t('[data-qa="work-formats-text"]') || t('[data-qa="vacancy-employment-mode"]') || t('[data-qa="vacancy-view-employment-mode"]');
    const address = t('[data-qa="vacancy-view-location"]') || t('[data-qa="vacancy-view-raw-address"]');

let description =
 t('[data-qa="vacancy-description"]') ||
 t('[data-qa="vacancy-view-vacancyDescription"]') ||
 t('.vacancy-description') ||
 t('.vacancy-section') ||
 t('[itemprop="description"]') ||
 t('.bloko-text') ||
 document.querySelector('[class*="vacancy-description"]')?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

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
