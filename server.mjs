import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, ROOT, STAGES, uid, now, digest, addActivity, upsertBossCandidates, compactJobResult } from './lib/store.mjs';
import { buildInterviewPack, prepareTranscriptReview, renderDocumentHtml } from './lib/interview.mjs';
import { upsertConversationBatch, importMessageBatch, analyzeConversation } from './lib/conversations.mjs';
import { sensitiveCriterion } from './lib/criteria.mjs';
import { SCHEMA } from './lib/schema.mjs';
import * as bossAdapter from './lib/boss.mjs';
import * as feishuAdapter from './lib/feishu.mjs';
import { assertCalendarConnection } from './lib/feishu.mjs';
import { normalizeLarkConnection, sameLarkConnection } from './lib/lark-context.mjs';
import { configureLarkProfile } from './lib/lark-profile-credentials.mjs';
import { APP_ROOT, DEFAULT_WEB_PORT, INSTALLED } from './lib/runtime-config.mjs';
import { SecretStore, publicModelSettings } from './lib/secrets.mjs';
import { validateModelSettings, testModelConnection, callModel } from './lib/model-api.mjs';
import { defaultPromptFor } from './lib/prompts.mjs';
import { compilePrompt, promptView, promptFingerprint, promptTechnicalContract } from './lib/prompt-governance.mjs';
import { assertEditablePromptUpdate, PROMPT_CONTRACT_VERSION } from './lib/prompt-governance.mjs';
import { businessRulesForPrompt } from './lib/prompts.mjs';
import { normalizeEvaluationRules } from './lib/evaluation-rules.mjs';
import { ensureAdvancedState, runAnalysis, saveAnalysis } from './lib/workflows.mjs';
import { RESUME_ROOT, archiveResumeBytes, archiveDownloadedResume, resumeDownloadPath, MAX_RESUME_BYTES } from './lib/resumes.mjs';
import { listActiveMeetings, importMeetingMaterial, readLiveMeeting } from './lib/meetings.mjs';
import { upsertBossJobs, setBossJobMapping, reconcileConversationJob, reconcileAllConversationJobs, resolveConversationJobMapping, jobForConversation } from './lib/job-mappings.mjs';
import { isRetiredOnlineResume } from './lib/resume-policy.mjs';
import { migrateLegacyBossProfileSalary } from './lib/boss-profile.mjs';
import { createInboxCollector } from './lib/inbox-collector.mjs';
import { createInboxAutomation, ensureInboxAutomationState } from './lib/inbox-automation.mjs';
import { analyzeReplyPriority, saveReplyPriority, replyPriorityFingerprint, replyPriorityAnalysisKey, findReusableReplyPriority, reuseReplyPriorityRecord, ensureReplyPriorityCacheKeys } from './lib/reply-priority.mjs';
import { ensureCandidatePoolState, joinCandidatePool, isCandidateInPool } from './lib/candidate-pool.mjs';
import { analyzeSourcingMatch, saveSourcingMatch, sourcingMatchAnalysisKey } from './lib/sourcing-match.mjs';
import { createInterviewAutomation, ensureInterviewAutomationState, initializeInterviewAutomation, validateInterviewAutomationInput } from './lib/interview-automation.mjs';
import { createFeishuInterviewBridge, readExistingInterviewCalendar } from './lib/feishu-interviews.mjs';
import { resolveInterviewMeetingContext } from './lib/interview-meeting-context.mjs';
import { createInterviewLiveCapture } from './lib/interview-live-capture.mjs';
import { createInterviewCopilot } from './lib/interview-copilot.mjs';
import { runInterviewAgent, inspectInterviewAgent } from './lib/interview-agent.mjs';
import { sendCopilotCard } from './lib/interview-copilot-delivery.mjs';
import { createInterviewReports } from './lib/interview-reports.mjs';
import { inspectReportMeetingEnd } from './lib/interview-report-presence.mjs';
import { createInterviewNotifications } from './lib/interview-notifications.mjs';
import { sendInterviewNotification } from './lib/interview-notification-cards.mjs';
import { initializeInterviewNotifications, normalizeRecipientList, validateNotificationSettings, resolveInterviewRecipients } from './lib/interview-recipients.mjs';
import { createFeishuDirectory } from './lib/feishu-directory.mjs';
import { chooseInterviewScoreSummary } from './lib/interview-score-summary.mjs';
import { candidateBasicInfo } from './lib/candidate-basic-info.mjs';
import { candidateCareerProfile } from './lib/candidate-career-profile.mjs';
import { ensureCandidateMaster, candidateProfileView, updateCandidateProfile, mergeBossCandidateFields } from './lib/candidate-master.mjs';

const PUBLIC = path.join(APP_ROOT, 'public');
const { version } = JSON.parse(await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
const badRequest = message => Object.assign(new Error(message), { statusCode: 400 });
function text(value, max = 2000) { return String(value ?? '').trim().slice(0, max); }
function requireEntity(rows, id, label) { const row = rows.find(item => item.id === id); if (!row) throw Object.assign(new Error(`${label}不存在。`), { statusCode: 404 }); return row; }
function documentForDisplay(state, document) {
  if (document.type !== 'interview_pack' || !document.content || typeof document.content !== 'object' || Array.isArray(document.content)) return document;
  const candidate = state.candidates.find(row => row.id === document.candidateId);
  if (!candidate) return document;
  const requirement = state.requirements.find(row => row.id === document.requirementId) || {};
  const content = { ...document.content, candidateBasics: candidateBasicInfo(candidate, requirement), candidateProfile: candidateCareerProfile(candidate) };
  const text = candidate.profileManualFields?.includes('briefIntroduction') ? candidate.briefIntroduction || '' : candidate.briefIntroduction || candidate.introduction || '';
  content.candidateBrief = { ...(content.candidateBrief || {}), text };
  const changedSincePreparation=['introduction','workHistory','education','briefIntroduction'].some(key=>candidate.profileFieldSources?.[key]?.kind==='manual'&&Date.parse(candidate.profileFieldSources[key].updatedAt)>Date.parse(document.updatedAt||document.createdAt||0));
  if(changedSincePreparation){content.candidateBrief.fitReasons=[];if(content.scoreSummary)content.scoreSummary={...content.scoreSummary,matchReasons:[],stale:true};}
  return { ...document, content };
}
function json(res, status, payload) { const body = JSON.stringify(payload); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); }
async function body(req, limit = 1024 * 1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('请使用 application/json。'), { statusCode: 415 });
  const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('请求内容超过此接口允许的大小。'), { statusCode: 413 }); chunks.push(chunk); }
  const data = Buffer.concat(chunks).toString('utf8');
  try { const parsed = JSON.parse(data || '{}'); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed; }
  catch { throw badRequest('JSON 请求格式不正确。'); }
}
function validateRequirement(input, previous = {}) {
  const row = { ...previous };
  for (const key of ['title', 'department', 'city', 'salaryRange', 'owner', 'jd', 'businessGoal', 'requestReason', 'headcountJustification', 'budget', 'targetDate', 'reportingTo', 'teamContext', 'successCriteria']) if (key in input) row[key] = text(input[key], key === 'jd' ? 20000 : ['title', 'department', 'city', 'salaryRange', 'owner', 'targetDate', 'reportingTo'].includes(key) ? 200 : 5000);
  if (!row.title) throw badRequest('请填写岗位名称。');
  row.headcount = Number(input.headcount ?? row.headcount ?? 1);
  if (!Number.isInteger(row.headcount) || row.headcount < 1 || row.headcount > 1000) throw badRequest('招聘人数应为 1–1000 的整数。');
  row.priority = input.priority ?? row.priority ?? 'normal';
  row.status = input.status ?? row.status ?? 'draft';
  if (!['high', 'normal', 'low'].includes(row.priority) || !['draft', 'open', 'paused', 'closed'].includes(row.status)) throw badRequest('需求状态或优先级无效。');
  if ('mustHaves' in input) row.mustHaves = (Array.isArray(input.mustHaves) ? input.mustHaves : String(input.mustHaves).split(/\n/)).map(value => text(value, 500)).filter(Boolean).slice(0, 20);
  row.mustHaves ??= [];
  if (row.mustHaves.some(value => sensitiveCriterion.test(value))) throw badRequest('请使用岗位相关能力、职责与证据要求设置标准；当前标准含不适用于自动分析的个人属性。');
  row.version = (previous.version || 0) + 1; row.updatedAt = now();
  return row;
}
function interviewPayload(input, state, {notificationNow=Date.now()}={}) {
  const application = requireEntity(state.applications, input.applicationId, '应聘流程');
  const candidate = requireEntity(state.candidates, application.candidateId, '候选人');
  if(!isCandidateInPool(candidate))throw Object.assign(new Error('请先将人选加入候选人池，再安排面试。'),{statusCode:409});
  const requirement = requireEntity(state.requirements, application.requirementId, '招聘需求');
  const start = new Date(input.startAt), end = new Date(input.endAt);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || end <= start || end - start > 8 * 3600000) throw badRequest('面试结束时间应晚于开始时间，且时长不超过 8 小时。');
  if (!text(input.interviewer)) throw badRequest('请填写面试官。');
  const conflict = state.interviews.find(row => row.status !== 'cancelled' && row.interviewer === text(input.interviewer) && new Date(row.startAt) < end && new Date(row.endAt) > start);
  if (conflict) throw Object.assign(new Error(`该面试官与本地已有面试“${conflict.title}”时间重叠。`), { statusCode: 409 });
  const data = { id: uid('int'), applicationId: application.id, candidateId: candidate.id, requirementId: requirement.id, title: text(input.title) || `${candidate.name} · ${requirement.title}面试`, startAt: start.toISOString(), endAt: end.toISOString(), interviewer: text(input.interviewer, 300), location: text(input.location, 1000) || '待确认', round: text(input.round, 100) || '初面', timezone: 'Asia/Shanghai', status: 'scheduled', calendarStatus: 'local', revision: 1, createdAt: now(), updatedAt: now(), ...validateInterviewAutomationInput(input,state.settings.interviewAutomation) };
  initializeInterviewAutomation(data,state.settings.interviewAutomation);
  initializeInterviewNotifications(data,state.settings,{now:notificationNow});
  data.notificationSettings.preparation=data.reminderEnabled;
  return { application, candidate, requirement, data };
}

