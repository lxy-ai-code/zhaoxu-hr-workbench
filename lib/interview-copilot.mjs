import { digest, uid } from './store.mjs';
import { sameLarkConnection, normalizeLarkConnection } from './lark-context.mjs';
import { buildCopilotInput, normalizeCopilotDecision, mergeCopilotTopics, newCopilotCandidateEvidence, repeatedCopilotQuestion, validatedCopilotMemory, COPILOT_SYSTEM_PROMPT, COPILOT_OUTPUT_SCHEMA } from './interview-copilot-policy.mjs';
import { defaultPromptFor } from './prompts.mjs';
import { resolveInterviewRecipients, recipientRosterKey, notificationEnabled } from './interview-recipients.mjs';

export const DEFAULT_INTERVIEW_COPILOT = Object.freeze({ enabled:false, mode:'agent', agentProvider:'codex', analyzeIntervalSeconds:180, minNotifyMinutes:5, maxMessages:4, minNewChars:120 });
const invalid = message => Object.assign(new Error(message),{code:'invalid_copilot_settings',statusCode:400});
const stamp = time => new Date(time).toISOString();
const time = value => Date.parse(value || '') || 0;
const config = state => ({...DEFAULT_INTERVIEW_COPILOT,...state.settings?.interviewCopilot});
const cleanError = error => ({code:String(error?.code||'copilot_failed'),message:String(error?.message||'辅助分析未完成。').replace(/(?:Bearer\s+|(?:secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,'[凭据省略]').slice(0,400)});
export function validateCopilotSettings(input,previous={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('面试辅助配置无效。');
  const out={...DEFAULT_INTERVIEW_COPILOT,...previous};
  for(const key of Object.keys(input)) {
    if(!Object.hasOwn(DEFAULT_INTERVIEW_COPILOT,key))throw invalid('面试辅助配置包含未知字段。');
    const value=input[key];
    if(key==='enabled'&&typeof value!=='boolean')throw invalid('辅助开关必须为布尔值。');
    if(key==='mode'&&!['agent','api'].includes(value))throw invalid('请选择智能体或模型 API 模式。');
    if(key==='agentProvider'&&!['codex','claude'].includes(value))throw invalid('未识别的智能体类型；首版已接入 Codex。');
    const range={analyzeIntervalSeconds:[60,1800],minNotifyMinutes:[1,60],maxMessages:[1,12],minNewChars:[40,5000]}[key];
    if(range&&(!Number.isInteger(value)||value<range[0]||value>range[1]))throw invalid(`${key} 应为 ${range[0]}–${range[1]} 的整数。`);
    out[key]=value;
  }
  return out;
}
function contextKey(state,row) {
  try {
    const connection=normalizeLarkConnection(state.settings?.feishuConnection);
    if(connection.identity!=='bot'||!connection.appId||!connection.profile||!row?.eventId||!/^\d{10,25}$/.test(row.autoJoin?.meetingId||'')||!sameLarkConnection(row.feishuConnection,connection)||!sameLarkConnection(row.autoJoin?.feishuConnection,connection)||!sameLarkConnection(row.liveSession?.feishuConnection,connection)||row.liveSession?.meetingId!==row.autoJoin.meetingId)return '';
    return digest(JSON.stringify([connection,row.id,row.eventId,row.applicationId,row.candidateId,row.requirementId,row.autoJoin.meetingId,row.copilotSpeakerRoles||{}]));
  }catch{return '';}
}
// Speaker-role corrections invalidate in-flight analysis, but must never reset
// a meeting's delivery quota, topic memory or uncertain-send protection.
function sessionScope(state,row) {
  if(!contextKey(state,row))return null;
  const scope={connection:normalizeLarkConnection(state.settings.feishuConnection),interviewId:row.id,eventId:row.eventId,applicationId:row.applicationId,candidateId:row.candidateId,requirementId:row.requirementId,meetingId:row.autoJoin.meetingId};
  return {key:digest(JSON.stringify(scope)),scope};
}
function legacyReceiptScope(checkpoint) {
  for(const receipt of [...(checkpoint.deliveries||[])].reverse()) {
    try {const connection=normalizeLarkConnection(receipt.connection||receipt.feishuConnection);if(connection.identity==='bot'&&connection.profile&&connection.appId&&/^\d{10,25}$/.test(receipt.meetingId||''))return {connection,meetingId:receipt.meetingId};}catch{}
  }
  return null;
}
function eligibility(state,row,now) {
  if(!config(state).enabled)return '面试辅助已暂停。';
  if(state.settings?.interviewAutomation?.enabled!==true)return '面试自动任务已暂停。';
  if(state.settings?.interviewAutomation?.liveCaptureEnabled!==true)return '等待启用后台会议读取。';
  if(['cancelled','canceled','completed','ended','finished'].includes(row?.status))return '本场已标记完成或取消，持续辅助已停止。';
  if(time(row?.endAt)<=now)return '已到本场预定结束时间，持续辅助已停止。';
  if(!time(row?.startAt)||now<time(row.startAt))return '等待本场面试开始。';
  if(row.calendarStatus!=='synced'||row.autoJoinEnabled!==true||row.autoJoin?.status!=='joined'||!contextKey(state,row))return '等待同一应用确认入会并取得本场发言。';
  if(!notificationEnabled(state,row,'copilot'))return '本场会中辅助消息已关闭。';
  if(!resolveInterviewRecipients(state,row,'copilot').length)return '尚未选择本场接收辅助消息的面试官。';
  return '';
}
function promptFor(state) {return state.prompts?.find(row=>row.scene==='interview_copilot')||defaultPromptFor('interview_copilot');}
function requestKey(state,input) {const p=promptFor(state),c=config(state),row=state.interviews.find(item=>item.id===input.interviewId),scope=sessionScope(state,row);return digest(JSON.stringify([scope?.key||[state.settings?.feishuConnection,row?.eventId,row?.applicationId,row?.liveSession?.meetingId],input.fingerprint,p.systemPrompt,p.userPrompt,p.version,c.mode,c.agentProvider,c.mode==='api'?state.settings.model:null]));}
function topicKey(suggestion,stage) {return suggestion.kind==='pacing'?`pacing:${stage}`:`question:${suggestion.topicKey}`;}
const segmentFingerprint = row => digest(JSON.stringify([row.id, row.text, row.role]));
function freshSpeech(input,now) {return input.segments.some(segment=>time(segment.timestamp)>0&&time(segment.timestamp)<=now+60000&&now-time(segment.timestamp)<=5*60000);}

/** Persistent supervisor: reads local meeting evidence, then delegates one
 * bounded decision to an engine. Only this supervisor can authorize delivery. */
export function createInterviewCopilot({store,services,clock=Date.now,tickMs=10000}={}) {
  let started=false,desiredStarted=false,startPromise=null,timer=null,running=null,epoch=0;
  const busy=new Set();
  function status(){const state=store.read();return {enabled:config(state).enabled,started,running:busy.size>0,status:!config(state).enabled?'disabled':busy.size?'analyzing':started?'scheduled':'stopped',settings:config(state),runtime:'while_workbench_server_running'};}
  async function update(id,fn){return store.mutate(state=>{const row=state.interviews.find(item=>item.id===id);if(!row)throw Object.assign(new Error('面试不存在。'),{statusCode:404});row.copilot??={};return fn(row.copilot,state,row);});}
  async function configure(input){await store.mutate(state=>{state.settings.interviewCopilot=validateCopilotSettings(input,config(state));});epoch++;if(started)void run().catch(()=>{});return status();}
  async function quiet(id,reason,statusValue='quiet'){const old=store.read().interviews.find(x=>x.id===id)?.copilot;if(old?.lastReason===reason&&old.status===statusValue)return;await update(id,c=>Object.assign(c,{status:statusValue,lastReason:reason}));}
  async function bindSession(id) {
    const snapshot=store.read(),row=snapshot.interviews.find(item=>item.id===id),scope=sessionScope(snapshot,row);
    if(!scope||eligibility(snapshot,row,clock())||row.copilot?.sessionKey===scope.key)return;
    await store.mutate(state=>{
      const target=state.interviews.find(item=>item.id===id),fresh=sessionScope(state,target);
      if(!target||!fresh||eligibility(state,target,clock())||fresh.key!==scope.key||target.copilot?.sessionKey===fresh.key)return;
      const previous=target.copilot||{},legacy=legacyReceiptScope(previous);
      const changed=previous.sessionKey?previous.sessionKey!==fresh.key:legacy&&(!sameLarkConnection(legacy.connection,fresh.scope.connection)||legacy.meetingId!==fresh.scope.meetingId);
      if(changed){target.copilotHistory??=[];target.copilotHistory.push({...structuredClone(previous),...(target.copilotPreview?{preview:structuredClone(target.copilotPreview)}:{}),archivedAt:stamp(clock()),archiveReason:'session_changed',...(!previous.sessionKey&&legacy?{legacySessionScope:legacy}:{})});target.copilot={};delete target.copilotPreview;}
      target.copilot={...target.copilot,sessionKey:fresh.key,sessionScope:fresh.scope,sessionBoundAt:stamp(clock()),sessionBoundFrom:changed?'new_session':previous.sessionKey?'existing':legacy?'legacy_receipt':'legacy_preserved'};
    });
  }
  async function runInterview(id,{dryRun=false}={}) {
    if(busy.has(id))throw Object.assign(new Error('本场辅助分析正在进行。'),{code:'copilot_busy',statusCode:409});
    let snapshot=store.read(),row=snapshot.interviews.find(item=>item.id===id);
    if(!row)throw Object.assign(new Error('面试不存在。'),{statusCode:404});
    const currentConfig=config(snapshot),runEpoch=epoch;
    if(!dryRun){const reason=eligibility(snapshot,row,clock());if(reason){await quiet(id,reason,time(row.endAt)<=clock()?'completed':'waiting');return {status:'waiting',reason};}busy.add(id);try{await bindSession(id);}finally{busy.delete(id);}if(!started||epoch!==runEpoch)return {status:'discarded',reason:'辅助设置已变化，未启动旧配置下的分析。'};snapshot=store.read();row=snapshot.interviews.find(item=>item.id===id);const changedReason=eligibility(snapshot,row,clock());if(changedReason)return {status:'waiting',reason:changedReason};}
    const input=buildCopilotInput(snapshot,id,{now:clock()}),key=requestKey(snapshot,input),binding=contextKey(snapshot,row),recipientBinding=recipientRosterKey(snapshot,row,'copilot');
    const checkpoint=row.copilot||{},preview=row.copilotPreview;
    if(!dryRun) {
      if(checkpoint.deliveries?.some(receipt=>['sending','unknown_delivery'].includes(receipt.status))){await quiet(id,'上一条消息的送达状态待核验，暂停后续推送。','blocked');return {status:'blocked'};}
      if(time(checkpoint.nextAnalysisAt)>clock())return {status:'waiting',reason:'尚未到下一次审阅时间。'};
      if(checkpoint.lastInputKey===key){await quiet(id,'材料没有变化，复用已有分析，不重复调用模型。');return {status:'quiet',reused:true,decision:checkpoint.lastDecision};}
      if(!freshSpeech(input,clock())){await quiet(id,'等待近 5 分钟内的新发言，较早内容不会作为即时提醒发送。');return {status:'quiet'};}
      const analyzedIds=new Set(checkpoint.analyzedSegmentIds||[]),previousFingerprints=checkpoint.analyzedSegmentFingerprints||{},hasFingerprints=Object.keys(previousFingerprints).length>0;
      const newCharacters=input.segments.filter(x=>hasFingerprints?previousFingerprints[x.id]!==segmentFingerprint(x):!analyzedIds.has(x.id)).reduce((n,x)=>n+x.text.length,0);
      if(newCharacters<currentConfig.minNewChars){await quiet(id,'新增有效内容不足，继续积累后再判断。','waiting');return {status:'waiting'};}
    }
    const cached=checkpoint.lastInputKey===key?checkpoint.lastDecision:preview?.inputKey===key?preview.decision:null;
    busy.add(id);
    try {
      if(!dryRun)await update(id,c=>Object.assign(c,{status:'analyzing',lastAttemptAt:stamp(clock()),nextAnalysisAt:stamp(clock()+currentConfig.analyzeIntervalSeconds*1000),error:null}));
      const prompt=promptFor(snapshot);
      const response=cached?{output:cached,reused:true}:await services.analyze({state:snapshot,input,prompt,schema:COPILOT_OUTPUT_SCHEMA,systemPrompt:COPILOT_SYSTEM_PROMPT,settings:currentConfig});
      const decision=normalizeCopilotDecision(response.output??response,input);
      if(dryRun){await store.mutate(state=>{const target=state.interviews.find(x=>x.id===id);if(!target||contextKey(state,target)!==binding||buildCopilotInput(state,id,{now:clock()}).fingerprint!==input.fingerprint)throw Object.assign(new Error('预览期间本场资料或发言归属发生变化，请重新预览。'),{code:'copilot_context_changed',statusCode:409});target.copilotPreview={inputKey:key,decision,analyzedAt:stamp(clock()),engine:currentConfig.mode==='api'?'api':currentConfig.agentProvider};});return {status:'preview',dryRun:true,reused:!!response.reused,decision,engine:currentConfig.mode==='api'?'api':currentConfig.agentProvider};}
      let valid=false;
      await update(id,(c,state,target)=>{
        if(!started||epoch!==runEpoch||eligibility(state,target,clock())||contextKey(state,target)!==binding||recipientRosterKey(state,target,'copilot')!==recipientBinding||buildCopilotInput(state,id,{now:clock()}).fingerprint!==input.fingerprint)return;
        if(!response.reused){c.decisionHistory??=[];c.decisionHistory.push({at:stamp(clock()),decision:structuredClone(decision)});c.decisionHistory=c.decisionHistory.slice(-10);}
        const retainedLedger=validatedCopilotMemory(c.memory,target.liveSession?.segments,target.copilotSpeakerRoles,{name:state.candidates.find(row=>row.id===target.candidateId)?.name});
        Object.assign(c,{lastAnalyzedAt:stamp(clock()),lastInputKey:key,lastDecision:decision,summary:decision.summary,stage:decision.stage,status:decision.quiet?'quiet':'ready',lastReason:decision.reason,error:null,analyzedSegmentIds:input.segments.map(x=>x.id),analyzedSegmentFingerprints:Object.fromEntries(input.segments.map(x=>[x.id,segmentFingerprint(x)])),memory:{summary:decision.summary,coverage:decision.coverage,topics:mergeCopilotTopics(retainedLedger.topics,decision.topics,input),sentQuestions:c.memory?.sentQuestions||[],sentTopics:c.memory?.sentTopics||[]}});valid=true;
      });
      if(!valid){await update(id,(c,state,target)=>{if(contextKey(state,target)===binding&&epoch===runEpoch){c.status='waiting';c.lastReason='分析期间取得了新发言或资料变化，旧结果已舍弃，下一轮重新审阅。';c.nextAnalysisAt=stamp(clock());}});return {status:'discarded',reason:'分析期间本场设置、资料或发言变化，未发送过期建议。'};}
      if(decision.quiet||!decision.suggestions.length)return {status:'quiet',decision};
      const beforeSend=store.read(),latest=beforeSend.interviews.find(x=>x.id===id),cp=latest.copilot;
      if(!decision.suggestions.some(x=>x.priority==='high')){await quiet(id,'本轮只有一般建议，保留在工作台，不打断面试。');return {status:'quiet',decision};}
      const sentTopics=new Set(cp.memory?.sentTopics||[]);
      const ledger=validatedCopilotMemory(cp.memory,latest.liveSession?.segments,latest.copilotSpeakerRoles,{name:beforeSend.candidates.find(row=>row.id===latest.candidateId)?.name});
      const deliveryInput={...input,memory:{...input.memory,...ledger}};
      const suggestions=decision.suggestions.filter(x=>{
        if(x.priority!=='high')return false;
        if(repeatedCopilotQuestion(x,deliveryInput,decision.topics))return false;
        if(!sentTopics.has(topicKey(x,decision.stage)))return true;
        if(x.kind==='pacing')return false;
        const detailed=(cp.memory?.sentQuestions||[]).filter(row=>row.kind==='question'&&row.topicKey===x.topicKey);
        return detailed.length>0&&newCopilotCandidateEvidence(x.evidence,detailed.flatMap(row=>row.evidence||[]),input);
      }).slice(0,1);
      if(!suggestions.length){await quiet(id,'本阶段的重要问题已经提示，不重复发送。');return {status:'quiet',decision};}
      if((cp.sentCount||0)>=currentConfig.maxMessages){await quiet(id,'已达到本场消息上限，后续分析留在工作台。');return {status:'quiet',decision};}
      if(cp.lastSentAt&&clock()-time(cp.lastSentAt)<currentConfig.minNotifyMinutes*60000){await quiet(id,'仍在消息冷却期，继续记录面试情况。');return {status:'quiet',decision};}
      if(!freshSpeech(input,clock())){await quiet(id,'分析结果的发言已超过时效，未推送。');return {status:'quiet',decision};}
      const operationId=uid('copilot_message'),recipientOpenId=resolveInterviewRecipients(beforeSend,latest,'copilot')[0]?.openId,connection=normalizeLarkConnection(beforeSend.settings.feishuConnection);
      let claimed=false;
      await update(id,(c,state,target)=>{
        if(!started||epoch!==runEpoch||eligibility(state,target,clock())||contextKey(state,target)!==binding||recipientRosterKey(state,target,'copilot')!==recipientBinding||buildCopilotInput(state,id,{now:clock()}).fingerprint!==input.fingerprint)return;
        c.deliveries??=[];c.deliveries.push({operationId,status:'sending',attemptedAt:stamp(clock()),recipientOpenId,connection,meetingId:target.autoJoin.meetingId,topics:suggestions.map(s=>topicKey(s,decision.stage))});c.deliveries=c.deliveries.slice(-50);c.status='sending';claimed=true;
      });
      if(!claimed)return {status:'discarded'};
      try {
        const receipt=await services.send({interview:latest,requirement:beforeSend.requirements.find(x=>x.id===latest.requirementId),decision:{...decision,suggestions},input,recipientOpenId,recipientRosterKey:recipientBinding,connection,operationId});
        if(!receipt?.messageId||receipt.status!=='sent'||!sameLarkConnection(receipt.feishuConnection,connection)||receipt.recipientOpenId!==recipientOpenId)throw Object.assign(new Error('辅助消息未取得匹配的送达回执，未重发。'),{code:'unknown_delivery'});
        await update(id,c=>{const ledger=c.deliveries.find(x=>x.operationId===operationId);if(ledger)Object.assign(ledger,receipt,{status:'sent',sentAt:stamp(clock())});c.sentCount=(c.sentCount||0)+1;c.lastSentAt=stamp(clock());c.status='sent';c.lastReason='已将一条主要建议私聊发送给面试官。';c.memory??={};c.memory.sentTopics=[...new Set([...(c.memory.sentTopics||[]),...suggestions.map(x=>topicKey(x,decision.stage))])];c.memory.sentQuestions=[...(c.memory.sentQuestions||[]),...suggestions.map(x=>({topicKey:x.topicKey,topicLabel:[...(decision.topics||[]),...input.focuses].find(row=>row.key===x.topicKey)?.label||'',kind:x.kind,stage:decision.stage,question:x.question,nextStep:x.nextStep,evidence:structuredClone(x.evidence),sentAt:stamp(clock())}))].slice(-24);});
        return {status:'sent',decision,receipt};
      }catch(error){await update(id,c=>{const ledger=c.deliveries.find(x=>x.operationId===operationId);if(ledger)Object.assign(ledger,{status:'unknown_delivery',error:cleanError(error)});c.status='blocked';c.error=cleanError(error);c.lastReason='消息送达待核验，已暂停后续推送。';});return {status:'unknown_delivery'};}
    }catch(error){if(!dryRun)await update(id,c=>Object.assign(c,{status:/not_configured|unavailable|auth|missing|unsupported/.test(error?.code||'')?'blocked':'retrying',error:cleanError(error),lastReason:'分析未完成，未发送消息。',nextAnalysisAt:stamp(clock()+Math.max(120,currentConfig.analyzeIntervalSeconds)*1000)}));throw error;}
    finally{busy.delete(id);}
  }
  async function execute(){for(const row of store.read().interviews||[]){if(!started||!config(store.read()).enabled)break;try{await runInterview(row.id);}catch{}}return status();}
  function run(){if(running)return running;if(!started)return Promise.resolve(status());running=execute().finally(()=>{running=null;});return running;}
  function start(){
    desiredStarted=true;if(startPromise)return startPromise;if(started)return Promise.resolve(status());
    startPromise=(async()=>{
      for(const row of store.read().interviews||[])if(row.copilot?.deliveries?.some(x=>x.status==='sending'))await update(row.id,c=>{for(const receipt of c.deliveries)if(receipt.status==='sending'){receipt.status='unknown_delivery';receipt.error={code:'interrupted',message:'服务在消息回执前中断，请人工核验。'};}c.status='blocked';});
      if(!desiredStarted)return status();
      started=true;epoch++;timer=setInterval(()=>{void run().catch(()=>{});},tickMs);timer.unref?.();void run().catch(()=>{});return status();
    })().finally(()=>{startPromise=null;});return startPromise;
  }
  function stop(){desiredStarted=false;started=false;epoch++;if(timer)clearInterval(timer);timer=null;}
  return {start,stop,run,runInterview,configure,status};
}
