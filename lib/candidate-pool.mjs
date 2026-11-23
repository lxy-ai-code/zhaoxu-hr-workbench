import { createHash, randomUUID } from 'node:crypto';
import { mergeBossCandidateFields, ensureCandidateMaster } from './candidate-master.mjs';

export const POOL_CHANNELS = Object.freeze({ boss_search: 'BOSS 搜索/推荐', boss_message: 'BOSS 消息', manual_resume: '人工简历入库', legacy_workflow: '历史招聘流程' });
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const stamp = () => new Date().toISOString();
const arr = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const validId = value => typeof value === 'string' && Boolean(value.trim());
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { code: 'candidate_pool_validation', statusCode });
const sameIdentity = (candidate, account, externalId) => candidate.source === 'boss' && candidate.sourceAccountKey === account && candidate.externalId === externalId;
const candidateIdentity = (account, externalId) => `boss:${account}:${externalId}`;
const sourceIdFor = (account, externalId) => `src_${digest(`boss_search:${account}:${externalId}`).slice(0,24)}`;
const ownProfileFields = ['name','city','workYear','degree','salary','position','expectedPosition','expectedCity','expectedSalary','company','school','major','introduction','activeDesc','applyStatusDesc','sourceCapturedAt'];

/** A captured source has its own profile. Unknown transport/security fields and
 * membership state are never copied out of a platform result into the master. */
export function projectSearchProfile(row = {}) {
  const profile = Object.fromEntries(ownProfileFields.filter(key => typeof row[key] === 'string').map(key => [key,row[key]]));
  if (typeof row.age === 'string') profile.age = row.age;
  if (typeof row.ageRaw === 'string') profile.ageRaw = row.ageRaw;
  if (Array.isArray(row.workHistory)) profile.workHistory = row.workHistory.map(item => Object.fromEntries(['company','position','description','dateRange','startDate','endDate'].filter(key=>typeof item?.[key]==='string').map(key=>[key,item[key]])));
  if (Array.isArray(row.education)) profile.education = row.education.map(item => Object.fromEntries(['school','major','degree','dateRange','startDate','endDate'].filter(key=>typeof item?.[key]==='string').map(key=>[key,item[key]])));
  if (row.displayMeta && typeof row.displayMeta === 'object' && !Array.isArray(row.displayMeta)) {
    profile.displayMeta = Object.fromEntries([...ownProfileFields,'age','ageRaw'].filter(key=>row.displayMeta[key] && typeof row.displayMeta[key]==='object').map(key=>[key,Object.fromEntries(['source','sourceField','capturedAt','status','reason','displayOnly'].filter(field=>['string','boolean'].includes(typeof row.displayMeta[key][field])).map(field=>[field,row.displayMeta[key][field]]))]));
  }
  if (profile.age || profile.ageRaw) { profile.displayMeta ??= {}; profile.displayMeta.age = {...profile.displayMeta.age,displayOnly:true}; }
  return profile;
}

export const isCandidateInPool = candidate => Boolean(candidate?.pool && typeof candidate.pool === 'object' && !Array.isArray(candidate.pool));

/** No I/O. This deliberately does not create an application or admit a person. */
export function upsertSearchProspects(state, rows, requirementId = null, { at = stamp() } = {}) {
  if (requirementId && !arr(state.requirements).some(row=>row.id===requirementId)) throw fail('请先选择有效招聘需求。');
  if (!validDate(at)) throw fail('搜索资料保存时间无效。');
  for (const source of rows) if (!validId(source?.externalId) || !validId(source?.sourceAccountKey) || source.source && source.source !== 'boss') throw fail('BOSS 返回缺少平台标识或账号范围，已停止导入。');
  state.candidates ??= []; state.sourcingCandidates ??= []; state.applications ??= [];
  let imported = 0, deduplicated = 0, updated = 0;
  const prospectIds = [];
  for (const source of rows) {
    const account=source.sourceAccountKey,externalId=source.externalId,profile=projectSearchProfile(source);
    let candidate=state.candidates.find(row=>sameIdentity(row,account,externalId));
    if (!candidate) {
      candidate={...structuredClone(profile),source:'boss',sourceAccountKey:account,externalId,id:`cand_${digest(candidateIdentity(account,externalId)).slice(0,24)}`,sourceLabel:source.sourceLabel||'BOSS 搜索/推荐资料',capturedAt:source.capturedAt||at,createdAt:at,updatedAt:at};
      state.candidates.push(candidate); imported++;
    } else {
      // A newer conversation summary remains the master view; it cannot replace
      // this observation's search evidence, and search cannot replace that card.
      if (!candidate.sourceConversationId && !/沟通/.test(text(candidate.sourceLabel))) {
        mergeBossCandidateFields(candidate,profile,{source:'boss_search',capturedAt:source.capturedAt||at});
        Object.assign(candidate,{capturedAt:source.capturedAt||at,sourceLabel:source.sourceLabel||candidate.sourceLabel||'BOSS 搜索/推荐资料'});
      } else {
        mergeBossCandidateFields(candidate,profile,{source:'boss_search',capturedAt:source.capturedAt||at,fillOnly:true});
      }
      candidate.updatedAt=at;deduplicated++;
    }
    let prospect=state.sourcingCandidates.find(row=>row.sourceAccountKey===account && row.externalId===externalId && ['boss_search',undefined].includes(row.channel));
    if (prospect && prospect.candidateId && prospect.candidateId!==candidate.id) throw fail('搜索资料关联的人选与平台身份不一致，未合并。',409);
    const fields={channel:'boss_search',source:'boss_search',candidateId:candidate.id,sourceAccountKey:account,externalId,profile:structuredClone(profile),capturedAt:source.capturedAt||at,sourceLabel:source.sourceLabel||'BOSS 搜索/推荐资料',updatedAt:at};
    if (requirementId) {fields.requirementId=requirementId;fields.requirementSource='selected_requirement';}
    if (prospect) {Object.assign(prospect,fields);updated++;}
    else {prospect={...fields,id:sourceIdFor(account,externalId),requirementId:requirementId||null,createdAt:at};state.sourcingCandidates.push(prospect);}
    prospectIds.push(prospect.id);
  }
  ensureCandidateMaster(state);
  return {imported,deduplicated,updated,applicationsAdded:0,prospectIds};
}

