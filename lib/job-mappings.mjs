import { digest, now } from './store.mjs';

const text=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isSafeInteger(value)?String(value):'';
const keys=job=>[job.externalId,job.numericJobId,...(job.externalIds||[])].map(text).filter(Boolean);
const fail=message=>Object.assign(new Error(message),{statusCode:400});
export function ensureJobMappingState(state) {
  if(Array.isArray(state.bossJobs))return false;
  state.bossJobs=[];return true;
}
export function jobForConversation(state,conversation) {
  const scope=conversation.sourceAccountKey;
  const external=text(conversation.communicatedJobExternalId||conversation.profile?.communicatedJobExternalId);
  const numeric=text(conversation.communicatedJobNumericId||conversation.profile?.communicatedJobNumericId);
  const ids=[external,numeric].filter(Boolean);
  if(!scope||!ids.length)return null;
  const found=(state.bossJobs||[]).filter(job=>job.sourceAccountKey===scope&&keys(job).some(id=>ids.includes(id)));
  return found.length===1?found[0]:null;
}
function initialRequirement(state,job) {
  const found=state.requirements.filter(row=>keys(job).includes(text(row.sourceJobId))&&(row.sourceAccountKey||row.jdSource?.accountKey)===job.sourceAccountKey);
  return found.length===1?found[0].id:null;
}
export function upsertBossJobs(state,result) {
  ensureJobMappingState(state);
  if(!Array.isArray(result.jobs)||!result.meta?.accountKey)throw fail('平台岗位列表缺少可核对的来源账号或结构。');
  let imported=0,updated=0,linkedFromSource=0;
  const seen=new Set();
  for(const source of result.jobs) {
    const scope=text(source.sourceAccountKey||result.meta.accountKey),externalId=text(source.externalId),numericJobId=text(source.numericJobId);
    if(scope!==result.meta.accountKey||!externalId)throw fail('岗位缺少稳定标识或来源账号不一致，未按名称合并。');
    const aliases=[...new Set([externalId,numericJobId,...(source.externalIds||[]).map(text)].filter(Boolean))];
    const matches=state.bossJobs.filter(row=>row.sourceAccountKey===scope&&keys(row).some(id=>aliases.includes(id)));
    if(matches.length>1)throw fail('平台岗位标识出现冲突，未自动合并。');
    let job=matches[0];
    const data={externalId,numericJobId:numericJobId||job?.numericJobId||'',externalIds:[...new Set([...(job?keys(job):[]),...aliases])],sourceAccountKey:scope,source:'boss',title:text(source.title),city:text(source.city),salaryRange:text(source.salaryRange),status:source.status??'unknown',statusText:text(source.statusText)||({open:'开放中',closed:'已关闭',pending:'待开放',reviewing:'审核中',rejected:'审核未过',expired:'已过期'}[source.status]||'来源状态待确认'),jd:typeof source.jd==='string'?source.jd:'',capturedAt:source.capturedAt||result.meta.capturedAt||now(),lastSeenAt:now(),listedInLastSync:true,updatedAt:now()};
    if(job){if(!data.jd)data.jd=job.jd||'';Object.assign(job,data);updated++;}
    else {job={...data,id:`bossjob_${digest(`${scope}:${externalId}`).slice(0,24)}`,requirementId:null,mappingSource:'unmapped',createdAt:now()};job.requirementId=initialRequirement(state,job);if(job.requirementId){job.mappingSource='verified_source_identity';linkedFromSource++;}state.bossJobs.push(job);imported++;}
    seen.add(job.id);
  }
  if(result.meta.complete===true||result.meta.completeAsReported===true)for(const job of state.bossJobs.filter(row=>row.sourceAccountKey===result.meta.accountKey&&!seen.has(row.id)))job.listedInLastSync=false;
  state.jobMappingCoverage={...result.meta,complete:result.meta.complete===true||result.meta.completeAsReported===true,sourceAccountKey:result.meta.accountKey,loadedCount:result.jobs.length,message:result.message||result.meta.message||'已读取平台本次返回的岗位。'};
  return {imported,updated,linkedFromSource,...reconcileAllConversationJobs(state)};
}
export function reconcileConversationJob(state,conversation) {
  const job=jobForConversation(state,conversation);
  conversation.bossJobId=job?.id||null;
  if(!conversation.requirementSource)conversation.requirementSource=conversation.requirementId?'manual':'unmapped';
  const mapped=job?.requirementId||null;
  if(Object.hasOwn(conversation,'lastMappedRequirementId')&&conversation.lastMappedRequirementId!==mapped)delete conversation.jobMappingResolution;
  conversation.lastMappedRequirementId=mapped;
  if(conversation.requirementSource==='boss_job_mapping') {
    conversation.requirementId=mapped;
    if(!mapped)conversation.requirementSource='unmapped';
  } else if(!conversation.requirementId&&mapped&&conversation.requirementSource!=='manual') {
    conversation.requirementId=mapped;conversation.requirementSource='boss_job_mapping';
  }
  if(mapped&&conversation.requirementId&&conversation.requirementId!==mapped) {
    const resolution=conversation.jobMappingResolution;
    const confirmed=resolution?.decision==='keep_manual'&&resolution.bossJobId===job.id&&resolution.mappedRequirementId===mapped&&resolution.manualRequirementId===conversation.requirementId;
    conversation.jobMappingConflict={bossJobId:job.id,mappedRequirementId:mapped,manualRequirementId:conversation.requirementId,reason:'平台沟通岗位关联的需求与人工选择的需求不同。',resolution:confirmed?'keep_manual':null,confirmed};
  } else conversation.jobMappingConflict=null;
  conversation.jobMappingStatus=conversation.requirementSource==='manual'&&!conversation.requirementId?'manual_unlinked':conversation.jobMappingConflict?(conversation.jobMappingConflict.confirmed?'manual_override':'conflict'):mapped?'mapped':job?'unmapped':'job_unknown';
  return conversation;
}
export function reconcileAllConversationJobs(state) {
  for(const row of state.conversations||[])reconcileConversationJob(state,row);
  return {mappedConversations:(state.conversations||[]).filter(row=>row.jobMappingStatus==='mapped').length,manualOverrideConversations:(state.conversations||[]).filter(row=>row.jobMappingStatus==='manual_override').length,unresolvedConflicts:(state.conversations||[]).filter(row=>row.jobMappingConflict&&!row.jobMappingConflict.confirmed).length};
}
export function setBossJobMapping(state,id,requirementId) {
  const job=(state.bossJobs||[]).find(row=>row.id===id);if(!job)throw fail('BOSS岗位不存在，请先同步岗位列表。');
  if(requirementId&&!state.requirements.some(row=>row.id===requirementId))throw fail('请选择有效的招聘需求。');
  job.requirementId=requirementId||null;job.mappingSource='manual';job.mappingReviewedAt=now();job.updatedAt=now();
  return {job,...reconcileAllConversationJobs(state)};
}
export function resolveConversationJobMapping(state,conversation,decision) {
  const job=jobForConversation(state,conversation);
  if(!job?.requirementId)throw fail('当前沟通岗位尚未关联招聘需求，请先到岗位关联页设置。');
  if(decision==='use_mapping') {
    conversation.requirementId=job.requirementId;conversation.requirementSource='boss_job_mapping';conversation.jobMappingResolution={decision,bossJobId:job.id,mappedRequirementId:job.requirementId,at:now()};
  } else if(decision==='keep_manual') {
    if(!conversation.requirementId)throw fail('尚未选择人工招聘需求，无法保留空值。');
    conversation.requirementSource='manual';conversation.jobMappingResolution={decision,bossJobId:job.id,mappedRequirementId:job.requirementId,manualRequirementId:conversation.requirementId,at:now()};
  } else throw fail('请选择采用岗位关联或保留人工需求。');
  return reconcileConversationJob(state,conversation);
}
export function buildCandidateJobContext(state,candidate,requirement) {
  if(!candidate)return {applicationRequirement:{id:requirement?.id,title:requirement?.title,version:requirement?.version},communicatingJobs:[],conflicts:[]};
  const conversations=(state.conversations||[]).filter(row=>{
    if(candidate.source==='boss'&&(row.sourceAccountKey!==candidate.sourceAccountKey||row.candidateExternalId!==candidate.externalId))return false;
    return row.candidateId?row.candidateId===candidate.id:row.candidateExternalId===candidate.externalId&&row.sourceAccountKey===candidate.sourceAccountKey;
  });
  const communicatingJobs=conversations.map(row=>{
    const job=jobForConversation(state,row),conflict=row.jobMappingConflict;
    return {conversationId:row.id,platformJobId:row.communicatedJobExternalId||row.profile?.communicatedJobExternalId||row.communicatedJobNumericId||null,jobTitle:row.communicatedPosition||row.profile?.communicatedPosition||job?.title||'',bossJobId:job?.id||null,mappedRequirementId:job?.requirementId||null,mappingStatus:row.jobMappingStatus||'job_unknown',sourceAccountKey:row.sourceAccountKey,capturedAt:row.communicatedJobCapturedAt||row.importedAt||row.profileUpdatedAt,confirmed:conflict?.confirmed===true};
  });
  const conflicts=conversations.flatMap(row=>{
    const job=jobForConversation(state,row),conflict=row.jobMappingConflict;
    if(!job?.requirementId||!requirement?.id||job.requirementId===requirement.id)return [];
    return [{conversationId:row.id,currentRequirementId:requirement.id,mappedRequirementId:job.requirementId,bossJobId:job.id,resolution:conflict?.confirmed&&row.requirementId===requirement.id?'keep_manual':null,confirmed:conflict?.confirmed===true&&row.requirementId===requirement.id}];
  });
  return {applicationRequirement:{id:requirement?.id,title:requirement?.title,version:requirement?.version},communicatingJobs,conflicts};
}
