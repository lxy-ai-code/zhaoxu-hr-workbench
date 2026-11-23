// Shared by the browser and Node. This is a view projection only: no source
// records are mutated, no network is called, and display-only age never enters
// search, sorting, filtering or assessment inputs.
const rows=value=>Array.isArray(value)?value:[];
const text=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const unique=values=>[...new Set(values.filter(Boolean))];
const date=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const latest=(a,b)=>(date(b.lastMessageAt)??-Infinity)-(date(a.lastMessageAt)??-Infinity)||text(a.id).localeCompare(text(b.id));
const knownNumber=value=>typeof value==='number'&&Number.isFinite(value);
const profileFields=['name','age','degree','workYear','salary','position','city','company','school','major','briefIntroduction','introduction','workHistory','education'];
const profileAliases=[['expectedSalary','salary'],['expectedPosition','position'],['intendedPosition','position'],['expectedCity','city'],['highestDegreeName','degree'],['year','workYear'],['ageDesc','age'],['ageRaw','age'],['ageDisplay','age']];
/** Display projection only; an explicit master blank must never revive a snapshot. */
export function candidateMasterProfile(candidate,profile={}){
  const result={...profile};if(!candidate)return result;
  const master=candidate.profileMasterVersion===1,manual=new Set(rows(candidate.profileManualFields));
  for(const key of profileFields)if(master||manual.has(key))result[key]=Object.hasOwn(candidate,key)?candidate[key]:['workHistory','education'].includes(key)?[]:'';
  for(const [alias,key]of profileAliases)if(master||manual.has(key))result[alias]=result[key];
  return result;
}

export const EDUCATION_LEVELS=Object.freeze([
  {value:'junior',label:'初中及以下'},{value:'high_school',label:'高中 / 中专'},{value:'college',label:'大专'},
  {value:'bachelor',label:'本科'},{value:'master',label:'硕士'},{value:'doctor',label:'博士'},
  {value:'in_progress',label:'在读'},{value:'unknown',label:'未取得'},
]);
export function normalizeEducation(value){
  const raw=text(value),unknown={raw,level:'unknown',rank:null,inProgress:false,known:false};
  if(!raw||/不限|不详|未知|未提供|未取得|学历要求|及以上|[\/、]/.test(raw))return unknown;
  const found=[[/博士|Ph\.?D\.?/i,'doctor',6],[/硕士|研究生/,'master',5],[/本科|学士/,'bachelor',4],[/大专|专科/,'college',3],[/高中|中专|中技|技校|职高/,'high_school',2],[/初中|小学|无学历/,'junior',1]].find(([pattern])=>pattern.test(raw));
  if(!found)return unknown;
  if(/在读|在校|未毕业/.test(raw))return {raw,level:'in_progress',targetLevel:found[1],rank:null,inProgress:true,known:true};
  // Postdoctoral training is not itself a returned completed degree.
  if(/博士后/.test(raw)&&!/(?:博士毕业|博士学位)/.test(raw))return unknown;
  return {raw,level:found[1],rank:found[2],inProgress:false,known:true};
}