function exactConversation(candidate, conversation) {
  return conversation.source==='boss' && conversation.sourceAccountKey===candidate.sourceAccountKey && conversation.candidateExternalId===candidate.externalId && (!conversation.candidateId || conversation.candidateId===candidate.id);
}
function historicalEvidence(state,candidate) {
  const applications=arr(state.applications).filter(row=>row.candidateId===candidate.id);
  if (applications.some(row=>row.stage && row.stage!=='new' || row.reviewStatus==='reviewed' || text(row.notes).trim())) return true;
  if (arr(state.interviews).some(row=>row.candidateId===candidate.id || applications.some(app=>app.id===row.applicationId))) return true;
  return arr(state.conversations).some(row=>exactConversation(candidate,row) && (text(row.notes).trim() || row.followUpAt));
}

/** Adds explicit historical provenance without pretending an automatic import
 * or an attachment download was an HR admission decision. */
export function ensureCandidatePoolState(state,{at=stamp()}={}) {
  let changed=false;
  // Historical workflow evidence is an upgrade compatibility rule, not an
  // ongoing admission rule. New source notes or follow-up dates must never
  // become an implicit HR admission on a later service restart.
  const migrateHistoricalMembership=!(Number.isInteger(state.candidatePoolMigration?.version)&&state.candidatePoolMigration.version>=1);
  for (const key of ['candidates','sourcingCandidates']) if (!Array.isArray(state[key])) {state[key]=[];changed=true;}
  for (const candidate of state.candidates) {
    const bossIdentified=candidate.source==='boss' && validId(candidate.sourceAccountKey) && validId(candidate.externalId);
    let prospect=bossIdentified?state.sourcingCandidates.find(row=>row.sourceAccountKey===candidate.sourceAccountKey && row.externalId===candidate.externalId && row.channel==='boss_search'):null;
    if (bossIdentified && !prospect && /快照|搜索|推荐/.test(text(candidate.sourceLabel))) {
      const requirements=[...new Set(arr(state.applications).filter(row=>row.candidateId===candidate.id && arr(state.requirements).some(req=>req.id===row.requirementId)).map(row=>row.requirementId))];
      prospect={id:sourceIdFor(candidate.sourceAccountKey,candidate.externalId),channel:'boss_search',source:'boss_search',candidateId:candidate.id,sourceAccountKey:candidate.sourceAccountKey,externalId:candidate.externalId,profile:projectSearchProfile(candidate),requirementId:requirements.length===1?requirements[0]:null,requirementSource:requirements.length===1?'legacy_application':'unassigned',capturedAt:validDate(candidate.capturedAt)?candidate.capturedAt:null,createdAt:candidate.createdAt||at,updatedAt:candidate.updatedAt||at,legacyImported:true};
      state.sourcingCandidates.push(prospect);changed=true;
    }
    if (!migrateHistoricalMembership || isCandidateInPool(candidate) || !historicalEvidence(state,candidate)) continue;
    const conversation=arr(state.conversations).find(row=>exactConversation(candidate,row));
    const channel=prospect?'boss_search':conversation?'boss_message':'legacy_workflow',sourceId=prospect?.id||conversation?.id||candidate.id;
    candidate.pool={joinedAt:null,joinedAtBasis:'historical_time_unknown',primaryChannel:'legacy_workflow',admissionMode:'historical_workflow',admissionSourceUnknown:true,migratedAt:at,sources:[{channel,sourceId,addedAt:null,addedAtBasis:'historical_time_unknown',requirementId:null}]};changed=true;
  }
  if(migrateHistoricalMembership){state.candidatePoolMigration={version:1,completedAt:at};changed=true;}
  return changed;
}

