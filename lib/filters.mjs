import { estimateMonthlyUsd } from './salary-parse.mjs';

function includesAny(text, patterns) {
  const t = text.toLowerCase();
  return patterns.some((p) => t.includes(String(p).toLowerCase()));
}

/**
 * Определяет типы места работы по полю employment с hh.ru.
 * Может вернуть несколько значений если вакансия допускает разные форматы.
 *
 * @param {string} employment - строка с hh.ru, например "удалённо или гибрид"
 * @param {string} [fallbackBlob] - текст вакансии для fallback-анализа если employment пустой
 * @returns {Array<'офис'|'гибрид'|'удаленка'|'не указано'>}
 */
export function determineWorkplaceType(employment, fallbackBlob) {
  const emp = (employment || '').toLowerCase().trim();
  const results = [];

  // Прямые значения с hh.ru — проверяем все варианты, т.к. может быть несколько
  if (emp.includes('удалённ') || emp.includes('удаленн') || emp.includes('дистанцион') || emp.includes('удалённо')) {
    results.push('удаленка');
  }
  if (emp.includes('гибрид')) {
    results.push('гибрид');
  }
  if (emp.includes('на месте') || emp.includes('в офисе') || emp.includes('on-site')) {
    results.push('офис');
  }

  // Fallback: анализируем текст вакансии
  if (results.length === 0 && fallbackBlob) {
    const t = fallbackBlob.toLowerCase();
    const remotePatterns = ['удалённ', 'удаленн', 'удалённая', 'удаленная', 'remote', 'work from home', 'дистанционн'];
    const hybridPatterns = ['гибрид', 'hybrid', 'пару раз в офис', 'несколько дней в офис'];
    const officePatterns = ['только офис', 'office only', 'on-site only'];

    if (remotePatterns.some(p => t.includes(p))) results.push('удаленка');
    if (hybridPatterns.some(p => t.includes(p))) results.push('гибрид');
    if (officePatterns.some(p => t.includes(p))) results.push('офис');
  }

  return results.length > 0 ? results : ['не указано'];
}

export function passesRemote(textBlob, prefs) {
  const t = textBlob.toLowerCase();
  const pos = includesAny(t, prefs.remotePositivePatterns || []);
  const hyb = includesAny(t, prefs.hybridPatterns || []);
  const off = includesAny(t, prefs.officeOnlyPatterns || []);

  if (off && !pos) {
    return { pass: false, reason: 'В тексте акцент на офис без явной удалёнки' };
  }
  if (pos) return { pass: true, reason: 'Есть признаки удалённой работы' };
  if (hyb && prefs.allowHybrid) return { pass: true, reason: 'Гибрид (разрешён в preferences)' };
  if (hyb && !prefs.allowHybrid) return { pass: false, reason: 'Гибрид (не разрешён в preferences)' };
  // Формат не определён (unknown)
  const allowUnknown = prefs.allowUnknownFormat ?? false;
  if (allowUnknown) return { pass: true, reason: 'Формат не указан — пропущено по allowUnknownFormat' };
  if (prefs.requireRemote) {
    return { pass: false, reason: 'Нет явной удалёнки/гибрида в описании' };
  }
  return { pass: true, reason: 'Удалёнка не обязательна по настройкам' };
}

export function passesSalary(salaryRaw, prefs) {
  const rub = prefs.rubPerUsd || 98;
  const est = estimateMonthlyUsd(salaryRaw, rub);
  if (!est.ok) {
    if (prefs.allowUnknownSalary) {
      return { pass: true, reason: 'Зарплата не указана — пропущено по allowUnknownSalary', estimate: est };
    }
    return { pass: false, reason: est.note || 'Нет зарплаты', estimate: est };
  }

  const minNeed = prefs.minMonthlyUsd ?? 1500;
  if (est.minUsd >= minNeed) {
    return { pass: true, reason: `Нижняя оценка ≥ ${minNeed} USD/мес`, estimate: est };
  }
  if (est.maxUsd >= minNeed) {
    return {
      pass: true,
      reason: `Вилка задевает ≥ ${minNeed} USD/мес (верх ${est.maxUsd})`,
      estimate: est,
    };
  }

  return {
    pass: false,
    reason: `Оценка ниже порога ${minNeed} USD/мес (≈${est.minUsd}–${est.maxUsd})`,
    estimate: est,
  };
}

export function runHardFilters(parsed, prefs) {
  const blob = [
    parsed.title,
    parsed.company,
    parsed.salaryRaw,
    parsed.employment,
    parsed.address,
    parsed.description,
  ]
    .join('\n')
    .toLowerCase();

  const remote = passesRemote(blob, prefs);
  if (!remote.pass) {
    return { pass: false, stage: 'remote', ...remote };
  }

  const salary = passesSalary(parsed.salaryRaw, prefs);
  if (!salary.pass) {
    return { pass: false, stage: 'salary', ...salary };
  }

  return {
    pass: true,
    remoteReason: remote.reason,
    salaryReason: salary.reason,
    salaryEstimate: salary.estimate,
    workplaceType: determineWorkplaceType(parsed.employment, blob),
  };
}
