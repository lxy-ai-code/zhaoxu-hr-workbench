import { CANDIDATE_PROFILE_FIELDS, mergeBossCandidateFields } from './candidate-master.mjs';
import { digest, uid, now } from './store.mjs';
import { getBossConversationProfile } from './boss-profile.mjs';
import { getBossConversationMessages } from './boss-messages.mjs';
import { downloadBossResume } from './boss-resumes.mjs';
import { archiveDownloadedResume, RESUME_ROOT } from './resumes.mjs';
import { reconcileConversationJob } from './job-mappings.mjs';
import { importMessageBatch, analyzeConversation } from './conversations.mjs';
import { isRetiredOnlineResume } from './resume-policy.mjs';
import { isCandidateInPool } from './candidate-pool.mjs';

// Native profile GET and authorized original-file download only. Chat history is
// limited to a conversation already opened by the operator; no read receipt,
// attachment request, online-resume viewer, OCR or purchase is performed here.
const blocking = new Set(['need_auth', 'requires_review', 'rate_limited', 'throttled', 'captcha', 'verification_required', 'session_expired', 'challenge_required', 'cdp_unavailable', 'busy']);
const failedStatuses = new Set(['error', 'failed', 'permission_denied', 'shape_changed']);
function acquisitionFailure(result, stage) {
  const stopCode = [result?.code, result?.status].find(code => blocking.has(code));
  if (stopCode) return { status: blocking.has(result?.status) ? result.status : 'error', code: stopCode, stopBatch: true, failedStage: stage, message: result?.message || `${stage}暂不可用，已停止本轮采集。` };
  if (failedStatuses.has(result?.status)) return { status: result.status, code: result.code || result.status, stopBatch: false, failedStage: stage, message: result.message || `${stage}未完成，保留已取得资料供下轮重试。` };
  if (!result || typeof result.status !== 'string') return { status: 'shape_changed', code: 'shape_changed', stopBatch: false, failedStage: stage, message: `${stage}缺少可验证的结果状态，未标记为采集完成。` };
  return null;
}
const fail = message => Object.assign(new Error(message), { code: 'identity_mismatch', statusCode: 400 });
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, structuredClone(row[key])]));
const foundConversation = (state, id) => { const row=(state.conversations||[]).find(item=>item.id===id); if(!row)throw fail('沟通会话不存在。'); return row; };
function selectorsFor(state, row) {
  if(row.source!=='boss'||!row.sourceAccountKey||!row.candidateExternalId||!row.externalId||!row.peerId)throw fail('会话缺少账号、候选人或会话稳定标识，未按姓名猜测归档。');
  return {port:state.settings.cdpPort,conversationId:row.externalId,peerId:row.peerId,candidateExternalId:row.candidateExternalId,sourceAccountKey:row.sourceAccountKey};
}
function assertIdentity(result, selectors) {
  const identity=result.meta?.sourceIdentity;
  if(result.meta?.accountKey!==selectors.sourceAccountKey||identity?.candidateExternalId!==selectors.candidateExternalId||identity?.conversationId!==selectors.conversationId||identity?.peerId!==selectors.peerId)throw fail('附件返回的账号、候选人或会话身份不一致，未归档。');
}
function sameSource(row, selectors) {return row.source==='boss'&&row.sourceAccountKey===selectors.sourceAccountKey&&row.externalId===selectors.candidateExternalId;}
function professionalProjection(profile, conversation) {
  return {name:profile.name||conversation.peerName,position:profile.expectedPosition||profile.position||conversation.peerPosition||'',company:profile.workHistory?.[0]?.company||conversation.peerCompany||'',city:profile.city||'',workYear:profile.workYear||'',degree:profile.degree||'',age:typeof profile.age==='string'?profile.age:'',displayMeta:profile.displayMeta||{},salary:profile.expectedSalary||profile.salary||'',introduction:profile.introduction||'',workHistory:profile.workHistory||[],education:profile.education||[],sourceCapturedAt:profile.sourceCapturedAt};
}

