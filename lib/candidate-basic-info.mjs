const rawText = value => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

/** Display-only projection. No inferred age, job substitution, or assessment. */
export function candidateBasicInfo(candidate = {}, requirement = {}) {
  const recent=Array.isArray(candidate?.workHistory)?candidate.workHistory[0]:null;
  const period=rawText(recent?.dateRange)||[rawText(recent?.startDate),rawText(recent?.endDate)].filter(Boolean).join('—');
  const manual=new Set(Array.isArray(candidate?.profileManualFields)?candidate.profileManualFields:[]);
  return {
    name: rawText(candidate?.name),
    age: rawText(candidate?.age) || (manual.has('age')?'':rawText(candidate?.ageText)),
    degree: rawText(candidate?.degree),
    experience: rawText(candidate?.workYear),
    expectedSalary: rawText(candidate?.salary),
    targetPosition: rawText(candidate?.position),
    interviewPosition: rawText(requirement?.title),
    recentCompany: rawText(recent?.company)||rawText(candidate?.company),
    recentPosition: rawText(recent?.position),
    recentPeriod: period,
  };
}