export function parseWorkExperience(value){
  const raw=text(value),unknown={raw,minYears:null,maxYears:null,known:false,lowerBound:false,upperBound:false};
  if(!raw||/未知|不详|未提供|未取得|不限/.test(raw))return unknown;
  if(/应届|无经验|暂无.*经验|无工作经验/.test(raw))return {...unknown,minYears:0,maxYears:0,known:true};
  let match=raw.match(/^(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*年(?:经验)?$/);
  if(match){const min=Number(match[1]),max=Number(match[2]);return min<=max?{...unknown,minYears:min,maxYears:max,known:true}:unknown;}
  match=raw.match(/^(\d+(?:\.\d+)?)\s*年(?:工作经验|经验)?\s*(以上|及以上|以下|以内)?$/);
  if(!match)return unknown;
  const number=Number(match[1]),lower=/以上/.test(match[2]||''),upper=/以下|以内/.test(match[2]||'');
  return {...unknown,minYears:upper?null:number,maxYears:lower?null:number,known:true,lowerBound:lower,upperBound:upper};
}

export function parseExpectedSalary(value){
  const raw=text(value),unknown={raw,min:null,max:null,period:'unknown',known:false,negotiable:/面议|面谈|协商/.test(raw),lowerBound:false,upperBound:false,periodAssumed:false};
  if(!raw||unknown.negotiable||/未知|保密|不详|未提供|未取得|薪资不限/.test(raw))return unknown;
  const annual=/\/\s*年|每年|年薪|万元?年|万年|annual|year/i.test(raw),monthly=/\/\s*月|每月|月薪|元月|万元?月|万月|monthly|month/i.test(raw);
  if(annual&&monthly)return unknown;
  const explicitPeriod=annual?'year':monthly?'month':null;
  const number='(\\d+(?:\\.\\d+)?)',unit='(k|K|千|万|元)?';
  const clean=raw.replace(/[,，]/g,'').replace(/(?:期望薪资|期望月薪|期望年薪|期望|薪资|月薪|年薪|人民币|RMB|CNY|￥|¥)/gi,'').replace(/\s/g,'');
  const range=clean.match(new RegExp('^'+number+unit+'[-–—~至]'+number+unit));
  const single=range?null:clean.match(new RegExp('^'+number+unit));
  if(!range&&!single)return unknown;
  const inherited=range?(range[4]||range[2]||''):(single[2]||'');
  const multiplier=u=>/k|千/i.test(u)?1000:u==='万'?10000:1;
  const min=Number((range||single)[1])*multiplier((range||single)[2]||inherited);
  const max=range?Number(range[3])*multiplier(range[4]||inherited):min;
  if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<min||max===0)return unknown;
  const suffix=clean.slice((range||single)[0].length);
  if(suffix&&!/^(?:元|人民币)?(?:\/(?:月|年)|每(?:月|年)|(?:month|year|monthly|annual))?(?:[·*×x]\d+(?:薪|个月)?|\d+薪)?(?:以上|及以上|以下|以内|起)?$/i.test(suffix))return unknown;
  // BOSS salaryDesc K/千 values are monthly base-pay displays. Unqualified 万
  // and bare numbers remain period-unknown rather than silently annualising.
  const inferredMonth=/k|千/i.test(inherited);
  const period=explicitPeriod||(inferredMonth?'month':'unknown');
  const lower=/以上|及以上|起$/.test(suffix),upper=/以下|以内/.test(suffix);
  return {...unknown,min:upper?null:min,max:lower?null:max,period,known:true,lowerBound:lower,upperBound:upper,periodAssumed:!explicitPeriod&&inferredMonth};
}