export function createInboxCollector({store,profileAdapter=getBossConversationProfile,messageAdapter=getBossConversationMessages,resumeAdapter=downloadBossResume,archiveResume=archiveDownloadedResume}={}) {
  if(!store?.read||!store?.mutate)throw new Error('Inbox collector requires a workspace store.');
  const busy=new Set();
  async function collectCandidate(conversationId,{refresh=true,downloadAttachments=true}={}) {
    if(busy.has(conversationId))throw Object.assign(new Error('该会话正在采集，请等待完成。'),{code:'busy',statusCode:409});
    busy.add(conversationId);
    let report={status:'partial',conversationId,profileStatus:'not_attempted',historyStatus:'not_attempted',resumeStatus:'not_attempted',coverage:'message_preview_only',startedAt:now()};
    async function saveReport() {
      report.finishedAt=now();
      await store.mutate(draft=>{const row=foundConversation(draft,conversationId);row.collection=pick(report,['status','code','stopBatch','failedStage','message','profileStatus','historyStatus','resumeStatus','resumeId','resumeTextStatus','resumeMessage','attachmentCheck','coverage','startedAt','finishedAt']);row.updatedAt=now();});
      return report;
    }
    try {
      const state=store.read(),conversation=foundConversation(state,conversationId),selectors=selectorsFor(state,conversation);
      const profileResult=await profileAdapter({...selectors,refresh});
      report.profileStatus=profileResult?.status || 'shape_changed';
      const profileFailure=acquisitionFailure(profileResult,'profile');
      if(profileFailure){Object.assign(report,profileFailure);return await saveReport();}
      if(profileResult.profile&&(profileResult.meta?.accountKey!==selectors.sourceAccountKey||profileResult.profile.sourceAccountKey!==selectors.sourceAccountKey||profileResult.meta.currentConversationId!==selectors.conversationId||profileResult.meta.currentPeerId!==selectors.peerId))throw fail('职业资料账号或会话身份与所选沟通人不一致，未建档。');
      let current=await store.mutate(draft=>{
        const row=foundConversation(draft,conversationId);
        if(row.sourceAccountKey!==selectors.sourceAccountKey||row.candidateExternalId!==selectors.candidateExternalId||row.externalId!==selectors.conversationId||row.peerId!==selectors.peerId)throw fail('采集期间会话身份已变化，未混入其他候选人资料。');
        if(profileResult.profile){row.profile=structuredClone(profileResult.profile);row.profileMeta=structuredClone(profileResult.meta);row.profileUpdatedAt=now();for(const key of ['communicatedJobExternalId','communicatedJobNumericId','communicatedPosition'])if(profileResult.profile[key])row[key]=profileResult.profile[key];if(profileResult.profile.communicatedJobExternalId)row.communicatedJobCapturedAt=profileResult.meta.capturedAt||now();}
        reconcileConversationJob(draft,row);
        let candidate=(draft.candidates||[]).find(item=>sameSource(item,selectors));
        if(row.candidateId&&!(candidate&&row.candidateId===candidate.id))throw fail('会话已关联的候选人与平台身份冲突，需人工核对。');
        const profile=profileResult.profile||((row.profileMeta?.accountKey===selectors.sourceAccountKey)?row.profile:{});
        const fields={externalId:selectors.candidateExternalId,source:'boss',sourceAccountKey:selectors.sourceAccountKey,...professionalProjection(profile||{},row),sourceConversationId:row.id,sourceLabel:'BOSS 沟通资料摘要',capturedAt:profileResult.meta?.capturedAt||row.importedAt||now()};
        if(!candidate){candidate={...fields,id:`cand_${digest(`boss:${selectors.sourceAccountKey}:${selectors.candidateExternalId}`).slice(0,24)}`,createdAt:now(),updatedAt:now()};draft.candidates.push(candidate);}
        else {mergeBossCandidateFields(candidate,fields,{source:'boss_message',capturedAt:now()});for(const [key,value] of Object.entries(fields))if(!CANDIDATE_PROFILE_FIELDS.includes(key)&&value!==''&&value!==undefined&&(!Array.isArray(value)||value.length))candidate[key]=value;candidate.updatedAt=now();}
        row.candidateId=candidate.id;
        const requirement=(draft.requirements||[]).find(item=>item.id===row.requirementId);
        let application=requirement?(draft.applications||[]).find(item=>item.candidateId===candidate.id&&item.requirementId===requirement.id):null;
        if(requirement&&isCandidateInPool(candidate)&&!application){application={id:uid('app'),candidateId:candidate.id,requirementId:requirement.id,stage:'new',reviewStatus:'pending',evidence:[],notes:'',createdAt:now(),updatedAt:now()};draft.applications.push(application);}
        return {candidateId:candidate.id,applicationId:application?.id||null};
      });
      Object.assign(report,current);
      const history=await messageAdapter({...selectors,readonlyNative:true});
      report.historyStatus=history?.status || 'shape_changed';
      const historyFailure=acquisitionFailure(history,'history');
      if(historyFailure){Object.assign(report,historyFailure);return await saveReport();}
      if(['ok','partial'].includes(history.status)&&history.messages?.length){await store.mutate(draft=>{const row=foundConversation(draft,conversationId);if(history.meta?.accountKey!==selectors.sourceAccountKey||history.messages.some(item=>item.conversationExternalId&&item.conversationExternalId!==selectors.conversationId))throw fail('聊天历史来源账号或会话身份不一致。');importMessageBatch(draft,row.id,history);Object.assign(row,analyzeConversation(row,draft.messages,draft.requirements.find(item=>item.id===row.requirementId)));});report.coverage=history.meta?.coverage||'loaded_history_fragment';}
      if(downloadAttachments&&!report.stopBatch){
        const result=await resumeAdapter({...selectors,kind:'attachment',outputDirectory:RESUME_ROOT});report.resumeStatus=result?.status || 'shape_changed';if(result?.meta?.attachmentCheck)report.attachmentCheck=structuredClone(result.meta.attachmentCheck);
        const resumeFailure=acquisitionFailure(result,'resume');
        if(resumeFailure){Object.assign(report,resumeFailure);report.resumeMessage=resumeFailure.message;return await saveReport();}
        if(result.status==='ok'&&result.file){
          assertIdentity(result,selectors);
          const latest=store.read();
          const resume=await archiveResume(result,{candidateId:current.candidateId,applicationId:current.applicationId,existing:latest.resumes||[]});
          if(isRetiredOnlineResume(resume))throw fail('采集仅支持原始附件，未保存在线快照。');
          await store.mutate(draft=>{
            draft.resumes??=[];let existing=draft.resumes.find(item=>!isRetiredOnlineResume(item)&&item.candidateId===resume.candidateId&&(item.applicationId||null)===(resume.applicationId||null)&&item.sha256===resume.sha256);
            if(existing){existing.acquisitions??=[{source:existing.source,capturedAt:existing.capturedAt||existing.createdAt,sourceMeta:existing.sourceMeta}];if(!existing.acquisitions.some(item=>item.source==='boss_download'&&item.sourceMeta?.accountKey===resume.sourceMeta?.accountKey))existing.acquisitions.push({source:'boss_download',capturedAt:resume.capturedAt,sourceMeta:resume.sourceMeta});Object.assign(existing,{source:'boss_download',sourceMeta:resume.sourceMeta,coverage:resume.coverage,lastCheckedAt:resume.lastCheckedAt||now()});report.resumeId=existing.id;}
            else {draft.resumes.unshift(resume);report.resumeId=resume.id;}
          });
          report.resumeTextStatus=resume.textStatus;report.resumeStatus='archived';
        }else {report.resumeMessage=result.message||'本次未取得可下载附件。';}
      }
      if(!report.stopBatch)report.status=report.profileStatus==='ok'||report.profileStatus==='partial'?'ok':'partial';
      return await saveReport();
    }finally{busy.delete(conversationId);}
  }
  return {collectCandidate};
}

