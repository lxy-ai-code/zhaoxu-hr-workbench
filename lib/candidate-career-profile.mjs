const text=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const original=value=>typeof value==='string'?value:'';
const rows=value=>Array.isArray(value)?value:value==null?[]:[value];
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const period=row=>text(row?.dateRange)||[text(row?.startDate),text(row?.endDate)].filter(Boolean).join('—');
const description=row=>[...new Set(['description','desc','content','summary','responsibilities','workDescription','achievements'].map(key=>original(row?.[key])).filter(Boolean))].join('\n');

/** All saved career facts, for display/export only. No age or conclusions. */
export function candidateCareerProfile(candidate={}) {
  const workHistory=rows(candidate?.workHistory).map(row=>{
    if(typeof row==='string')return {company:'',position:'',dateRange:'',description:row};
    const entry={company:text(row?.company),position:text(row?.position),dateRange:period(row),description:description(row)};
    if(object(row)&&!Object.values(entry).some(Boolean))entry.description=JSON.stringify(row);
    return entry;
  });
  const educationSource=rows(candidate?.education);
  const educationCleared=Array.isArray(candidate?.profileManualFields)&&candidate.profileManualFields.includes('education')&&educationSource.length===0;
  const education=educationSource.length?educationSource.map(row=>{
    if(typeof row==='string')return {school:'',major:'',degree:'',dateRange:'',description:row};
    const entry={school:text(row?.school),major:text(row?.major),degree:text(row?.degree),dateRange:period(row)};
    const details=description(row);
    if(details)entry.description=details;
    else if(object(row)&&!Object.values(entry).some(Boolean))entry.description=JSON.stringify(row);
    return entry;
  }):!educationCleared&&[text(candidate?.school),text(candidate?.major),text(candidate?.degree)].some(Boolean)?[{school:text(candidate?.school),major:text(candidate?.major),degree:text(candidate?.degree),dateRange:''}]:[];
  return {candidateId:text(candidate?.id),city:text(candidate?.city),introduction:original(candidate?.introduction),briefIntroduction:original(candidate?.briefIntroduction),capturedAt:text(candidate?.capturedAt),workHistory,education};
}