function verifiedProfile(conversation){
  const meta=conversation.profileMeta,profile=conversation.profile;
  if(!profile||!meta||!conversation.sourceAccountKey||!conversation.externalId||!conversation.peerId)return null;
  if(meta.accountKey!==conversation.sourceAccountKey||meta.currentConversationId!==conversation.externalId||meta.currentPeerId!==conversation.peerId)return null;
  if(profile.sourceAccountKey&&profile.sourceAccountKey!==conversation.sourceAccountKey)return null;
  if(profile.candidateExternalId&&profile.candidateExternalId!==conversation.candidateExternalId)return null;
  return profile;
}
function ownedCandidate(state,conversation){
  if(!conversation.sourceAccountKey||!conversation.candidateExternalId)return null;
  const found=rows(state.candidates).filter(row=>row.source==='boss'&&row.sourceAccountKey===conversation.sourceAccountKey&&row.externalId===conversation.candidateExternalId);
  return found.length===1?found[0]:null;
}
function retiredOnline(row){
  const sources=[row?.kind,row?.materialKind,row?.source,row?.sourceMeta?.source].map(text).join(' ');
  const coverage=[row?.coverage,row?.sourceMeta?.coverage,row?.sourceMeta?.rendering].map(text).join(' ');
  return /(?:^|\s)(?:online|boss_online)(?:\s|$)/i.test(sources)||Boolean(row?.onlineData)||/online_resume|wasm_canvas|canvas_ocr/i.test(coverage);
}
function attachmentFor(state,conversation,candidate,application){
  const attachments=rows(state.resumes).filter(row=>candidate&&!retiredOnline(row)&&row.candidateId===candidate.id&&(!row.applicationId||row.applicationId===application?.id));
  const parsed=attachments.filter(row=>row.textStatus==='parsed'&&text(row.text));
  const explicit=conversation.collection?.resumeStatus;
  return {status:parsed.length?'parsed':attachments.length?'downloaded':explicit==='not_available'?'not_available':'unknown',count:attachments.length,parsedCount:parsed.length,resumeIds:attachments.map(row=>row.id)};
}
const ageValue=value=>{const raw=text(value);return !raw||raw==='0'||/未知|未提供|未取得/.test(raw)?'':typeof value==='number'?`${raw}岁`:raw;};
function projectConversation(state,conversation){
  const verified=verifiedProfile(conversation),candidate=ownedCandidate(state,conversation),profile=candidateMasterProfile(candidate,verified||{}),fieldSources={},manual=new Set(rows(candidate?.profileManualFields));
  const profileAt=verified?(conversation.profileMeta?.capturedAt||verified.sourceCapturedAt||conversation.profileUpdatedAt):null;
  function pick(field,profileValues,candidateValues,fallbackValues=[]){
    const canonical={expectedSalary:'salary',expectedPosition:'position',currentPosition:'workHistory'}[field]||field;
    if(candidate&&(candidate.profileMasterVersion===1||manual.has(canonical))){
      fieldSources[field]={kind:'candidate_archive',label:'候选人主档',capturedAt:candidate.updatedAt||candidate.capturedAt||null};
      return field==='currentPosition'?text(rows(candidate.workHistory)[0]?.position):text(candidate[canonical]);
    }
    const groups=[[verified?profileValues:[],'boss_profile','BOSS 职业资料',profileAt],[candidate?candidateValues:[],'candidate_archive','已保存候选档案',candidate?.capturedAt],[fallbackValues,'conversation_preview','BOSS 沟通列表',conversation.importedAt]];
    for(const [values,kind,label,capturedAt]of groups){const value=rows(values).map(text).find(Boolean);if(value){fieldSources[field]={kind,label,capturedAt:capturedAt||null};return value;}}
    fieldSources[field]={kind:'unknown',label:'来源未提供',capturedAt:null};return '';
  }
  const work=rows(profile?.workHistory)[0]||{},candidateWork=rows(candidate?.workHistory)[0]||{};
  const name=pick('name',[profile?.name],[candidate?.name],[conversation.peerName])||'姓名未提供';
  const degree=pick('degree',[profile?.degree],[candidate?.degree]),workYear=pick('workYear',[profile?.workYear],[candidate?.workYear]);
  const expectedSalary=pick('expectedSalary',[profile?.expectedSalary,profile?.salary],[candidate?.expectedSalary,candidate?.salary]);
  const city=pick('city',[profile?.expectedCity,profile?.city],[candidate?.expectedCity,candidate?.city]);
  const expectedPosition=pick('expectedPosition',[profile?.expectedPosition,profile?.position],[candidate?.expectedPosition,candidate?.position],[conversation.peerPosition]);
  const company=pick('company',[work.company],[candidate?.company,candidateWork.company],[conversation.peerCompany]);
  const currentPosition=pick('currentPosition',[work.position],[candidateWork.position]);
  const ageRaw=ageValue(pick('age',profile?[ageValue(profile.age),ageValue(profile.ageRaw),ageValue(profile.ageDisplay)]:[],candidate?[ageValue(candidate.age),ageValue(candidate.ageRaw),ageValue(candidate.ageDisplay)]:[]));
  fieldSources.age.displayOnly=true;
  const requirement=rows(state.requirements).find(row=>row.id===conversation.requirementId);
  const application=candidate&&requirement?rows(state.applications).find(row=>row.candidateId===candidate.id&&row.requirementId===requirement.id):null;
  const communicatedPosition=text(conversation.communicatedPosition)||(verified?text(profile.communicatedPosition):'');
  const platformJobId=text(conversation.communicatedJobExternalId||conversation.communicatedJobNumericId)||(verified?text(profile.communicatedJobExternalId||profile.communicatedJobNumericId):'');
  const jobContext={conversationId:conversation.id,platformJobId,jobKey:platformJobId?`${conversation.sourceAccountKey}:${platformJobId}`:'',title:communicatedPosition,requirementId:requirement?.id||null,requirementTitle:requirement?.title||'',mappingStatus:conversation.jobMappingStatus||'job_unknown'};
  const education=normalizeEducation(degree),experience=parseWorkExperience(workYear),salaryRange=parseExpectedSalary(expectedSalary),replyPriority=conversation.replyPriority||null;
  const score=replyPriority&&!replyPriority.stale&&knownNumber(replyPriority.score)&&replyPriority.score>=0&&replyPriority.score<=100?replyPriority.score:null;
  const attachment=attachmentFor(state,conversation,candidate,application);
  const identityKey=conversation.sourceAccountKey&&conversation.candidateExternalId?`boss:${conversation.sourceAccountKey}:${conversation.candidateExternalId}`:`conversation:${conversation.sourceAccountKey||'unknown'}:${conversation.id}`;
  const reference=Object.fromEntries(['id','externalId','peerId','sourceAccountKey','candidateExternalId','peerName','communicatedJobExternalId','communicatedJobNumericId','communicatedPosition','requirementId','jobMappingStatus','lastMessageAt','communicationStatus'].filter(key=>conversation[key]!==undefined).map(key=>[key,conversation[key]]));
  return {id:conversation.id,identityKey,sourceAccountKey:conversation.sourceAccountKey||'',candidateExternalId:conversation.candidateExternalId||'',candidateId:candidate?.id||null,applicationId:application?.id||null,conversationId:conversation.id,primaryConversationId:conversation.id,conversationIds:[conversation.id],conversations:[reference],name,ageRaw,ageDisplay:ageRaw||'—',degree,education,degreeRank:education.rank,workYear,experience,experienceYears:experience.minYears,expectedSalary,salary:expectedSalary,salaryRange,salaryMinK:salaryRange.period==='month'&&salaryRange.min!==null?salaryRange.min/1000:null,salaryMaxK:salaryRange.period==='month'&&salaryRange.max!==null?salaryRange.max/1000:null,city,expectedPosition,company,currentPosition,communicatedPosition,communicatedPositions:communicatedPosition?[communicatedPosition]:[],requirementId:requirement?.id||null,requirementTitle:requirement?.title||'',jobContexts:[jobContext],attachment,attachmentStatus:attachment.status,replyPriority,priorityScore:score,score,priorityBand:replyPriority?.stale?'stale':replyPriority?.band||'unassessed',lastMessageAt:conversation.lastMessageAt||null,unreadCount:Number.isFinite(conversation.unreadCount)?Math.max(0,conversation.unreadCount):null,communicationStatus:conversation.communicationStatus||'new',fieldSources,profile,profileVerified:Boolean(verified),profileKnown:Boolean(verified||candidate),profileCapturedAt:profileAt||candidate?.capturedAt||null,identityConflict:Boolean(conversation.candidateId&&conversation.candidateId!==candidate?.id)};
}