export async function createWorkbench({ store = new Store(), boss = bossAdapter, feishu = feishuAdapter, configureProfile = configureLarkProfile, secrets = new SecretStore(), modelTransport = {}, resumeAdapter, jobAdapter, conversationAdapter, profileAdapter, profileBatchDelayMs = 350, inboxServices = {}, inboxOptions = {}, interviewServices = {}, interviewOptions = {}, liveCaptureServices = {}, liveCaptureOptions = {}, copilotServices = {}, copilotOptions = {}, reportServices = {}, reportOptions = {}, notificationServices = {}, notificationOptions = {}, directoryService = createFeishuDirectory(), readExistingCalendar = readExistingInterviewCalendar, meetingAdapter = { listActiveMeetings, importMeetingMaterial, readLiveMeeting } } = {}) {
  if (!store.state) await store.init();
  const migration = store.read();
  if (ensureAdvancedState(migration)) await store.mutate(state => ensureAdvancedState(state));
  if (ensureInboxAutomationState(store.read())) await store.mutate(state => ensureInboxAutomationState(state));
  if (ensureInterviewAutomationState(store.read())) await store.mutate(state => ensureInterviewAutomationState(state));
  if (ensureCandidatePoolState(store.read())) await store.mutate(state => ensureCandidatePoolState(state));
  if (ensureCandidateMaster(store.read())) await store.mutate(state => ensureCandidateMaster(state));
  if (migrateLegacyBossProfileSalary(store.read()).changed) await store.mutate(state => migrateLegacyBossProfileSalary(state));
  if (ensureReplyPriorityCacheKeys(store.read())) await store.mutate(state => ensureReplyPriorityCacheKeys(state));
  const busy = new Set();
  const notificationClock=notificationOptions.clock||Date.now;
  const notificationStamp=()=>new Date(notificationClock()).toISOString();
  const feishuOptions = (settings = store.read().settings) => settings.feishuConnection ? { connection: normalizeLarkConnection(settings.feishuConnection) } : {};
  const baseFeishuOptions = (settings = store.read().settings) => (settings.feishuBaseConnection||settings.feishuConnection) ? { connection: normalizeLarkConnection(settings.feishuBaseConnection||settings.feishuConnection) } : {};
  const interviewBridge = createFeishuInterviewBridge();
  const bridgeInput = (interview,state,options) => {const document=state.documents.find(row=>row.id===interview.documentId);return { interview, candidate:state.candidates.find(row=>row.id===interview.candidateId), requirement:state.requirements.find(row=>row.id===interview.requirementId), document:document?documentForDisplay(state,document):undefined, scoreSummary:chooseInterviewScoreSummary(state,interview), resumes:state.resumes, settings:state.settings, ...options };};
  const interviewNotifications=createInterviewNotifications({store,...notificationOptions,services:{
    send:input=>input.kind==='copilot'?sendCopilotCard(input):sendInterviewNotification(input),
    sendPreparation:({interview,state,...options})=>interviewBridge.sendReminder(bridgeInput(interview,state,options)),
    inviteCalendarRecipient:({interview,recipientOpenId,recipientName,connection})=>{
      if(typeof feishu.inviteInterviewCalendarRecipients!=='function')throw Object.assign(new Error('本场飞书参会人补邀能力未配置。'),{code:'calendar_invitation_unavailable',definitelyNotSent:true});
      return feishu.inviteInterviewCalendarRecipients(interview,[{openId:recipientOpenId,name:recipientName||''}],{connection});
    },
    ...notificationServices,
  }});
  async function requireNotificationDelivery(id,kind,options){
    const result=await interviewNotifications.deliver(id,kind,options);
    if(result.status!=='sent'||!result.messageId)throw Object.assign(new Error(result.reason||'本场部分接收人的消息尚未确认送达，请查看逐人发送记录。'),{code:'unknown_delivery'});
    return result;
  }
  const interviewAutomation = createInterviewAutomation({ store, ...interviewOptions, services:{
    sendReminder:(interview,state,options)=>interview.notifications?.enabled===true?requireNotificationDelivery(interview.id,'preparation',options):interviewBridge.sendReminder(bridgeInput(interview,state,options)),
    getCalendarMeeting:(interview,state,options)=>interviewBridge.getCalendarMeeting(bridgeInput(interview,state,options)),
    joinMeeting:(interview,state,options)=>interviewBridge.joinMeeting(bridgeInput(interview,state,options)),
    ...interviewServices
  }});
  const interviewEffectPending = () => store.read().interviews.some(row=>row.reminder?.status==='sending'||row.reminder?.testReceipt?.status==='sending'||row.autoJoin?.status==='joining'||row.notifications?.deliveries?.some(delivery=>delivery.status==='sending'));
  const liveCapture=createInterviewLiveCapture({store,...liveCaptureOptions,services:{poll:id=>pollInterviewLive(id,{analyze:false}),...liveCaptureServices}});
  const analyzeStructuredInterview=async({state,input,prompt,schema,systemPrompt,settings})=>{
      const compiled=compilePrompt(prompt,input);
      if(settings.mode==='agent')return (modelTransport.agentRunner || runInterviewAgent)({input,prompt:{systemPrompt:compiled.systemPrompt,userPrompt:promptTechnicalContract(prompt.scene).userPrompt.replace('{{input}}','见本轮结构化 JSON 材料')},schema:promptTechnicalContract(prompt.scene).outputSchema,provider:settings.agentProvider});
      const modelSettings=validateModelSettings(state.settings.model),apiKey=await secrets.getModelKey(modelSettings.baseUrl);
      const result=await callModel({settings:modelSettings,apiKey,...compiled,...modelTransport});
      let output;try{output=JSON.parse(result.content);}catch{throw Object.assign(new Error('模型未返回有效的结构化面试分析 JSON。'),{code:'invalid_copilot_output',statusCode:422});}
      return {output,provider:'api',model:result.model,usage:result.usage};
    };
  const copilot=createInterviewCopilot({store,...copilotOptions,services:{
    analyze:analyzeStructuredInterview,
    send:input=>input.interview.notifications?.enabled===true?requireNotificationDelivery(input.interview.id,'copilot',input):sendCopilotCard(input),
    ...copilotServices
  }});
  const interviewReports=createInterviewReports({store,...reportOptions,services:{
    analyze:analyzeStructuredInterview,
    probeActive:(interview,state)=>inspectReportMeetingEnd({interview,settings:state.settings,connection:state.settings.feishuConnection}),
    onAnalysisStarted:(id,payload)=>interviewNotifications.deliver(id,'summarizing',payload),
    onReportSaved:(id,payload)=>interviewNotifications.deliver(id,'summary',payload),
    ...reportServices
  }});
  const preparing = new Map();
  async function ensureInterviewPack(applicationId, { softFailure = false } = {}) {
    if (preparing.has(applicationId)) return preparing.get(applicationId);
    const task = (async () => {
      try {
        const snapshot=store.read(),prompt=snapshot.prompts.find(row=>row.scene==='interview_prep');
        if(softFailure&&!snapshot.settings.interviewCopilot?.mode&&!snapshot.settings.model?.baseUrl&&!modelTransport.agentRunner)throw Object.assign(new Error('尚未选择自动准备使用的分析执行方式，先保留资料清单。'),{code:'analysis_engine_not_selected'});
        const analysis=await runAnalysis(snapshot,{scene:'interview_prep',applicationId,generator:'auto'},{secrets,...modelTransport});
        return await store.mutate(state=>{
          const current=state.prompts.find(row=>row.id===prompt.id);
          if(promptFingerprint(current)!==analysis.promptFingerprint)throw Object.assign(new Error('生成期间会前模板发生变化，请重试。'),{code:'preparation_changed',statusCode:409});
          saveAnalysis(state,analysis);
          const doc=buildInterviewPack(state,applicationId,{analysis});
          return doc;
        });
      } catch(error) {
        if(!softFailure)throw error;
        return store.mutate(state=>{
          const doc=buildInterviewPack(state,applicationId,{analysis:null});
          doc.analysisError={code:error.code||'analysis_failed',message:error.message};
          return doc;
        });
      }
    })();
    preparing.set(applicationId,task);
    try { return await task; } finally { preparing.delete(applicationId); }
  }
  async function pollInterviewLive(id,input={}) {
    const key=`live-poll-${id}`;
    if(busy.has(key))throw Object.assign(new Error('正在读取本场会议，请等待返回。'),{statusCode:409,code:'live_read_busy'});
    busy.add(key);
    try {
      const snapshot=store.read(),interview=requireEntity(snapshot.interviews,id,'面试'),options=feishuOptions(snapshot.settings);
      const meetingContext=resolveInterviewMeetingContext(interview,options.connection,{meetingId:input.meetingId});
      const result=await meetingAdapter.readLiveMeeting({...options,meetingId:meetingContext.meetingId,pageToken:meetingContext.pageToken});
      if(!['ok','no_speech'].includes(result.status))return result;
      if(meetingContext.meetingId&&result.meetingId!==meetingContext.meetingId)throw Object.assign(new Error('发言回执与本场选定会议不一致，未保存。'),{statusCode:409,code:'meeting_context_mismatch'});
      if(result.feishuConnection&&!sameLarkConnection(result.feishuConnection,options.connection))throw Object.assign(new Error('发言回执不属于本场飞书应用，未保存。'),{statusCode:409,code:'meeting_context_mismatch'});
      const savedResult=await store.mutate(state=>{
        const row=requireEntity(state.interviews,id,'面试');
        const currentContext=resolveInterviewMeetingContext(row,state.settings.feishuConnection,{meetingId:input.meetingId});
        if(!sameLarkConnection(state.settings.feishuConnection,options.connection)||currentContext.meetingId!==meetingContext.meetingId||row.eventId!==interview.eventId||row.applicationId!==interview.applicationId)throw Object.assign(new Error('读取期间本场会议或飞书应用发生变化，未保存到新上下文。'),{statusCode:409,code:'meeting_context_mismatch'});
        const continuing=row.liveSession?.meetingId===result.meetingId&&sameLarkConnection(row.liveSession?.feishuConnection,options.connection);
        if(row.liveSession?.meetingId&&!continuing){row.liveSessionHistory??=[];row.liveSessionHistory.push(structuredClone(row.liveSession));}
        const previous=continuing?row.liveSession:{segments:[],seenAlertKeys:[],alerts:[]},segments=new Map((previous.segments||[]).map(segment=>[segment.id,segment]));
        const oldIds=new Set(segments.keys()),revisedIds=new Set();
        const originalFields=segment=>Object.fromEntries(['id','sentenceId','eventId','kind','speaker','text','timestamp'].filter(key=>Object.hasOwn(segment,key)).map(key=>[key,segment[key]]));
        const explicitSpeaker=value=>typeof value==='string'&&value.trim()&&!/^(?:发言人未标注|发言人未知|未知|未确认|未知发言人|未确认发言人)$/.test(value.trim());
        for(const segment of result.segments||[]){
          const prior=segments.get(segment.id),incoming={...segment};delete incoming.revisions;
          if(!prior){segments.set(segment.id,incoming);continue;}
          const speaker=explicitSpeaker(incoming.speaker)?incoming.speaker:prior.speaker||incoming.speaker;
          const revised=prior.text!==incoming.text||prior.speaker!==speaker;
          const merged={...prior,...incoming,speaker};delete merged.revisions;
          const revisions=(Array.isArray(prior.revisions)?prior.revisions:[]).filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).map(originalFields);
          if(revised){
            const previous=originalFields(prior),last=revisions.at(-1);
            if(!last||last.text!==previous.text||last.speaker!==previous.speaker)revisions.push(previous);
            if(oldIds.has(segment.id))revisedIds.add(segment.id);
          }
          if(revisions.length)merged.revisions=revisions.slice(-5);
          segments.set(segment.id,merged);
        }
        const saved=[...segments.values()].sort((a,b)=>{const aa=Date.parse(a.timestamp),bb=Date.parse(b.timestamp);return Number.isFinite(aa)&&Number.isFinite(bb)?aa-bb:0;}).slice(-3000);
        const newSegments=saved.filter(segment=>!oldIds.has(segment.id)).length,revisedSegments=saved.filter(segment=>revisedIds.has(segment.id)).length,transcript=saved.map(segment=>`${segment.speaker}：${segment.text}`).join('\n').slice(-120000);
        row.liveSession={...previous,...(options.connection?{feishuConnection:options.connection}:{}),meetingId:result.meetingId,title:result.title,pageToken:result.pageToken||previous.pageToken||'',segments:saved,transcript,source:result.source,hasMore:result.hasMore,lastSyncAt:result.lastSyncAt||now(),fingerprint:digest(transcript)};
        return {session:row.liveSession,newSegments,revisedSegments};
      });
      const {session,newSegments,revisedSegments}=savedResult,unchanged=input.analyze===false?newSegments===0&&revisedSegments===0:session.fingerprint===session.lastAnalyzedFingerprint;
      let analysis;
      if(input.analyze!==false&&session.transcript.trim()&&!unchanged){
        analysis=await runAnalysis(store.read(),{scene:'live_assist',interviewId:id,transcript:session.transcript,generator:input.generator==='model'?'model':'rules',promptId:input.promptId},{secrets,...modelTransport});
        await store.mutate(state=>{const row=requireEntity(state.interviews,id,'面试'),live=row.liveSession;if(!sameLarkConnection(state.settings.feishuConnection,options.connection)||live?.meetingId!==session.meetingId||live?.fingerprint!==session.fingerprint||!sameLarkConnection(live?.feishuConnection,options.connection))throw Object.assign(new Error('分析期间本场发言上下文已变化，未混用结果。'),{statusCode:409,code:'meeting_context_mismatch'});saveAnalysis(state,analysis);live.lastAnalyzedFingerprint=session.fingerprint;live.alerts=analysis.alerts||[];live.seenAlertKeys=[...new Set([...(live.seenAlertKeys||[]),...(analysis.alerts||[]).map(row=>row.id)])].slice(-100);});
      }
      return {...result,newSegments,revisedSegments,totalSegments:session.segments.length,transcript:session.transcript,unchanged,analysis,message:unchanged?'当前没有新增或修订发言，未重复分析或打断。':revisedSegments?`新增 ${newSegments} 段发言，修订 ${revisedSegments} 段，已保留原版记录。`:result.message};
    }finally{busy.delete(key);}
  }
  function resumeOwner(input) {
    const state = store.read(), candidate = requireEntity(state.candidates, input.candidateId, '候选人');
    if (candidate.source !== 'boss' || !candidate.externalId || !candidate.sourceAccountKey) throw badRequest('候选人缺少 BOSS 来源账号与平台标识，未按姓名读取简历。');
    const application = input.applicationId ? requireEntity(state.applications, input.applicationId, '应聘流程') : null;
    if (application && application.candidateId !== candidate.id) throw badRequest('候选人与应聘流程不一致。');
    const conversation = input.conversationId ? requireEntity(state.conversations, input.conversationId, '会话') : state.conversations.find(row => row.candidateId === candidate.id || (row.sourceAccountKey === candidate.sourceAccountKey && row.candidateExternalId === candidate.externalId));
    if (conversation && ((conversation.candidateId && conversation.candidateId !== candidate.id) || conversation.sourceAccountKey !== candidate.sourceAccountKey || (conversation.candidateExternalId && conversation.candidateExternalId !== candidate.externalId))) throw badRequest('会话与候选人平台身份不一致，未混入其他人的简历。');
    return { state, candidate, application, conversation, selectors: { port: state.settings.cdpPort, conversationId: conversation?.externalId, peerId: conversation?.peerId, candidateExternalId: candidate.externalId, sourceAccountKey: candidate.sourceAccountKey } };
  }
  function verifyResumeIdentity(result, owner) {
    if (!result.meta?.accountKey || result.meta.accountKey !== owner.candidate.sourceAccountKey || result.meta.sourceIdentity?.candidateExternalId !== owner.candidate.externalId) throw badRequest('简历来源账号或候选人标识不一致，未写入档案。');
    if (owner.conversation && (result.meta.sourceIdentity.conversationId !== owner.conversation.externalId || result.meta.sourceIdentity.peerId !== owner.conversation.peerId)) throw badRequest('简历返回的会话身份与选择不一致，未写入档案。');
  }
  async function saveResume(resume) {
    return store.mutate(draft => {
      const existing = draft.resumes.find(row => !isRetiredOnlineResume(row) && row.candidateId === resume.candidateId && (row.applicationId || null) === (resume.applicationId || null) && row.sha256 === resume.sha256);
      if (existing) {
        if (resume.lastCheckedAt) existing.lastCheckedAt = resume.lastCheckedAt;
        if (resume.acquiredFrom === 'boss_download') {
          const acquisitions = existing.acquisitions || [{ source: existing.source, capturedAt: existing.capturedAt || existing.createdAt, sourceMeta: existing.sourceMeta }];
          if (!acquisitions.some(row => row.source === 'boss_download' && row.sourceMeta?.accountKey === resume.sourceMeta?.accountKey)) acquisitions.push({ source: 'boss_download', capturedAt: resume.capturedAt, sourceMeta: resume.sourceMeta });
          existing.acquisitions = acquisitions; existing.source = 'boss_download'; existing.sourceMeta = resume.sourceMeta; existing.coverage = resume.coverage;
        }
        return { ...existing, deduplicated: true };
      }
      draft.resumes.unshift(resume);
      addActivity(draft, 'resume', `归档附件简历：${resume.name}`, `来源和身份已核对；正文状态：${resume.textStatus}。`);
      return resume;
    });
  }
  async function job(type, title, operation) {
    if (type.startsWith('boss-') && store.read().settings.bossOfflineMode === true) throw Object.assign(new Error('当前使用已有数据离线整理，BOSS 采集已暂停；登录后可在设置中关闭离线模式。'), { code: 'boss_offline', statusCode: 409 });
    if (busy.has(type)) throw Object.assign(new Error('同类任务正在执行，请等待当前任务返回。'), { statusCode: 409 });
    if (type.startsWith('boss-') && [...busy].some(key => key.startsWith('boss-'))) throw Object.assign(new Error('正在读取 BOSS 会话，请等当前读取结束后再执行。'), { statusCode: 409 });
    busy.add(type); const id = uid('job');
    await store.mutate(state => { state.jobs.unshift({ id, type, title, status: 'running', startedAt: now(), createdAt: now() }); });
    try {
      const result = await operation();
      await store.mutate(state => {
        const record = state.jobs.find(row => row.id === id);
        const failed = ['error','failed','blocked','permission_denied','shape_changed','need_auth','requires_review','rate_limited','throttled','captcha','verification_required','session_expired','challenge_required','cdp_unavailable','busy'].some(value => value === result?.status || value === result?.code);
        record.status = failed ? 'failed' : result?.failed > 0 || result?.failedTables > 0 || result?.status === 'partial' ? 'partial' : 'succeeded';
        if (failed) record.error = text(result?.message || '本次任务未完成，已保留可重试状态。');
        record.finishedAt = now(); record.result = compactJobResult(result);
        addActivity(state, type, title, result?.message || `任务已完成${result?.synced !== undefined ? `，写入 ${result.synced} 条` : ''}。`, failed ? 'error' : record.status === 'partial' ? 'warning' : 'success');
        const rule = state.automations.find(row => row.id === type); if (rule) rule.lastRun = now();
      });
      return result;
    } catch (error) {
      await store.mutate(state => { const record = state.jobs.find(row => row.id === id); record.status = error.status === 'unknown_delivery' || error.code === 'unknown_delivery' ? 'unknown_delivery' : 'failed'; record.error = text(error.message); record.finishedAt = now(); addActivity(state, type, title, text(error.message), 'error'); });
      throw error;
    } finally { busy.delete(type); }
  }
  async function connections() {
    const settings = store.read().settings;
    if (settings.bossOfflineMode === true) return store.mutate(state => { state.connections.boss={status:'offline',message:'离线整理已有数据，本次未连接 BOSS。'}; return state.connections; });
    const results = await Promise.allSettled([boss.getBossStatus({ port: settings.cdpPort }), feishu.getFeishuStatus(feishuOptions(settings))]);
    return store.mutate(state => {
      state.connections.boss = results[0].status === 'fulfilled' ? results[0].value : { status: 'error', message: '浏览器连接检测失败。' };
      state.connections.feishu = results[1].status === 'fulfilled' ? results[1].value : { status: 'error', message: '飞书授权检测失败，请在桌面用户环境启动工作台。' };
      state.connections.checkedAt = now();
      const currentReceipt = !settings.feishuConnection || sameLarkConnection(settings.feishuConnection, settings.feishuSyncedConnection);
      state.connections.storage = { mode: currentReceipt && (state.settings.lastSyncAt || state.settings.lastPullAt) ? 'feishu' : 'local', message: !currentReceipt ? '已切换飞书应用，原多维表配置保留，等待新应用取得访问权限。' : state.settings.lastSyncAt ? `飞书多维表 · 上次成功同步 ${state.settings.lastSyncAt}` : state.settings.lastPullAt ? `飞书多维表 · 上次回读 ${state.settings.lastPullAt}` : state.settings.baseToken ? '已绑定多维表 · 当前仍使用本地镜像，等待首次同步' : '本地镜像 · 尚未连接飞书多维表' };
      return state.connections;
    });
  }
  async function importBoss(input = {}) {
    return job('boss-import', '导入 BOSS 当前搜索结果', async () => {
      const state = store.read(); const requirementId = input.requirementId || state.requirements[0]?.id;
      if (!requirementId) throw badRequest('请先新建招聘需求。');
      const result = await boss.importBossPage({ port: state.settings.cdpPort, maxPages: 1 });
      if (!['ok', 'partial', 'no_data'].includes(result.status)) throw Object.assign(new Error(result.message || 'BOSS 导入未完成。'), { status: result.status, statusCode: 502 });
      return store.mutate(draft => {
        const counts = upsertBossCandidates(draft, result.candidates, requirementId);
        draft.sourceCoverage = { ...result.meta, message: result.message };
        draft.connections.boss = { status: 'connected', message: `读取成功：${result.candidates.length} 条当前页记录`, checkedAt: now() };
        return { ...counts, status: result.status, message: `${result.message} 新增 ${counts.imported} 位，更新/去重 ${counts.deduplicated} 位。`, meta: result.meta };
      });
    });
  }
  async function importConversations() {
    return job('boss-conversations', '汇总 BOSS 沟通会话', async () => {
      const adapter = conversationAdapter || await import('./lib/boss-messages.mjs');
      const result = await adapter.getBossConversations({ port: store.read().settings.cdpPort, refresh: true });
      if (!['ok', 'partial', 'no_data'].includes(result.status)) throw Object.assign(new Error(result.message || '消息列表尚未取得。'), { status: result.status, statusCode: 502 });
      return store.mutate(state => { const counts = upsertConversationBatch(state, result.conversations); state.messageCoverage = result.meta; return { ...counts, status: result.status, message: result.message, meta: result.meta }; });
    });
  }
  function refreshConversationSummaries(state) {
    for(const row of state.conversations||[])Object.assign(row,analyzeConversation(row,state.messages,state.requirements.find(item=>item.id===row.requirementId)));
  }
  async function importJobs() {
    return job('boss-job-list','同步 BOSS 招聘岗位',async()=>{
      const adapter=jobAdapter||await import('./lib/boss-jobs.mjs');
      const result=await adapter.getBossJobs({port:store.read().settings.cdpPort});
      if(!['ok','partial','no_data'].includes(result.status))throw Object.assign(new Error(result.message||'BOSS招聘岗位读取未完成。'),{status:result.status,statusCode:422});
      return store.mutate(state=>{const counts=upsertBossJobs(state,result);refreshConversationSummaries(state);return {...counts,status:result.status,meta:result.meta,message:result.message};});
    });
  }
  async function syncFeishu() {
    return job('feishu-sync', '同步飞书多维表', async () => {
      const snapshot = store.read();
      snapshot.jobs = snapshot.jobs.filter(row => row.status !== 'running');
      if (!snapshot.settings.baseToken || !Object.keys(snapshot.settings.tables || {}).length) throw badRequest('请先在连接设置中绑定或初始化飞书多维表。');
      const result = await feishu.syncWorkspace(snapshot, baseFeishuOptions(snapshot.settings));
      await store.mutate(state => {
        Object.assign(state.settings, result.settings || {});
        if (result.recordMaps) state.settings.recordMaps = result.recordMaps;
        if (result.status === 'synced' && !result.failed && !result.failedTables) { state.settings.lastSyncAt = now(); if(snapshot.settings.feishuConnection)state.settings.feishuSyncedConnection=structuredClone(snapshot.settings.feishuConnection); state.connections.storage = { mode: 'feishu', message: '已写入飞书多维表，本地保留镜像。' }; }
      });
      return { ...result, message: result.status === 'partial' ? `已写入 ${result.synced} 条，${result.failedTables || 0} 张表仍需处理；未标记为完整同步。` : `已将 ${result.synced} 条业务记录写入飞书多维表。` };
    });
  }
  async function createCalendar(id) {
    const state = store.read(); const interview = requireEntity(state.interviews, id, '面试');
    assertCalendarConnection(interview, state.settings.feishuConnection);
    if (interview.calendarStatus === 'synced' && interview.eventId) return { ...interview, message: '已存在飞书日程，不重复创建。' };
    if (['pending', 'unknown_delivery'].includes(interview.calendarStatus)) throw Object.assign(new Error('上次日程创建结果尚未确认，请先到飞书核实，避免重复邀请。'), { statusCode: 409 });
    return job(`calendar-${id}`, '创建飞书面试日程', async () => {
      await store.mutate(draft => { requireEntity(draft.interviews, id, '面试').calendarStatus = 'pending'; });
      try {
        const result = await feishu.createInterviewCalendar(interview, { candidate: requireEntity(state.candidates, interview.candidateId, '候选人'), requirement: requireEntity(state.requirements, interview.requirementId, '需求'), document: state.documents.find(row => row.id === interview.documentId), settings: state.settings }, feishuOptions(state.settings));
        if (!result.eventId) throw Object.assign(new Error('飞书没有返回可确认的日程回执。'), { status: 'unknown_delivery' });
        const saved=await store.mutate(draft => {
          const row = requireEntity(draft.interviews, id, '面试'); Object.assign(row, result, { calendarStatus: 'synced', status: 'scheduled', updatedAt: now() });
          return row;
        });
        if(saved.notifications?.enabled===true)void interviewNotifications.deliver(id,'invitation',{manual:true}).catch(()=>{});
        return saved;
      } catch (error) {
        await store.mutate(draft => { const row = requireEntity(draft.interviews, id, '面试'); row.calendarStatus = error.status === 'unknown_delivery' || error.code === 'unknown_delivery' ? 'unknown_delivery' : 'failed'; row.calendarError = text(error.message); });
        throw error;
      }
    });
  }

  async function bindExistingCalendar(id, reference) {
    if (Object.keys(reference).some(key => !['calendarId', 'eventId'].includes(key))) throw badRequest('只接受已有日程的日历 ID 和日程 ID。');
    const conflict = message => Object.assign(new Error(message), { statusCode: 409, code: 'calendar_binding_conflict' });
    const snapshot = store.read();
    const interview = requireEntity(snapshot.interviews, id, '面试');
    const bot = normalizeLarkConnection(snapshot.settings.feishuConnection);
    if (bot.identity !== 'bot' || !bot.profile) throw badRequest('请先配置负责本场通知的 HR 飞书机器人。');
    if (interview.calendarBinding?.source === 'existing_event' && interview.eventId === reference.eventId && interview.calendarId === reference.calendarId) {
      assertCalendarConnection(interview, bot);
      return interview;
    }
    if (interview.eventId || interview.calendarStatus !== 'local') throw conflict('本场已有日程或日程创建记录，不能另行绑定。');
    const readConnection = snapshot.settings.feishuBaseConnection?.identity === 'user' ? snapshot.settings.feishuBaseConnection : undefined;
    const binding = await readExistingCalendar(interview, reference, { connection: readConnection });
    return store.mutate(state => {
      const row = requireEntity(state.interviews, id, '面试');
      if (row.eventId || row.calendarStatus !== 'local' || row.title !== interview.title || row.startAt !== interview.startAt || row.endAt !== interview.endAt || !sameLarkConnection(state.settings.feishuConnection, bot)) throw conflict('核对期间本场安排或应用已变化，请刷新。');
      if (state.interviews.some(other => other.id !== id && other.eventId === binding.eventId)) throw conflict('该飞书日程已关联另一场工作台面试。');
      Object.assign(row, binding, { calendarStatus: 'synced', feishuConnection: bot, updatedAt: now() });
      addActivity(state, 'interview', `关联已有飞书日程：${row.title}`, '工作台已核对主题和时间并保存原日程关联。');
      return row;
    });
  }

  const priorityPending = new Map();
  const sourcingPending = new Map();
  async function analyzeSourcing(sourceId,input) {
    if (input.generator && !['model','rules','agent','auto'].includes(input.generator)) throw badRequest('请选择智能体或模型API分析。');
    if ('force' in input && typeof input.force !== 'boolean') throw badRequest('强制重分析参数必须为布尔值。');
    const state=store.read(),source=requireEntity(state.sourcingCandidates,sourceId,'搜索来源'),requirementId=input.requirementId||source.requirementId;
    const options={sourceId,requirementId},key=sourcingMatchAnalysisKey(state,options),pendingKey=`${input.generator||'model'}:${Boolean(input.force)}:${key}`;
    if(sourcingPending.has(pendingKey))return sourcingPending.get(pendingKey);
    const task=(async()=>{
      const result=await analyzeSourcingMatch(state,options,{generator:input.generator||'model',force:input.force===true,secrets,...modelTransport});
      if(!result?.id)return result;
      return store.mutate(draft=>{
        if(sourcingMatchAnalysisKey(draft,options)!==key)throw Object.assign(new Error('分析期间来源或岗位标准已变化，请重试。'),{statusCode:409});
        const row=requireEntity(draft.sourcingCandidates,sourceId,'搜索来源');row.requirementId=requirementId;row.updatedAt=now();
        return saveSourcingMatch(draft,result);
      });
    })().finally(()=>sourcingPending.delete(pendingKey));
    sourcingPending.set(pendingKey,task);return task;
  }
  async function analyzePriority(conversationId, { force = false } = {}) {
    const key = replyPriorityAnalysisKey(store.read(), conversationId);
    if (!force && priorityPending.has(key)) {
      const pending=priorityPending.get(key);await pending;
      if(priorityPending.get(key)===pending)priorityPending.delete(key);
      return analyzePriority(conversationId);
    }
    const operation = job(`analysis-priority-${conversationId}`, '分析沟通回复优先级', async () => {
      const result = await analyzeReplyPriority(store.read(), conversationId, { secrets, ...modelTransport, force });
      return store.mutate(state => {
        result.stale = result.analysisKey !== replyPriorityAnalysisKey(state, conversationId);
        const saved = saveReplyPriority(state, result);
        addActivity(state, 'conversation-priority', result.reused ? '复用已有回复分析' : '回复优先级分析已生成', result.reused ? '判断依据未变化，本次未调用模型或消耗新Token。' : '采用系统模型 API 与该环节提示词；分数用于人审回复待办排序。');
        return saved;
      });
    });
    if(!force)priorityPending.set(key,operation);
    try{return await operation;}finally{if(priorityPending.get(key)===operation)priorityPending.delete(key);}
  }
  const collector = createInboxCollector({ store });
  async function readAndSaveProfile(id) {
    const state=store.read(),row=requireEntity(state.conversations,id,'会话');
    const adapter=profileAdapter||await import('./lib/boss-profile.mjs');
    const result=await adapter.getBossConversationProfile({port:state.settings.cdpPort,conversationId:row.externalId,peerId:row.peerId,sourceAccountKey:row.sourceAccountKey,refresh:true});
    if(!['ok','partial'].includes(result.status)||!result.profile)throw Object.assign(new Error(result.message||'当前没有可读取的沟通人资料。'),{status:result.status,code:result.code||result.status,statusCode:502});
    if(result.meta?.accountKey!==row.sourceAccountKey||result.meta?.currentConversationId!==row.externalId||result.meta?.currentPeerId!==row.peerId||result.profile.sourceAccountKey!==row.sourceAccountKey)throw Object.assign(new Error('职业资料与所选会话的账号或候选人身份不一致，未写入。'),{status:'permission_denied',statusCode:409});
    await store.mutate(draft=>{
      const target=requireEntity(draft.conversations,id,'会话');
      if(target.externalId!==row.externalId||target.peerId!==row.peerId||target.sourceAccountKey!==row.sourceAccountKey||target.candidateExternalId!==row.candidateExternalId)throw badRequest('资料读取期间会话身份发生变化，未合并资料。');
      target.profile=result.profile;target.profileMeta=result.meta;target.profileUpdatedAt=now();target.updatedAt=now();
      for(const key of ['communicatedJobExternalId','communicatedJobNumericId','communicatedPosition'])if(result.profile[key])target[key]=result.profile[key];
      target.communicatedJobCapturedAt=result.meta.capturedAt||now();reconcileConversationJob(draft,target);
      Object.assign(target,analyzeConversation(target,draft.messages,draft.requirements.find(item=>item.id===target.requirementId)));
      const candidate=draft.candidates.find(item=>item.id===target.candidateId&&item.source==='boss'&&item.sourceAccountKey===target.sourceAccountKey&&item.externalId===target.candidateExternalId);
      if(candidate){mergeBossCandidateFields(candidate,result.profile,{source:'boss_message',capturedAt:result.meta?.capturedAt||now()});if(result.profile.displayMeta)candidate.displayMeta=structuredClone(result.profile.displayMeta);candidate.updatedAt=now();}
      ensureCandidateMaster(draft);
    });
    return {status:result.status,profile:result.profile,meta:result.meta,message:result.message};
  }
  const inbox = createInboxAutomation({ store, ...inboxOptions, services: {
    syncConversations: importConversations,
    collectCandidate: id => job('boss-inbox-collect', '归档新沟通人的资料与附件', () => collector.collectCandidate(id)),
    analyzeConversationPriority: analyzePriority,
    analysisFingerprint: (state,id) => replyPriorityAnalysisKey(state,id),
    findReusableAnalysis: (id) => store.mutate(state => {
      const cached=findReusableReplyPriority(state,id),reused=cached&&reuseReplyPriorityRecord(state,id,cached);
      return reused?saveReplyPriority(state,reused):null;
    }),
    modelReady: async state => (await publicModelSettings(state.settings, secrets)).configured,
    ...inboxServices,
  } });
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host)) return json(res, 403, { error: 'invalid_host', message: '仅允许本机访问。' });
      if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) return json(res, 403, { error: 'invalid_origin', message: '拒绝来自其他网站的工作台请求。' });
      const url = new URL(req.url, `http://${host}`); const route = url.pathname;
      const publicNavigation = req.method==='GET' && req.headers['sec-fetch-mode']==='navigate' && req.headers['sec-fetch-dest']==='document' && !route.startsWith('/api/');
      if (req.headers['sec-fetch-site'] === 'cross-site' && !publicNavigation) return json(res, 403, { error: 'cross_site', message: '拒绝跨站访问。' });
      if (route.startsWith('/api/')) {
        const match = pattern => route.match(pattern);
        if (req.method === 'GET' && route === '/api/health') return json(res, 200, { ok: true, service: '招序 HR', version, ...(INSTALLED ? { installId: process.env.HR_INSTALL_ID || '' } : {}) });
        if (req.method === 'GET' && route === '/api/feishu/recipients') {
          const connection=store.read().settings.feishuConnection;
          if(!connection)return json(res,200,{status:'unavailable',source:'feishu_directory',recipients:[],message:'请先连接云咩咩飞书应用，再搜索通讯录。'});
          const result=await directoryService.search({connection,query:String(url.searchParams.get('query')||'').trim(),refresh:url.searchParams.get('refresh')==='1',limit:30});
          return json(res,200,{...result,status:result.status==='permission_required'?'needs_permission':result.status});
        }
        if (req.method === 'GET' && route === '/api/workspace') {
          const state = store.read(), conversations = state.conversations || [];
          state.settings.model = await publicModelSettings(state.settings, secrets);
          for (const conversation of conversations) if (conversation.replyPriority) conversation.replyPriority.stale = conversation.replyPriority.analysisKey ? conversation.replyPriority.analysisKey !== replyPriorityAnalysisKey(state, conversation.id) : conversation.replyPriority.sourceFingerprint !== replyPriorityFingerprint(state, conversation.id);
          state.analyses = state.analyses.map(row => {
            let stale;
            if(row.scene==='sourcing_match'){try{stale=row.analysisKey!==sourcingMatchAnalysisKey(state,{sourceId:row.sourceId,requirementId:row.requirementId});}catch{stale=true;}}
            else stale=row.scene === 'conversation_priority' ? !conversations.some(item => item.id === row.conversationId) || (row.analysisKey ? row.analysisKey !== replyPriorityAnalysisKey(state,row.conversationId) : row.sourceFingerprint !== replyPriorityFingerprint(state, row.conversationId)) : Boolean(row.requirementVersion && state.requirements.find(item => item.id === row.requirementId)?.version !== row.requirementVersion);
            return {...row,stale};
          });
          if(state.settings.bossOfflineMode===true)state.connections.boss={status:'offline',message:'离线整理已有数据，未连接 BOSS。'};
          state.candidates = state.candidates.map(candidate=>({...candidate,candidateProfile:candidateCareerProfile(candidate)}));
          state.documents = state.documents.map(document => documentForDisplay(state, document));
          state.sourcingCandidates = (state.sourcingCandidates||[]).map(row=>{
            const c=state.candidates.find(c=>c.id===row.candidateId&&c.sourceAccountKey===row.sourceAccountKey&&c.externalId===row.externalId);
            return c?{...row,profile:candidateProfileView(c,row.profile||{})}:row;
          });
          state.conversations = (state.conversations||[]).map(row=>{
            const c=state.candidates.find(c=>c.id===row.candidateId&&c.sourceAccountKey===row.sourceAccountKey&&c.externalId===row.candidateExternalId);
            return c&&row.profile?{...row,profile:candidateProfileView(c,row.profile)}:row;
          });
          state.prompts = state.prompts.map(promptView);
          return json(res, 200, { ...state, inboxStatus: inbox.status(), liveCaptureStatus:liveCapture.status(), copilotStatus:copilot.status(), interviewReportStatus:interviewReports.status(), interviewNotificationStatus:interviewNotifications.status(), schema: SCHEMA });
        }
        if (req.method === 'GET' && route === '/api/inbox/status') return json(res, 200, inbox.status());
        if (req.method === 'GET' && route === '/api/interview-automation/status') return json(res, 200, interviewAutomation.status());
        if (req.method === 'GET' && route === '/api/interview-live/status') return json(res, 200, liveCapture.status());
        if (req.method === 'GET' && route === '/api/interview-copilot/status') return json(res,200,copilot.status());
        if (req.method === 'GET' && route === '/api/interview-report/status') return json(res,200,interviewReports.status());
        if (req.method === 'GET' && route === '/api/interview-copilot/agent-status') return json(res,200,await inspectInterviewAgent({provider:store.read().settings.interviewCopilot?.agentProvider||'codex'}));
        if (req.method === 'GET' && route === '/api/export/workspace') {
          const state = store.read(); state.settings.model = await publicModelSettings(state.settings, secrets); res.setHeader('Content-Disposition', 'attachment; filename="zhaoxu-workspace.json"'); return json(res, 200, state);
        }
        if (req.method === 'GET' && route === '/api/meetings/active') return json(res, 200, await meetingAdapter.listActiveMeetings(feishuOptions()));
        if (req.method === 'GET' && match(/^\/api\/resumes\/([^/]+)\/captures\/([0-9]+)$/)) {
          return json(res, 410, { error: 'online_resume_retired', message: '在线简历采集与识图功能已移除，请使用可下载的简历附件。' });
        }
        if (req.method === 'GET' && match(/^\/api\/resumes\/([^/]+)\/download$/)) {
          const resume = requireEntity(store.read().resumes, match(/^\/api\/resumes\/([^/]+)\/download$/)[1], '简历');
          if (isRetiredOnlineResume(resume)) return json(res, 410, { error: 'online_resume_retired', message: '历史在线快照已停用；请下载或上传候选人提供的简历附件。' });
          const file = await fs.readFile(resumeDownloadPath(resume));
          res.writeHead(200, { 'Content-Type': resume.mimeType, 'Content-Disposition': `attachment; filename="resume${path.extname(resume.name).replace(/[^a-z.]/gi, '')}"; filename*=UTF-8''${encodeURIComponent(resume.name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(file);
        }
        if (req.method === 'GET' && match(/^\/api\/documents\/([^/]+)\/download$/)) {
          const state = store.read();
          const doc = documentForDisplay(state, requireEntity(state.documents, match(/^\/api\/documents\/([^/]+)\/download$/)[1], '资料'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `inline; filename="interview-${doc.id}.html"`, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' }); return res.end(renderDocumentHtml(doc));
        }
        if (!['POST', 'PATCH'].includes(req.method)) return json(res, 404, { error: 'not_found', message: '接口不存在。' });
        const input = await body(req, route === '/api/resumes/upload' ? 15 * 1024 * 1024 : 1024 * 1024);
        if (req.method === 'PATCH' && match(/^\/api\/candidates\/([^/]+)\/profile$/)) {
          const id=match(/^\/api\/candidates\/([^/]+)\/profile$/)[1],preview=updateCandidateProfile(store.read(),id,input);
          if(!preview.changed)return json(res,200,preview);
          return json(res,200,await store.mutate(state=>{
            const result=updateCandidateProfile(state,id,input);
            if(result.changed)addActivity(state,'candidate-profile',`更新候选人主档：${result.candidate.name||'未填写姓名'}`,'人工维护资料，保留原始来源，不重新分析或发送消息。');
            return result;
          }));
        }
        if (req.method === 'PATCH' && route === '/api/interview-automation/settings') return json(res, 200, await interviewAutomation.configure(input));
        if (req.method === 'PATCH' && route === '/api/interview-live/settings') return json(res,200,await liveCapture.configure(input));
        if (req.method === 'PATCH' && route === '/api/interview-copilot/settings') return json(res,200,await copilot.configure(input));
        if (req.method === 'PATCH' && route === '/api/interview-report/settings') return json(res,200,await interviewReports.configure(input));
        if (req.method === 'PATCH' && match(/^\/api\/interviews\/([^/]+)\/notifications$/)) {
          if(Object.keys(input).some(key=>!['notificationRecipients','notificationSettings','meetingOwnerOpenId'].includes(key)))throw badRequest('只能修改本场接收人和消息环节设置。');
          const row=await store.mutate(state=>{
            const current=requireEntity(state.interviews,route.split('/')[3],'面试');
            const priorRecipients=new Set(resolveInterviewRecipients(state,current,'preparation').map(person=>person.openId)),priorStages=current.notificationSettings||{};
            if(current.reminder?.status==='sending'||current.copilot?.deliveries?.some(x=>x.status==='sending')||current.notifications?.deliveries?.some(x=>x.status==='sending'))throw Object.assign(new Error('本场消息正在发送，请等待回执后修改接收人。'),{statusCode:409});
            if(current.feishuConnection&&state.settings.feishuConnection&&!sameLarkConnection(current.feishuConnection,state.settings.feishuConnection))throw Object.assign(new Error('本场日程属于其他应用，不能将其接收人重新绑定到当前应用。'),{statusCode:409});
            if(Object.hasOwn(input,'notificationRecipients'))current.notificationRecipients=normalizeRecipientList(input.notificationRecipients);
            if(Object.hasOwn(input,'notificationSettings'))current.notificationSettings=validateNotificationSettings(input.notificationSettings,current.notificationSettings||state.settings.interviewAutomation?.defaultNotificationSettings);
            if(Object.hasOwn(input,'meetingOwnerOpenId')){
              if(current.eventId)throw badRequest('已创建的会议不在此处变更发起人；可以调整通知接收人和追加受邀面试官。');
              if(typeof input.meetingOwnerOpenId!=='string'||input.meetingOwnerOpenId&&!/^ou_[A-Za-z0-9_-]{1,200}$/.test(input.meetingOwnerOpenId))throw badRequest('会议发起人标识无效。');
              current.meetingOwnerOpenId=input.meetingOwnerOpenId;
            }
            if(!current.notifications)initializeInterviewNotifications(current,state.settings,{now:notificationClock()});
            current.notifications.recipientAddedAt??={};
            for(const person of resolveInterviewRecipients(state,current,'preparation'))if(!priorRecipients.has(person.openId)||!current.notifications.recipientAddedAt[person.openId])current.notifications.recipientAddedAt[person.openId]=notificationStamp();
            current.notifications.stageEnabledAt??={};
            for(const [kind,enabled] of Object.entries(current.notificationSettings||{}))if(enabled===true&&priorStages[kind]===false)current.notifications.stageEnabledAt[kind]=notificationStamp();
            current.reminderEnabled=current.notificationSettings?.preparation!==false;
            current.updatedAt=now();
            addActivity(state,'interview',`更新面试通知：${current.title}`,'本场接收人和消息环节已保存；已发送回执与历史报告保留。');
            return current;
          });
          void interviewNotifications.run().catch(()=>{});
          return json(res,200,row);
        }
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/report$/)) return json(res,200,await interviewReports.runInterview(route.split('/')[3]));
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/copilot\/run$/)) {
          if(input.dryRun!==true)throw badRequest('手动运行只提供建议预览，请明确 dryRun:true；后台发送由持续辅助配置控制。');
          return json(res,200,await copilot.runInterview(route.split('/')[3],{dryRun:true}));
        }
        if (req.method === 'PATCH' && match(/^\/api\/interviews\/([^/]+)\/copilot\/speakers$/)) {
          return json(res,200,await store.mutate(state=>{
            const row=requireEntity(state.interviews,route.split('/')[3],'面试'),roles=input.roles;
            if(!roles||typeof roles!=='object'||Array.isArray(roles)||Object.keys(roles).length>30)throw badRequest('说话人角色映射无效。');
            const labels=new Set((row.liveSession?.segments||[]).flatMap(segment=>[segment.speaker,segment.speakerId].filter(value=>typeof value==='string'&&value)));
            if(Object.entries(roles).some(([label,role])=>!labels.has(label)||!['candidate','interviewer','unknown'].includes(role)))throw badRequest('只能为本场已取得的说话人标注候选人、面试官或未知。');
            row.copilotSpeakerRoles={...roles};return {roles:row.copilotSpeakerRoles};
          }));
        }
        if (req.method === 'POST' && match(/^\/api\/documents\/([^/]+)\/codex-preparation$/)) return json(res, 410, {error:'legacy_preparation_retired',message:'单人固定问题入口已停用，请使用会前准备模板生成面试资料。已有历史资料保留。'});
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/reminder\/send$/)) return json(res, 200, await interviewAutomation.sendTestReminder(match(/^\/api\/interviews\/([^/]+)\/reminder\/send$/)[1], input));
        if (req.method === 'PATCH' && match(/^\/api\/interviews\/([^/]+)\/automation$/)) return json(res, 200, await store.mutate(state=>{
          const row=requireEntity(state.interviews,match(/^\/api\/interviews\/([^/]+)\/automation$/)[1],'面试');
          if (['sending','joining'].includes(row.reminder?.status) || row.reminder?.testReceipt?.status==='sending' || row.autoJoin?.status==='joining') throw Object.assign(new Error('本场面试自动任务正在确认回执，请稍后修改。'),{statusCode:409});
          Object.assign(row,validateInterviewAutomationInput({...row,...input},state.settings.interviewAutomation));
          ensureInterviewAutomationState(state); row.updatedAt=now();return row;
        }));
        if(req.method==='POST'&&route==='/api/candidate-pool/join')return json(res,201,await store.mutate(state=>{
          const result=joinCandidatePool(state,input);if(!result.alreadyInPool||result.sourceAdded)addActivity(state,'candidate-pool',`加入候选人池：${result.candidate.name}`,`来源：${input.channel==='boss_search'?'BOSS 搜索 / 推荐':'BOSS 消息'}；保留首次加入时间，不重复建档。`);
          return {...result,candidateId:result.candidate.id,message:result.alreadyInPool?'已在候选人池，已保留首次加入时间。':'已加入候选人池。'};
        }));
        if(req.method==='POST'&&route==='/api/candidate-pool/join-batch'){
          if(!Array.isArray(input.items)||!input.items.length||input.items.length>20)throw badRequest('请选择 1–20 位人选加入候选人池。');
          return json(res,201,await store.mutate(state=>{const results=input.items.map(item=>joinCandidatePool(state,item));const added=results.filter(row=>!row.alreadyInPool).length;addActivity(state,'candidate-pool','批量加入候选人池',`新增 ${added} 位，其余复用已有档案与首次加入时间。`);return {added,alreadyInPool:results.length-added,results:results.map(row=>({candidateId:row.candidate.id,applicationId:row.applicationId,alreadyInPool:row.alreadyInPool})),message:`已加入 ${added} 位人选；${results.length-added} 位已在池中。`};}));
        }
        if(req.method==='PATCH'&&match(/^\/api\/sourcing-candidates\/([^/]+)$/))return json(res,200,await store.mutate(state=>{
          const row=requireEntity(state.sourcingCandidates,match(/^\/api\/sourcing-candidates\/([^/]+)$/)[1],'搜索来源');
          if(!Object.hasOwn(input,'requirementId'))throw badRequest('请选择要比较的招聘需求。');
          if(input.requirementId)requireEntity(state.requirements,input.requirementId,'招聘需求');row.requirementId=input.requirementId||null;row.updatedAt=now();return row;
        }));
        if(req.method==='POST'&&match(/^\/api\/sourcing-candidates\/([^/]+)\/analyze$/))return json(res,201,await analyzeSourcing(match(/^\/api\/sourcing-candidates\/([^/]+)\/analyze$/)[1],input));
        if(store.read().settings.bossOfflineMode===true&&(route==='/api/inbox/run'||route==='/api/connections/check'&&input.includeBoss===true))throw Object.assign(new Error('当前为离线整理模式，未连接 BOSS 或触发新采集。'),{statusCode:409,code:'boss_offline'});
        if(req.method==='PATCH'&&route==='/api/inbox/settings'&&input.enabled===true&&store.read().settings.bossOfflineMode===true)throw badRequest('请先关闭离线模式，再启用 BOSS 自动同步。');
        if (req.method === 'PATCH' && route === '/api/inbox/settings') return json(res, 200, await inbox.configure(input));
        if (req.method === 'POST' && route === '/api/inbox/run') return json(res, 200, await inbox.run({ trigger: 'manual', ...(input.limit ? { limit: input.limit } : {}) }));
        if (req.method === 'POST' && match(/^\/api\/conversations\/([^/]+)\/priority-analysis$/)) {
          if (input.generator && input.generator !== 'model') throw badRequest('自动分析默认使用系统模型 API；此入口不提供规则打分。');
          if ('force' in input && typeof input.force !== 'boolean') throw badRequest('强制重分析参数必须是布尔值。');
          return json(res, 201, await analyzePriority(match(/^\/api\/conversations\/([^/]+)\/priority-analysis$/)[1], { force: input.force === true }));
        }
        if(req.method==='POST'&&route==='/api/boss/jobs/sync')return json(res,200,await importJobs());
        if(req.method==='PATCH'&&match(/^\/api\/boss\/jobs\/([^/]+)$/))return json(res,200,await store.mutate(state=>{
          if(!Object.hasOwn(input,'requirementId'))throw badRequest('请选择招聘需求，或明确解绑。');
          const result=setBossJobMapping(state,match(/^\/api\/boss\/jobs\/([^/]+)$/)[1],input.requirementId);
          refreshConversationSummaries(state);addActivity(state,'job-mapping',`关联平台岗位：${result.job.title}`,input.requirementId?'已关联内部招聘需求，同一岗位的会话按稳定ID匹配。':'已解除平台岗位与需求的关联；原人工选择保留。');return result;
        }));
        if(req.method==='POST'&&match(/^\/api\/boss\/jobs\/([^/]+)\/requirement$/))return json(res,201,await store.mutate(state=>{
          const source=requireEntity(state.bossJobs,match(/^\/api\/boss\/jobs\/([^/]+)\/requirement$/)[1],'BOSS岗位');
          if(source.requirementId)return {requirement:requireEntity(state.requirements,source.requirementId,'招聘需求'),job:source,reused:true};
          const row={id:uid('req'),createdAt:now(),...validateRequirement({title:source.title,city:source.city,salaryRange:source.salaryRange,status:'draft',jd:source.jd||'平台仅返回职位摘要，请补充业务目标、职责和面试标准。',mustHaves:[]}),source:'boss_job',sourceJobId:source.externalId,sourceAccountKey:source.sourceAccountKey,jdSource:{accountKey:source.sourceAccountKey,capturedAt:source.capturedAt}};
          state.requirements.unshift(row);const result=setBossJobMapping(state,source.id,row.id);refreshConversationSummaries(state);addActivity(state,'requirement',`从BOSS岗位建立需求：${row.title}`,'本地新建需求草稿并关联来源岗位，未修改或发布平台职位。');return {requirement:row,...result,reused:false};
        }));
        if (req.method === 'PATCH' && match(/^\/api\/prompts\/([^/]+)$/)) return json(res, 200, await store.mutate(state => {
          const row = requireEntity(state.prompts, match(/^\/api\/prompts\/([^/]+)$/)[1], '提示词');
          assertEditablePromptUpdate(input);
          const before = { ...structuredClone(row), previousVersions: undefined };
          for (const key of ['name', 'description', 'systemPrompt']) if (key in input) { if(typeof input[key]!=='string'||input[key].length>(key==='systemPrompt'?80000:1000))throw badRequest('业务分析规则或名称超出有效范围。');const value = input[key].trim(); if (!value && key !== 'description') throw badRequest('模板名称和业务分析规则不能为空。'); row[key] = value; }
          if ('evaluationRules' in input) row.evaluationRules=normalizeEvaluationRules(row.scene,input.evaluationRules);
          row.previousVersions = [...(row.previousVersions || []), before].slice(-20); row.version++; row.updatedAt = now(); addActivity(state, 'prompt', `更新提示词：${row.name}`, `已保存 v${row.version}，历史分析继续引用原版本。`); return promptView(row);
        }));
        if (req.method === 'POST' && match(/^\/api\/prompts\/([^/]+)\/reset$/)) return json(res, 200, await store.mutate(state => {
          const row = requireEntity(state.prompts, match(/^\/api\/prompts\/([^/]+)\/reset$/)[1], '提示词');
          const history = [...(row.previousVersions || []), { ...structuredClone(row), previousVersions: undefined }].slice(-20);
          const defaults=defaultPromptFor(row.scene),technical=promptTechnicalContract(row.scene);
          Object.assign(row, defaults, { systemPrompt:businessRulesForPrompt(defaults),userPrompt:technical.userPrompt,outputSchema:technical.outputSchema,editingPolicyVersion:PROMPT_CONTRACT_VERSION,id: row.id, version: row.version + 1, previousVersions: history, updatedAt: now() }); return promptView(row);
        }));
        if (req.method === 'POST' && route === '/api/model/settings') {
          const validated = validateModelSettings(input), before = store.read().settings.model;
          const status = await secrets.keyStatus();
          if (status.keyStored && before.baseUrl && validated.baseUrl !== before.baseUrl && !text(input.apiKey)) throw badRequest('更换模型服务地址时，请重新填写对应服务的 API Key。');
          if (text(input.apiKey)) await secrets.saveModelKey(input.apiKey, validated.baseUrl);
          await store.mutate(state => { state.settings.model = { baseUrl: validated.baseUrl, model: validated.model, temperature: validated.temperature, maxTokens: validated.maxTokens, timeoutMs: validated.timeoutMs, jsonMode: validated.jsonMode, tokenParameter: validated.tokenParameter }; addActivity(state, 'model', '保存模型连接配置', '密钥受本机 Windows 用户保护，不进入工作区导出或飞书。'); });
          return json(res, 200, await publicModelSettings(store.read().settings, secrets));
        }
        if (req.method === 'POST' && route === '/api/model/key/remove') { await secrets.removeModelKey(); return json(res, 200, { ...await publicModelSettings(store.read().settings, secrets), message: '已清除本机保存的模型密钥。' }); }
        if (req.method === 'POST' && route === '/api/model/test') return json(res, 200, await job('model-test', '测试模型连接', async () => {
          const settings = store.read().settings.model; const result = await testModelConnection({ settings: { ...settings, maxTokens: 64 }, apiKey: await secrets.getModelKey(settings.baseUrl), ...modelTransport }); return { ...result, ok: true };
        }));
        if (req.method === 'POST' && route === '/api/analyses') return json(res, 201, await job(`analysis-${text(input.scene, 100)}`, '生成招聘分析草稿', async () => {
          if (input.scene === 'conversation_priority' || input.scene === 'sourcing_match') throw badRequest('请从相应来源人选的分析入口操作，以保留正确的资料、岗位和缓存范围。');
          const row = await runAnalysis(store.read(), input, { secrets, ...modelTransport }); return store.mutate(state => saveAnalysis(state, row));
        }));
        if (req.method === 'POST' && route === '/api/resumes/upload') {
          const state = store.read(); requireEntity(state.candidates, input.candidateId, '候选人');
          if (input.applicationId && requireEntity(state.applications, input.applicationId, '应聘流程').candidateId !== input.candidateId) throw badRequest('简历所属候选人与应聘流程不一致。');
          if (typeof input.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64) || input.contentBase64.length > Math.ceil(MAX_RESUME_BYTES / 3) * 4) throw badRequest('简历上传内容不是有效的限额内 Base64。');
          const resume = await archiveResumeBytes({ candidateId: input.candidateId, applicationId: input.applicationId, name: input.name, bytes: Buffer.from(input.contentBase64, 'base64'), existing: state.resumes });
          return json(res, 201, await store.mutate(draft => { const existing = draft.resumes.find(row => !isRetiredOnlineResume(row) && row.candidateId === resume.candidateId && (row.applicationId || null) === (resume.applicationId || null) && row.sha256 === resume.sha256); if (existing) return { ...existing, deduplicated: true }; draft.resumes.unshift(resume); addActivity(draft, 'resume', `归档简历：${resume.name}`, `原始文件已本地保存，解析状态：${resume.textStatus}。`); return resume; }));
        }
        if (req.method === 'POST' && (route === '/api/resumes/boss/online' || (route === '/api/resumes/boss' && input.kind === 'online'))) return json(res, 410, { error: 'online_resume_retired', message: '在线简历采集与识图功能已移除，请使用可下载的简历附件。' });
        if (req.method === 'POST' && route === '/api/resumes/boss') return json(res, 201, await job('boss-resume-download', '下载并归档 BOSS 简历', async () => {
          const owner = resumeOwner(input);
          const adapter = resumeAdapter || await import('./lib/boss-resumes.mjs');
          const result = await adapter.downloadBossResume({ ...owner.selectors, kind: input.kind || 'attachment', outputDirectory: RESUME_ROOT });
          if (result.status !== 'ok' || !result.file) throw Object.assign(new Error(result.message || '尚未取得当前账号已获授权的简历；可上传候选人已提供的文件。'), { code: result.status, statusCode: 422 });
          verifyResumeIdentity(result, owner);
          const resume = await archiveDownloadedResume(result, { candidateId: owner.candidate.id, applicationId: owner.application?.id, existing: owner.state.resumes });
          return saveResume(resume);
        }));
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/meeting-import$/)) {
          const id = match(/^\/api\/interviews\/([^/]+)\/meeting-import$/)[1]; requireEntity(store.read().interviews, id, '面试');
          return json(res, 200, await job(`meeting-import-${id}`, '读取飞书面试结果', async () => {
            const result = await meetingAdapter.importMeetingMaterial(input.urlOrId, feishuOptions());
            await store.mutate(state => { const row = requireEntity(state.interviews, id, '面试'); row.meetingMaterial = result; row.updatedAt = now(); }); return result;
          }));
        }
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/live\/poll$/)) return json(res,200,await pollInterviewLive(route.split('/')[3],input));
        if (req.method === 'POST' && route === '/api/requirements') return json(res, 201, await store.mutate(state => { const row = { id: uid('req'), createdAt: now(), ...validateRequirement(input) }; state.requirements.unshift(row); addActivity(state, 'requirement', `新建需求：${row.title}`, `状态：${row.status === 'draft' ? '草稿' : '进行中'}，标准 v${row.version}`); return row; }));
        if (req.method === 'PATCH' && match(/^\/api\/requirements\/([^/]+)$/)) return json(res, 200, await store.mutate(state => { const row = requireEntity(state.requirements, match(/^\/api\/requirements\/([^/]+)$/)[1], '需求'); const updated = validateRequirement(input, row); Object.assign(row, updated); addActivity(state, 'requirement', `更新需求：${row.title}`, `标准 v${row.version}，历史面试包保留原版本。`); return row; }));
        if (req.method === 'PATCH' && match(/^\/api\/applications\/([^/]+)$/)) {
          const updated=await store.mutate(state => {
          const row = requireEntity(state.applications, match(/^\/api\/applications\/([^/]+)$/)[1], '应聘流程');
          if(!isCandidateInPool(requireEntity(state.candidates,row.candidateId,'候选人')))throw Object.assign(new Error('请先从来源列表明确加入候选人池，再推进应聘流程。'),{statusCode:409});
          if ('stage' in input) { if (!(input.stage in STAGES)) throw badRequest('候选阶段无效。'); row.stage = input.stage; }
          if ('notes' in input) row.notes = text(input.notes, 20000);
          if ('reviewStatus' in input) { if (!['pending', 'reviewed'].includes(input.reviewStatus)) throw badRequest('复核状态无效。'); row.reviewStatus = input.reviewStatus; }
          row.updatedAt = now();
          addActivity(state, 'stage', `${requireEntity(state.candidates, row.candidateId, '候选人').name} · ${STAGES[row.stage]}`, '人工更新工作台阶段；此动作不向招聘平台发送消息。'); return row;
          });
          if(updated.stage==='interview'&&store.read().automations.find(item=>item.id==='interview-pack')?.status==='enabled') {
            await ensureInterviewPack(updated.id,{softFailure:true});
            await store.mutate(state=>{state.automations.find(item=>item.id==='interview-pack').lastRun=now();});
          }
          return json(res,200,updated);
        }
        if (req.method === 'POST' && route === '/api/interview-packs') return json(res, 201, await ensureInterviewPack(input.applicationId));
        if (req.method === 'POST' && route === '/api/interviews') {
          validateInterviewAutomationInput(input,store.read().settings.interviewAutomation);
          const existing = store.read().interviews.find(row => row.applicationId === input.applicationId && new Date(row.startAt).valueOf() === new Date(input.startAt).valueOf() && row.round === (text(input.round) || '初面'));
          if (existing) return json(res, 200, input.createCalendar ? await createCalendar(existing.id) : existing);
          interviewPayload(input,store.read(),{notificationNow:notificationClock()});
          const doc=await ensureInterviewPack(input.applicationId,{softFailure:true});
          const interview = await store.mutate(state => { const { data, application } = interviewPayload(input, state,{notificationNow:notificationClock()}); data.documentId = doc.id; state.interviews.unshift(data); application.stage = 'interview'; application.updatedAt = now(); addActivity(state, 'interview', `安排面试：${data.title}`, '已保存到本地面试日历。'); return data; });
          if (input.createCalendar === true) { try { return json(res, 201, await createCalendar(interview.id)); } catch (error) { return json(res, 502, { error: error.status || 'calendar_failed', message: `面试已在本地保存，飞书日程未确认：${error.message}`, interview: requireEntity(store.read().interviews, interview.id, '面试') }); } }
          return json(res, 201, interview);
        }
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/calendar$/)) return json(res, 200, await createCalendar(match(/^\/api\/interviews\/([^/]+)\/calendar$/)[1]));
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/calendar\/bind$/)) {
          const row = await bindExistingCalendar(route.split('/')[3], input);
          if (row.notifications?.enabled === true) void interviewNotifications.deliver(row.id, 'invitation', { manual: true }).catch(() => {});
          return json(res, 200, row);
        }
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/calendar\/refresh$/)) {
          const id=match(/^\/api\/interviews\/([^/]+)\/calendar\/refresh$/)[1],snapshot=store.read(),row=requireEntity(snapshot.interviews,id,'面试');
          if(row.calendarStatus!=='synced'||!row.eventId)throw Object.assign(new Error('本场日程尚无已确认回执，未读取或创建其他日程。'),{statusCode:409});
          assertCalendarConnection(row,snapshot.settings.feishuConnection);
          return json(res,200,await job(`calendar-meta-${id}`,'读取本场飞书日程',async()=>{
            const result = row.calendarBinding?.source === 'existing_event'
              ? await readExistingCalendar(row, row.calendarBinding, { connection: row.calendarBinding.readConnection })
              : await feishu.hydrateInterviewCalendar(row, feishuOptions(snapshot.settings));
            if (row.calendarBinding?.meetingNo && result.calendarBinding?.meetingNo !== row.calendarBinding.meetingNo) throw Object.assign(new Error('原日程的会议号已变化，请核对面试绑定。'), { statusCode: 409, code: 'calendar_binding_conflict' });
            return store.mutate(state=>{const current=requireEntity(state.interviews,id,'面试');if(current.eventId!==row.eventId||!sameLarkConnection(state.settings.feishuConnection,snapshot.settings.feishuConnection))throw Object.assign(new Error('读取期间本场日程或应用发生变化，请刷新后重试。'),{statusCode:409});Object.assign(current,result,{updatedAt:now()});return current;});
          }));
        }
        if (req.method === 'POST' && match(/^\/api\/interviews\/([^/]+)\/notes$/)) return json(res, 200, await store.mutate(state => { const row = requireEntity(state.interviews, match(/^\/api\/interviews\/([^/]+)\/notes$/)[1], '面试'); const doc = requireEntity(state.documents, row.documentId, '面试包'); if (typeof input.transcript === 'string' && input.transcript.trim()) row.transcriptReview = prepareTranscriptReview(doc, input.transcript); if (Array.isArray(input.coverage)) row.coverage = input.coverage.slice(0, 80).map(item => ({ key: text(item.key, 200), covered: item.covered === true })).filter(item => item.key); row.updatedAt = now(); addActivity(state, 'interview', `保存面试记录：${row.title}`, '原始记录与问题覆盖标记已本地保存。'); return row; }));
        if (req.method === 'POST' && route === '/api/connections/check') return json(res, 200, await connections());
        if (req.method === 'POST' && route === '/api/feishu/check') {
          const connection=feishuOptions();
          const result=await feishu.getFeishuStatus(connection);
          return json(res,200,await store.mutate(state=>{
            if(!sameLarkConnection(state.settings.feishuConnection,connection.connection))throw Object.assign(new Error('检测期间飞书应用已变更，请重新检测。'),{statusCode:409});
            state.connections.feishu={...result,checkedAt:now()};return state.connections.feishu;
          }));
        }
        if (req.method === 'POST' && route === '/api/feishu/credentials') {
          const options=feishuOptions();
          if(!options.connection)throw badRequest('请先配置 HR 专用飞书应用。');
          if(input.appId!==options.connection.appId)throw badRequest('密钥所属应用与当前 HR 连接不一致，未保存。');
          if(typeof input.appSecret!=='string'||input.appSecret.length<16||input.appSecret.length>512||/[\r\n\0]/.test(input.appSecret))throw badRequest('应用密钥格式无效。');
          if(interviewEffectPending()||[...busy].some(type=>/^(?:feishu-|calendar-|meeting-|live-poll-)/.test(type)))throw Object.assign(new Error('飞书任务正在执行，请等待完成后再保存凭据。'),{statusCode:409});
          return json(res,200,await job('feishu-credentials','保存 HR 应用凭据',async()=>{
            await configureProfile({connection:options.connection,appSecret:input.appSecret});
            const result=await feishu.getFeishuStatus(options);
            await store.mutate(state=>{
              if(!sameLarkConnection(state.settings.feishuConnection,options.connection))throw Object.assign(new Error('当前 HR 应用已变更，请重新验证。'),{statusCode:409});
              state.connections.feishu={...result,checkedAt:now()};
            });
            return result;
          }));
        }
        if (req.method === 'POST' && route === '/api/candidates/import-boss') return json(res, 200, await importBoss(input));
        if (req.method === 'POST' && route === '/api/conversations/import-boss') return json(res, 200, await importConversations());
        if(req.method==='POST'&&route==='/api/conversations/profiles/batch'){
          if(!Array.isArray(input.conversationIds)||!input.conversationIds.length||input.conversationIds.length>20||input.conversationIds.some(id=>typeof id!=='string'||!id))throw badRequest('请选择1–20条具体会话补齐资料。');
          const ids=[...new Set(input.conversationIds)],snapshot=store.read();for(const id of ids)requireEntity(snapshot.conversations,id,'会话');
          return json(res,200,await job('boss-profile-batch','补齐本页候选资料',async()=>{
            const results=[];let stopped=false;
            for(const id of ids){
              try{const result=await readAndSaveProfile(id);results.push({conversationId:id,status:result.status,updated:true});}
              catch(error){const code=error.status||error.code||'error';results.push({conversationId:id,status:code,updated:false,message:text(error.message,600)});if(['need_auth','requires_review','rate_limited','permission_denied','captcha','verification_required','challenge_required','cdp_unavailable','busy'].includes(code)){stopped=true;break;}}
              if(profileBatchDelayMs>0&&id!==ids.at(-1))await new Promise(resolve=>setTimeout(resolve,profileBatchDelayMs));
            }
            const updated=results.filter(row=>row.updated).length;
            return {status:updated===ids.length?'ok':'partial',updated,failed:results.length-updated,deferred:ids.length-results.length,stopped,results,modelCalls:0,resumeDownloads:0,message:`已补齐 ${updated} 条候选资料；未调用模型或重复下载简历${stopped?'，剩余项目等待连接或权限恢复':''}。`};
          }));
        }
        if (req.method === 'POST' && match(/^\/api\/conversations\/([^/]+)\/profile$/)) {
          const id = match(/^\/api\/conversations\/([^/]+)\/profile$/)[1];
          return json(res, 200, await job(`boss-profile-${id}`, '读取沟通人资料', () => readAndSaveProfile(id)));
        }
        if (req.method === 'POST' && match(/^\/api\/conversations\/([^/]+)\/refresh$/)) {
          const id = match(/^\/api\/conversations\/([^/]+)\/refresh$/)[1];
          return json(res, 200, await job(`boss-history-${id}`, '读取 BOSS 沟通记录', async () => {
            const state = store.read(), row = requireEntity(state.conversations, id, '会话');
            const adapter = await import('./lib/boss-messages.mjs');
            const result = await adapter.getBossConversationMessages({ port: state.settings.cdpPort, conversationId: row.externalId, peerId: row.peerId, sourceAccountKey:row.sourceAccountKey, candidateExternalId:row.candidateExternalId, readonlyNative:true });
            if (!['ok', 'partial', 'no_data'].includes(result.status)) throw Object.assign(new Error(result.message || '当前无法只读取得会话历史。'), { status: result.status, statusCode: 502 });
            return store.mutate(draft => importMessageBatch(draft, id, result));
          }));
        }
        if (req.method === 'POST' && match(/^\/api\/conversations\/([^/]+)\/candidate$/)) return json(res, 201, await store.mutate(state => {
          const conversation = requireEntity(state.conversations, match(/^\/api\/conversations\/([^/]+)\/candidate$/)[1], '会话');
          const result=joinCandidatePool(state,{channel:'boss_message',sourceId:conversation.id,...(input.requirementId?{requirementId:input.requirementId}:{})});
          addActivity(state,'candidate-pool',`加入候选人池：${result.candidate.name}`,'由 BOSS 消息来源显式加入，未连接平台、发送消息或请求简历。');
          return {...result,candidateId:result.candidate.id,applicationId:result.applicationId,message:result.alreadyInPool?'已在候选人池，保留首次加入时间。':'已加入候选人池，可按关联岗位继续跟进。'};
        }));
        if (req.method === 'PATCH' && match(/^\/api\/conversations\/([^/]+)$/)) return json(res, 200, await store.mutate(state => {
          const row = requireEntity(state.conversations, match(/^\/api\/conversations\/([^/]+)$/)[1], '会话');
          for (const [key, table] of [['requirementId', 'requirements'], ['candidateId', 'candidates']]) if (key in input) {
            if (input[key]) {
              const linked=requireEntity(state[table], input[key], key === 'candidateId' ? '候选人' : '需求');
              if(key==='candidateId' && (row.source!=='boss' || linked.source!=='boss' || !row.sourceAccountKey || !row.candidateExternalId || row.sourceAccountKey!==linked.sourceAccountKey || row.candidateExternalId!==linked.externalId)) throw Object.assign(new Error('会话与候选人的平台账号或人选标识不一致，未保存关联。'),{statusCode:409});
            }
            row[key] = input[key] || null;
          }
          if('requirementId' in input){row.requirementSource='manual';delete row.jobMappingResolution;}
          reconcileConversationJob(state,row);
          if(input.mappingResolution)resolveConversationJobMapping(state,row,input.mappingResolution);
          if ('notes' in input) row.notes = text(input.notes, 20000);
          if ('followUpAt' in input) { if (input.followUpAt && !Number.isFinite(new Date(input.followUpAt).valueOf())) throw badRequest('跟进时间无效。'); row.followUpAt = input.followUpAt ? new Date(input.followUpAt).toISOString() : null; }
          if ('communicationStatus' in input) { if (!['new', 'needs_reply', 'waiting', 'interview_ready', 'closed'].includes(input.communicationStatus)) throw badRequest('沟通状态无效。'); row.communicationStatus = input.communicationStatus; }
          Object.assign(row, analyzeConversation(row, state.messages, state.requirements.find(item => item.id === row.requirementId)), { updatedAt: now() });
          addActivity(state, 'communication', `更新沟通跟进：${row.peerName}`, '保存本地关联、备注与跟进时间，不向 BOSS 发送消息。'); return row;
        }));
        if (req.method === 'POST' && route === '/api/settings') return json(res, 200, await store.mutate(state => {
          if('bossOfflineMode' in input){if(typeof input.bossOfflineMode!=='boolean')throw badRequest('离线整理开关必须为布尔值。');state.settings.bossOfflineMode=input.bossOfflineMode;if(input.bossOfflineMode){state.settings.inboxAutomation.enabled=false;state.settings.inboxAutomation.nextRunAt=null;}}
          if (interviewEffectPending() || [...busy].some(type => /^(?:feishu-|calendar-|meeting-|live-poll-)/.test(type))) throw Object.assign(new Error('飞书任务正在执行，请等待回执后再修改连接设置。'), { statusCode: 409 });
          if('feishuConnection' in input){
            const connection=normalizeLarkConnection(input.feishuConnection);
            if(!sameLarkConnection(state.settings.feishuConnection,connection)){
              state.settings.feishuConnection=connection;
              state.connections.feishu={status:'unknown',message:'HR 专用飞书应用已配置，等待验证凭据和功能权限。',...connection};
              state.connections.storage={mode:'local',message:'原多维表配置和本地资料保留，等待新应用取得访问权限。'};
            }
          }
          if('feishuAppName' in input)state.settings.feishuAppName=text(input.feishuAppName,100);
          if ('cdpPort' in input) { const port = Number(input.cdpPort); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw badRequest('CDP 端口无效。'); state.settings.cdpPort = port; }
          if ('baseUrl' in input) { const baseUrl = text(input.baseUrl, 2000); if (baseUrl && !/^https:\/\/[a-z0-9.-]+\.(?:feishu\.cn|larksuite\.com)\/(?:base|wiki)\/[a-zA-Z0-9]+/.test(baseUrl)) throw badRequest('请输入有效的飞书多维表链接。'); if (state.settings.baseUrl !== baseUrl) { state.settings.baseToken = ''; state.settings.tables = {}; state.settings.fieldMaps = {}; state.settings.recordMaps = {}; delete state.settings.lastSyncAt; delete state.settings.lastPullAt; state.connections.storage = { mode: 'local', message: '多维表绑定已变更，等待重新初始化和同步。' }; } state.settings.baseUrl = baseUrl; }
          if ('baseName' in input) state.settings.baseName = text(input.baseName, 100) || '招序 HR · 招聘工作台';
          if ('calendarId' in input) state.settings.calendarId = text(input.calendarId, 300);
          addActivity(state, 'settings', '更新连接设置', '已保存本地设置，未读取或导出平台凭证。'); return state.settings;
        }));
        if (req.method === 'POST' && route === '/api/feishu/initialize') return json(res, 200, await job('feishu-initialize', '初始化飞书招聘数据表', async () => {
          try {
            const settings=store.read().settings;
            const result = await feishu.initializeBase(settings, SCHEMA, baseFeishuOptions(settings));
            await store.mutate(state => { Object.assign(state.settings, result.settings || result); state.connections.storage = { mode: 'local', message: '多维表已绑定，待首次同步。' }; }); return result;
          } catch (error) {
            if (error.partialSettings) await store.mutate(state => { Object.assign(state.settings, error.partialSettings); state.connections.storage = { mode: 'local', message: '多维表部分创建，保留回执，可修复后继续初始化。' }; });
            throw error;
          }
        }));
        if (req.method === 'POST' && route === '/api/feishu/sync') return json(res, 200, await syncFeishu());
        if (req.method === 'POST' && route === '/api/feishu/pull') return json(res, 200, await job('feishu-pull', '从飞书多维表读取', async () => {
          const revision = store.read().revision;
          const settings=store.read().settings;
          const result = await feishu.readWorkspaceFromBase(settings,baseFeishuOptions(settings));
          return store.mutate(state => {
            if (state.revision !== revision) throw Object.assign(new Error('读取期间本地数据发生变化，请完成当前操作后重新读取。'), { statusCode: 409 });
            let count = 0;
            for (const key of SCHEMA.tables.map(table => table.key)) if (Array.isArray(result[key])) { const current = new Map((state[key] || []).map(row => [row.id, row])); for (const row of result[key]) { if (!row.id || typeof row.id !== 'string') throw new Error('飞书快照缺少工作台 ID。'); current.set(row.id, row); count++; } state[key] = [...current.values()]; }
            Object.assign(state.settings, result.settings || {}); state.settings.lastPullAt = now();
            if(settings.feishuConnection)state.settings.feishuSyncedConnection=structuredClone(settings.feishuConnection);
            if (result.recordMaps) state.settings.recordMaps = result.recordMaps;
            reconcileAllConversationJobs(state);refreshConversationSummaries(state);
            state.connections.storage = { mode: 'feishu', message: '已回读飞书多维表，本地保留镜像。' };
            return { imported: count, message: `已从飞书回读 ${count} 条记录，本地未出现在飞书中的记录保留。` };
          });
        }));
        if (req.method === 'POST' && match(/^\/api\/automations\/([^/]+)\/run$/)) {
          const id = match(/^\/api\/automations\/([^/]+)\/run$/)[1];
          if (id === 'boss-import') return json(res, 200, await importBoss(input));
          if (id === 'boss-conversations') return json(res, 200, await importConversations());
          if (id === 'feishu-sync') return json(res, 200, await syncFeishu());
          if (id === 'interview-pack') return json(res, 200, await job(id, '批量准备面试资料', async () => {
            const before=store.read().documents.length;
            for(const app of store.read().applications.filter(row=>row.stage==='interview'))await ensureInterviewPack(app.id);
            const generated=store.read().documents.length-before;
            return {generated,message:`新增 ${generated} 份面试包；相同材料和模板不会重复分析。`};
          }));
          throw badRequest('自动化规则不存在。');
        }
        return json(res, 404, { error: 'not_found', message: '接口不存在。' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { message: '不支持该请求方法。' });
      let relative; try { relative = decodeURIComponent(route).replace(/^\/+/, ''); } catch { throw badRequest('路径无效。'); }
      if (relative.includes('\\') || relative.split('/').includes('..')) return json(res, 403, { message: '无效文件路径。' });
      let file = path.resolve(PUBLIC, relative || 'index.html');
      if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return json(res, 403, { message: '无效文件路径。' });
      try { if (!(await fs.stat(file)).isFile()) file = path.join(PUBLIC, 'index.html'); } catch { if (path.extname(relative)) return json(res, 404, { message: '文件不存在。' }); file = path.join(PUBLIC, 'index.html'); }
      const content = await fs.readFile(file); const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'", 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!res.headersSent) json(res, error.statusCode || 500, { error: error.status || error.code || 'request_failed', message: text(error.message, 1500), ...(error.missingScopes?{missingScopes:error.missingScopes}:{}), ...(error.upstreamCode?{upstreamCode:error.upstreamCode}:{}) }); else res.end(); }
  });
  server.once('listening', () => { inbox.start().catch(error => console.error(`自动同步启动失败：${text(error.message,300)}`)); interviewAutomation.start().catch(error=>console.error(`面试自动任务启动失败：${text(error.message,300)}`));liveCapture.start().catch(error=>console.error(`会中持续采集启动失败：${text(error.message,300)}`));copilot.start().catch(error=>console.error(`持续面试辅助启动失败：${text(error.message,300)}`));interviewReports.start().catch(error=>console.error(`会后分析启动失败：${text(error.message,300)}`));interviewNotifications.start().catch(()=>{}); });
  server.on('close', () => { inbox.stop(); interviewAutomation.stop();liveCapture.stop();copilot.stop();interviewReports.stop();interviewNotifications.stop(); });
  return { server, store, connections, inbox, interviewAutomation,liveCapture,copilot,interviewReports,interviewNotifications };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createWorkbench();
  const port = Number(process.env.HR_PORT || DEFAULT_WEB_PORT);
  server.listen(port, '127.0.0.1', () => console.log(`招序 HR 已启动：http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请检查已运行的工作台或设置 HR_PORT。` : error.message); process.exitCode = 1; });
}