// Explicit allowlist used for the first manually reviewed batch. Sensitive
// attributes and private contact details never enter this analysis artifact.
export function buildInboxReviewMaterials(state,conversationIds) {
  const redact=value=>String(value||'').replace(/\b1[3-9]\d{9}\b/g,'[联系方式已移除]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig,'[邮箱已移除]').split(/(?<=[。！？\n])/).filter(sentence=>!/(?:婚|孕|性别|年龄|岁|出生|民族|宗教|健康|残疾|骨折|手术|病史|身份证)/.test(sentence)).join('').trim();
  return conversationIds.map(id=>{
    const row=foundConversation(state,id),candidate=state.candidates.find(item=>item.id===row.candidateId),requirement=state.requirements.find(item=>item.id===row.requirementId);
    const profile=row.profileMeta?.accountKey===row.sourceAccountKey?row.profile||{}:{};
    const messages=state.messages.filter(item=>item.conversationId===row.id).slice(-80).map(item=>({id:item.id,sender:item.sender,text:redact(item.text),sentAt:item.sentAt,type:item.type})).filter(item=>item.text);
    const resumes=(state.resumes||[]).filter(item=>!isRetiredOnlineResume(item)&&item.candidateId===candidate?.id&&(!item.applicationId||state.applications.find(app=>app.id===item.applicationId)?.requirementId===row.requirementId)).map(item=>({id:item.id,name:item.name,sha256:item.sha256,textStatus:item.textStatus,text:redact(item.text),coverage:item.coverage}));
    return {conversationId:row.id,candidateId:row.candidateId||null,sourceAccountKey:row.sourceAccountKey,peerName:row.peerName,lastMessageAt:row.lastMessageAt,actualJob:{id:row.communicatedJobExternalId||null,title:row.communicatedPosition||'',mappingStatus:row.jobMappingStatus,conflict:row.jobMappingConflict},expectedPosition:profile.expectedPosition||profile.position||row.peerPosition||'',requirement:requirement?pick(requirement,['id','title','jd','mustHaves','salaryRange','city','version']):null,profile:{workYear:profile.workYear,degree:profile.degree,city:profile.city,position:profile.position,salary:profile.salary,workHistory:profile.workHistory,education:profile.education,introduction:redact(profile.introduction)},messages,lastMessage:redact(row.lastMessage),lastSender:row.lastSender,historyComplete:row.historyComplete===true,collection:row.collection,resumes};
  });
}