export function projectConversationInbox(state={}){return rows(state.conversations).filter(row=>row.source==='boss').map(row=>projectConversation(state,row)).sort(latest);}
export function projectCandidateInbox(state={}){
  const groups=new Map();
  for(const row of projectConversationInbox(state)){if(!groups.has(row.identityKey))groups.set(row.identityKey,[]);groups.get(row.identityKey).push(row);}
  return [...groups.values()].map(contextRows=>candidateGroup(contextRows,contextRows[0]));
}
function candidateGroup(contextRows,primary){
  const conversations=contextRows.map(row=>row.conversations[0]);
  return {...primary,id:primary.identityKey,conversationIds:contextRows.map(row=>row.conversationId),conversations,contextRows,jobContexts:contextRows.flatMap(row=>row.jobContexts),communicatedPositions:unique(contextRows.map(row=>row.communicatedPosition)),conversationCount:contextRows.length};
}
function contextMatches(row,filters){
  const context=row.jobContexts[0],job=text(filters.jobId||filters.job),requirement=text(filters.requirementId);
  if(job&&![context.jobKey,context.platformJobId,context.requirementId].includes(job))return false;
  if(requirement&&context.requirementId!==requirement)return false;
  return true;
}
export function chooseCandidateContext(row,filters={}){
  rejectAgeFilters(filters);
  // Apply all constraints to one conversation before choosing its score and
  // attachments. A person's older role may be the matching context; fields
  // from separate roles must never be combined into a synthetic match.
  const contexts=rows(row.contextRows).length?row.contextRows:[row],matching=contexts.filter(context=>contextMatches(context,filters)&&contextFieldsMatch(context,filters)).sort(latest);
  return matching.length?candidateGroup(contexts,matching[0]):null;
}
function rejectAgeFilters(filters){if(Object.entries(filters).some(([key,value])=>/^(?:age|年龄)/i.test(key)&&value!==undefined&&value!==null&&value!==''))throw new Error('年龄仅用于原始资料展示，不支持年龄筛选。');}
const bound=value=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;
function contextFieldsMatch(row,filters){
  const query=text(filters.query).toLowerCase(),degree=text(filters.degree),city=text(filters.city).toLowerCase();
  const expMin=bound(filters.experienceMin),expMax=bound(filters.experienceMax),salaryMin=bound(filters.salaryMinYuan)??(bound(filters.salaryMin)!==null?bound(filters.salaryMin)*1000:null),salaryMax=bound(filters.salaryMaxYuan)??(bound(filters.salaryMax)!==null?bound(filters.salaryMax)*1000:null);
  if(expMin!==null&&expMax!==null&&expMin>expMax||salaryMin!==null&&salaryMax!==null&&salaryMin>salaryMax)return false;
    if(query&&![row.name,row.company,row.currentPosition,row.degree,row.city,row.expectedPosition,...row.communicatedPositions,...row.jobContexts.map(context=>context.requirementTitle)].join(' ').toLowerCase().includes(query))return false;
    if(degree&&degree!=='all'&&row.education.level!==degree&&row.degree!==degree)return false;
    if(city&&!row.city.toLowerCase().includes(city))return false;
    if(filters.position&&row.expectedPosition!==filters.position)return false;
    if(expMin!==null||expMax!==null){if(!row.experience.known)return false;const min=row.experience.minYears??0,max=row.experience.maxYears??Infinity;if(expMin!==null&&max<expMin||expMax!==null&&min>expMax)return false;}
    if(salaryMin!==null||salaryMax!==null){if(!row.salaryRange.known||row.salaryRange.period!=='month')return false;const min=row.salaryRange.min??0,max=row.salaryRange.max??Infinity;if(salaryMin!==null&&max<salaryMin||salaryMax!==null&&min>salaryMax)return false;}
    if(filters.salaryPeriod&&row.salaryRange.period!==filters.salaryPeriod)return false;
    const attachment=text(filters.attachment);if(attachment&&attachment!=='all'&&(attachment==='available'?!['parsed','downloaded'].includes(row.attachment.status):attachment==='missing'?!['not_available','unknown'].includes(row.attachment.status):row.attachment.status!==attachment))return false;
    const priority=text(filters.priority);if(priority&&priority!=='all'&&(priority==='assessed'?!row.replyPriority:priority==='unassessed'?Boolean(row.replyPriority):priority==='stale'?!row.replyPriority?.stale:row.priorityBand!==priority))return false;
    if(filters.status&&row.communicationStatus!==filters.status)return false;
    if(filters.hasUnread===true&&!(row.unreadCount>0))return false;
    if(filters.profile==='known'&&!row.profileKnown||filters.profile==='unknown'&&row.profileKnown)return false;
  return true;
}
export function filterCandidateInboxRows(values,filters={}){
  rejectAgeFilters(filters);
  return rows(values).map(row=>chooseCandidateContext(row,filters)).filter(Boolean);
}
function numericCompare(a,b,direction){const ak=knownNumber(a),bk=knownNumber(b);if(ak!==bk)return ak?-1:1;return ak?(a-b)*direction:0;}
export function sortCandidateInboxRows(values,sort='latest'){
  if(/age|年龄/i.test(typeof sort==='string'?sort:sort?.field||''))throw new Error('年龄仅用于原始资料展示，不支持年龄排序。');
  const aliases={education_desc:'degree_desc',education_asc:'degree_asc',experience:'experience_desc',salary:'salary_asc'};const mode=aliases[sort]||sort;
  return [...rows(values)].sort((a,b)=>{
    let result=0;
    if(mode==='priority')result=numericCompare(a.priorityScore,b.priorityScore,-1);
    else if(mode==='degree_asc'||mode==='degree_desc')result=numericCompare(a.education.rank,b.education.rank,mode.endsWith('asc')?1:-1);
    else if(mode==='experience_asc'||mode==='experience_desc')result=numericCompare(a.experience.minYears,b.experience.minYears,mode.endsWith('asc')?1:-1);
    else if(/^salary(?:_max)?_(?:asc|desc)$/.test(mode)){const field=mode.startsWith('salary_max')?'max':'min',value=row=>row.salaryRange.period==='month'?row.salaryRange[field]:null;result=numericCompare(value(a),value(b),mode.endsWith('asc')?1:-1);}
    else if(mode==='name')result=a.name.localeCompare(b.name,'zh-CN');
    return result||latest(a,b);
  });
}