function resolveSource(state,channel,sourceId) {
  if (channel==='boss_search') {
    const row=arr(state.sourcingCandidates).find(row=>row.id===sourceId);
    if(!row || row.channel!=='boss_search' || !validId(row.sourceAccountKey) || !validId(row.externalId))throw fail('搜索/推荐来源不存在或缺少平台身份。',404);
    const candidate=arr(state.candidates).find(item=>sameIdentity(item,row.sourceAccountKey,row.externalId));
    if(!candidate || row.candidateId && row.candidateId!==candidate.id)throw fail('搜索来源关联的人选与平台身份不一致，未入池。',409);
    return {row,candidate,requirementId:row.requirementId||null};
  }
  if (channel==='boss_message') {
    const row=arr(state.conversations).find(row=>row.id===sourceId);
    if(!row || row.source!=='boss' || !validId(row.sourceAccountKey) || !validId(row.candidateExternalId) || !validId(row.externalId) || !validId(row.peerId))throw fail('消息来源不存在或缺少明确的平台身份。',404);
    let candidate=arr(state.candidates).find(item=>sameIdentity(item,row.sourceAccountKey,row.candidateExternalId));
    if(row.candidateId && row.candidateId!==candidate?.id)throw fail('沟通来源已关联其他平台身份，未入池。',409);
    if (!candidate) {
      const verified=row.profile && row.profile.sourceAccountKey===row.sourceAccountKey && row.profileMeta?.accountKey===row.sourceAccountKey && row.profileMeta.currentConversationId===row.externalId && row.profileMeta.currentPeerId===row.peerId;
      const profile=verified?projectSearchProfile(row.profile):{};
      candidate={...profile,name:profile.name||row.peerName||'姓名未提供',position:profile.expectedPosition||profile.position||row.peerPosition||'',company:profile.workHistory?.[0]?.company||row.peerCompany||'',source:'boss',sourceAccountKey:row.sourceAccountKey,externalId:row.candidateExternalId,id:`cand_${digest(candidateIdentity(row.sourceAccountKey,row.candidateExternalId)).slice(0,24)}`,sourceConversationId:row.id,sourceLabel:'BOSS 沟通资料摘要'};
    }
    return {row,candidate,requirementId:row.requirementId||null};
  }
  throw fail('请选择 BOSS 搜索/推荐或 BOSS 消息来源。');
}

export function joinCandidatePool(state,input={}, {at=stamp()}={}) {
  if(!validDate(at) || !validId(input.sourceId))throw fail('来源标识或加入时间无效。');
  if(Object.hasOwn(input,'requirementId') && input.requirementId && !arr(state.requirements).some(row=>row.id===input.requirementId))throw fail('选择的招聘需求不存在。',404);
  const {row,candidate,requirementId:sourceRequirement}=resolveSource(state,input.channel,input.sourceId);
  const requirementId=Object.hasOwn(input,'requirementId')?(input.requirementId||null):(arr(state.requirements).some(req=>req.id===sourceRequirement)?sourceRequirement:null);
  const alreadyInPool=isCandidateInPool(candidate);
  const membership=alreadyInPool?candidate.pool:{joinedAt:at,primaryChannel:input.channel,admissionMode:'manual',sources:[]};
  membership.sources??=[];
  const sourceAdded=!membership.sources.some(item=>item.channel===input.channel && item.sourceId===input.sourceId && (item.requirementId||null)===requirementId);
  if(sourceAdded)membership.sources.push({channel:input.channel,sourceId:input.sourceId,addedAt:at,requirementId});
  state.candidates??=[];state.applications??=[];
  if(!state.candidates.some(item=>item.id===candidate.id)){candidate.createdAt=at;state.candidates.push(candidate);}
  candidate.pool=membership;candidate.updatedAt=at;
  if(input.channel==='boss_message')row.candidateId=candidate.id;
  let application=requirementId?state.applications.find(item=>item.candidateId===candidate.id && item.requirementId===requirementId):null;
  if(requirementId&&!application){application={id:`app_${randomUUID()}`,candidateId:candidate.id,requirementId,stage:'new',reviewStatus:'pending',evidence:[],notes:'',createdAt:at,updatedAt:at};state.applications.push(application);}
  return {candidate,membership,source:{channel:input.channel,sourceId:input.sourceId},applicationId:application?.id||null,alreadyInPool,sourceAdded};
}
