import { normalizeEducation, parseWorkExperience, parseExpectedSalary, candidateMasterProfile } from './candidate-inbox-model.js';

export const sourceChannelNames = {boss_search:'BOSS 搜索 / 推荐',boss_message:'BOSS 消息',manual_resume:'人工简历入库',legacy_workflow:'历史招聘流程'};
export const inCandidatePool = candidate => Boolean(candidate?.pool);
export const isBossOffline = data => data?.settings?.bossOfflineMode===true || data?.settings?.bossOffline===true || data?.settings?.offlineMode===true || data?.offlineMode===true;
const arr=value=>Array.isArray(value)?value:[];
const stamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;
const known=value=>typeof value==='number'&&Number.isFinite(value);
const text=value=>typeof value==='string'?value:'';
export const poolChannels = candidate => [...new Set([candidate?.pool?.primaryChannel,...arr(candidate?.pool?.sources).map(row=>row.channel)].filter(Boolean))];
export function latestSourcingAssessment(data,sourceId,requirementId){return arr(data?.analyses).filter(row=>row.scene==='sourcing_match'&&row.sourceId===sourceId&&row.requirementId===requirementId).sort((a,b)=>stamp(b.createdAt)-stamp(a.createdAt))[0]||null;}
export function sourcingRows(data={},requirementChoices={}){
  return arr(data.sourcingCandidates).map(source=>{
    const candidate=arr(data.candidates).find(row=>row.id===source.candidateId&&row.sourceAccountKey===source.sourceAccountKey&&row.externalId===source.externalId),p=candidateMasterProfile(candidate,source.profile||{}),manual=new Set(arr(candidate?.profileManualFields));
    const requirementId=Object.hasOwn(requirementChoices,source.id)?requirementChoices[source.id]:source.requirementId||'';
    const assessment=latestSourcingAssessment(data,source.id,requirementId),degree=p.degree||p.highestDegreeName||'',experience=p.workYear||p.year||'',salary=p.expectedSalary||p.salary||'',position=p.expectedPosition||p.position||p.intendedPosition||'';
    return {id:source.id,source,candidate,profile:p,requirementId,assessment,name:p.name||'姓名未提供',degree,education:normalizeEducation(degree),workYear:experience,experience:parseWorkExperience(experience),salary,salaryRange:parseExpectedSalary(salary),position,company:candidate&&(candidate.profileMasterVersion===1||manual.has('company'))?p.company||'':p.company||p.workHistory?.[0]?.company||'',city:p.expectedCity||p.city||'',age:p.age||p.ageDesc||'',capturedAt:source.capturedAt||source.updatedAt||source.createdAt,pool:inCandidatePool(candidate),score:assessment&&!assessment.stale&&known(assessment.score)?assessment.score:null};
  });
}
export function filterSourcingRows(rows,filter={}){
  const min=value=>value===''||value==null?null:Number(value),salaryMin=min(filter.salaryMin),salaryMax=min(filter.salaryMax),expMin=min(filter.experienceMin),expMax=min(filter.experienceMax);
  return rows.filter(row=>{
    if(filter.query&&![row.name,row.position,row.company,row.city,row.degree,row.profile.school,row.profile.major].filter(Boolean).join(' ').toLowerCase().includes(filter.query.toLowerCase()))return false;
    if(filter.degree&&row.education.level!==filter.degree)return false;
    if(filter.position&&row.position!==filter.position)return false;
    if(filter.requirementId&&row.requirementId!==filter.requirementId)return false;
    if(filter.pool==='joined'&&!row.pool||filter.pool==='unselected'&&row.pool)return false;
    if(expMin!==null||expMax!==null){if(!row.experience.known||expMin!==null&&expMax!==null&&expMin>expMax)return false;if(expMin!==null&&(row.experience.maxYears??Infinity)<expMin||expMax!==null&&(row.experience.minYears??0)>expMax)return false;}
    if(salaryMin!==null||salaryMax!==null){if(!row.salaryRange.known||row.salaryRange.period!=='month'||salaryMin!==null&&salaryMax!==null&&salaryMin>salaryMax)return false;if(salaryMin!==null&&(row.salaryRange.max??Infinity)<salaryMin*1000||salaryMax!==null&&(row.salaryRange.min??0)>salaryMax*1000)return false;}
    if(filter.assessment==='scored'&&!known(row.score)||filter.assessment==='pending'&&row.assessment||filter.assessment==='stale'&&!row.assessment?.stale)return false;
    return true;
  });
}
export function sortSourcingRows(rows,sort='latest'){
  const numeric=(a,b,dir)=>known(a)!==known(b)?known(a)?-1:1:known(a)?(a-b)*dir:0;
  return [...rows].sort((a,b)=>{
    const field=sort==='score'?numeric(a.score,b.score,-1):sort==='education'?numeric(a.education.rank,b.education.rank,-1):sort.startsWith('experience')?numeric(a.experience.minYears,b.experience.minYears,sort.endsWith('asc')?1:-1):sort.startsWith('salary')?numeric(a.salaryRange.period==='month'?a.salaryRange.min:null,b.salaryRange.period==='month'?b.salaryRange.min:null,sort.endsWith('desc')?-1:1):0;
    return field||stamp(b.capturedAt)-stamp(a.capturedAt)||text(a.id).localeCompare(text(b.id));
  });
}
