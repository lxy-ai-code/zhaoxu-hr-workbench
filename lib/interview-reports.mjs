import { digest, uid } from './store.mjs';
import { defaultPromptFor } from './prompts.mjs';
import { buildInterviewReportInput, normalizeInterviewReport, createInsufficientInterviewReport, REPORT_OUTPUT_SCHEMA, REPORT_SYSTEM_PROMPT } from './interview-report-policy.mjs';
import {localReportEndEvidence} from './interview-report-presence.mjs';

export const DEFAULT_INTERVIEW_REPORT_SETTINGS=Object.freeze({enabled:false,delaySeconds:90});
const settingsOf=state=>({...DEFAULT_INTERVIEW_REPORT_SETTINGS,...state.settings?.interviewReport});
const stamp=value=>new Date(value).toISOString();
const date=value=>Date.parse(value||'')||0;
const fail=message=>Object.assign(new Error(message),{code:'invalid_report_settings',statusCode:400});
const safeError=error=>({code:String(error?.code||'report_failed'),message:String(error?.message||'会后分析未完成。').replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi,'[凭据省略]').slice(0,400)});
function promptOf(state){return state.prompts?.find(row=>row.scene==='interview_report')||defaultPromptFor('interview_report');}
function requestKey(state,input,id){const prompt=promptOf(state),engine=state.settings.interviewCopilot||{},row=state.interviews.find(x=>x.id===id),connection=state.settings.feishuConnection;return digest(JSON.stringify([input.fingerprint,prompt.systemPrompt,prompt.userPrompt,prompt.evaluationRules,prompt.version,engine.mode||'agent',engine.agentProvider||'codex',(engine.mode==='api'?state.settings.model:null),connection?{profile:connection.profile,identity:connection.identity,appId:connection.appId,tenantKey:connection.tenantKey}:null,row.applicationId,row.candidateId,row.requirementId,row.eventId,row.autoJoin?.meetingId,row.copilotSpeakerRoles||{}]));}
function dueReason(state,row,now){
  if(!settingsOf(state).enabled)return '会后自动分析已暂停。';
  if(['cancelled','canceled','deleted'].includes(row.status))return '本场面试已取消。';
  if(!date(row.endAt)||now<date(row.endAt)+settingsOf(state).delaySeconds*1000)return '等待本场预定结束及记录汇集。';
  return '';
}

/** Generates evidence-bound drafts after a meeting. No delivery, hiring action,
 * candidate ranking, remote writes or participant-role guesses are performed. */
export function createInterviewReports({store,services,clock=Date.now,tickMs=20000}={}){
  let started=false,timer=null,running=null,epoch=0;
  const busy=new Set();
  function status(){const state=store.read();return {enabled:settingsOf(state).enabled,started,running:busy.size>0,status:!settingsOf(state).enabled?'disabled':busy.size?'analyzing':started?'scheduled':'stopped',settings:settingsOf(state)};}
  async function task(id,fn){return store.mutate(state=>{const row=state.interviews.find(x=>x.id===id);if(!row)throw Object.assign(new Error('面试不存在。'),{statusCode:404});row.interviewReportTask??={};return fn(row.interviewReportTask,row,state);});}
  async function notify(id,service,payload){
    if(typeof services[service]!=='function')return;
    try{await services[service](id,payload);}catch(error){await task(id,t=>{t.notificationError=safeError(error);});}
  }
  async function waiting(id,reason){const prior=store.read().interviews.find(x=>x.id===id)?.interviewReportTask;if(prior?.status==='waiting'&&prior.lastReason===reason)return;await task(id,t=>Object.assign(t,{status:'waiting',lastReason:reason}));}
  async function configure(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['enabled','delaySeconds'].includes(key)))throw fail('会后自动分析配置无效。');await store.mutate(state=>{const next={...settingsOf(state),...input};if(typeof next.enabled!=='boolean'||!Number.isInteger(next.delaySeconds)||next.delaySeconds<30||next.delaySeconds>3600)throw fail('会后开关应为布尔值，等待时间应为 30–3600 秒的整数。');state.settings.interviewReport=next;});epoch++;if(started)void run().catch(()=>{});return status();}
  async function runInterview(id,{automatic=false}={}){
    if(busy.has(id))throw Object.assign(new Error('本场会后分析正在进行。'),{code:'report_busy',statusCode:409});
    let snapshot=store.read(),row=snapshot.interviews.find(x=>x.id===id);
    if(!row)throw Object.assign(new Error('面试不存在。'),{statusCode:404});
    const runEpoch=epoch;
    // Finished interviews keep their original report and template snapshot.
    // Editing the library must never spend tokens rescoring historical meetings.
    // An explicit manual request still compares the current input/template key.
    const finishedReport=row.interviewReport,finishedMeetingId=row.autoJoin?.meetingId||row.liveSession?.meetingId||null;
    if(automatic&&row.interviewReportTask?.status==='completed'&&finishedReport&&finishedReport.interviewId===id&&finishedReport.applicationId===row.applicationId&&finishedReport.candidateId===row.candidateId&&finishedReport.requirementId===row.requirementId&&finishedReport.endingEvidence?.meetingId===finishedMeetingId&&['confirmed_end','manual_confirmed_end'].includes(finishedReport.endingBasis))return {status:'completed',reused:true,historical:true,report:finishedReport};
    if(automatic){const reason=dueReason(snapshot,row,clock());if(reason)return {status:'waiting',reason};if(date(row.interviewReportTask?.retryAt)>clock()||date(row.interviewReportTask?.nextProbeAt)>clock())return {status:'waiting'};}
    let input;
    try{input=buildInterviewReportInput(snapshot,id);}catch(error){if(automatic){await waiting(id,'等待取得本场会议文字记录。');return {status:'waiting'};}throw error;}
    const key=requestKey(snapshot,input,id);
    const cached=row.interviewReport?.inputKey===key?row.interviewReport:null;
    const expectedMeetingId=row.autoJoin?.meetingId||row.liveSession?.meetingId||null;
    const cachedEndConfirmed=cached&&['confirmed_end','manual_confirmed_end'].includes(cached.endingBasis)&&cached.endingEvidence?.meetingId===expectedMeetingId;
    if(cached&&(!automatic||cachedEndConfirmed))return {status:'completed',reused:true,report:cached};
    busy.add(id);
    try{
      let endingBasis='manual_review',endingEvidence=null;
      if(automatic){
        let presence=localReportEndEvidence({interview:row,settings:snapshot.settings,connection:snapshot.settings.feishuConnection});
        if(!presence){try{presence=services.probeActive?await services.probeActive(row,snapshot):{active:null,ended:false};}catch(error){presence={active:null,ended:false,reason:'暂未读取到明确会议状态，将继续等待。',error:safeError(error)};}}
        if(!started||epoch!==runEpoch||dueReason(store.read(),store.read().interviews.find(x=>x.id===id),clock()))return {status:'discarded'};
        if(presence?.active===true){await task(id,t=>Object.assign(t,{status:'waiting',lastReason:'飞书仍确认在本场会议中，等待会议结束。',nextProbeAt:stamp(clock()+60000)}));return {status:'waiting',reason:'meeting_active'};}
        if(presence?.ended!==true){const scopeMissing=presence?.missingScopes?.length||presence?.error?.missingScopes?.length;await task(id,t=>Object.assign(t,{status:'waiting',lastReason:scopeMissing?'读取会议状态所需权限尚未开通，尚未确认会议结束；继续等待并在 60 秒后重试。':'会议结束状态尚未确认，继续等待并在 60 秒后重试。',lastProbeAt:stamp(clock()),lastProbeError:presence?.error||null,nextProbeAt:stamp(clock()+60000)}));return {status:'waiting',reason:'meeting_end_unconfirmed'};}
        endingBasis=presence.source==='manual_interview_completion'?'manual_confirmed_end':'confirmed_end';
        endingEvidence={source:presence.source||'explicit_end_receipt',meetingId:presence.meetingId||row.autoJoin?.meetingId||null,verifiedAt:presence.verifiedAt||stamp(clock()),...(presence.meetingStatus!==undefined?{meetingStatus:presence.meetingStatus}:{})};
      }
      if(cached){
        let saved;
        await task(id,(t,target,state)=>{
          if(!started||epoch!==runEpoch||dueReason(state,target,clock())||requestKey(state,buildInterviewReportInput(state,id),id)!==key||target.interviewReport?.id!==cached.id||target.interviewReport?.inputKey!==key)throw Object.assign(new Error('核验期间本场资料或报告已变化，未沿用旧结束依据。'),{code:'report_context_changed',statusCode:409});
          Object.assign(target.interviewReport,{endingBasis,endingEvidence});saved=target.interviewReport;
          Object.assign(t,{status:'completed',lastFinishedAt:stamp(clock()),lastReason:'已确认本场会议结束，复用已有报告，未重复调用模型。',lastError:null,lastProbeError:null,retryAt:null,nextProbeAt:null});
        });
        await notify(id,'onReportSaved',{report:saved,endingBasis,endingEvidence});
        return {status:'completed',reused:true,endVerified:true,report:saved};
      }
      await task(id,(t,target,state)=>{if((automatic&&(!started||epoch!==runEpoch||dueReason(state,target,clock())))||requestKey(state,buildInterviewReportInput(state,id),id)!==key)throw Object.assign(new Error('本场资料或设置已变化，未启动旧材料分析。'),{code:'report_context_changed',statusCode:409});Object.assign(t,{status:'analyzing',inputKey:key,endingBasis,endingEvidence,lastAttemptAt:stamp(clock()),lastReason:'结合本场记录、岗位和职业资料生成会后草稿。',lastError:null});});
      await notify(id,'onAnalysisStarted',{inputKey:key,endingBasis,endingEvidence});
      const candidateSegments=input.sourceCoverage?.candidateEffectiveSegments??input.sourceCoverage?.candidateSegments??input.segments?.filter(x=>x.role==='candidate').length??0;
      const prompt=promptOf(snapshot),engine={mode:'agent',agentProvider:'codex',...snapshot.settings.interviewCopilot};
      const response=candidateSegments>0?await services.analyze({state:snapshot,input,prompt,schema:REPORT_OUTPUT_SCHEMA,systemPrompt:REPORT_SYSTEM_PROMPT,settings:engine}):{output:createInsufficientInterviewReport(input),provider:'evidence_check'};
      const normalized=response.provider==='evidence_check'?response.output:normalizeInterviewReport(response.output??response,input);
      let saved;
      await task(id,(t,target,state)=>{
        if((automatic&&(!started||epoch!==runEpoch||dueReason(state,target,clock())))||requestKey(state,buildInterviewReportInput(state,id),id)!==key)throw Object.assign(new Error('分析期间本场资料或设置发生变化，未覆盖当前档案。'),{code:'report_context_changed',statusCode:409});
        const generator=response.provider==='evidence_check'?'evidence_check':engine.mode==='api'?'api':engine.agentProvider;
        const report={...normalized,id:uid('interview_report'),policyVersion:input.policyVersion,interviewId:id,applicationId:target.applicationId,candidateId:target.candidateId,requirementId:target.requirementId,inputKey:key,inputFingerprint:input.fingerprint,promptId:prompt.id,promptVersion:prompt.version,evaluationRules:structuredClone(input.evaluationRules),generator,model:response.model||null,status:normalized.totalScore===null?'insufficient_evidence':'draft',sourceCoverage:input.sourceCoverage,endingBasis,endingEvidence,createdAt:stamp(clock()),humanReviewRequired:true};
        if(endingBasis==='manual_review')report.limitations=[...new Set([...(report.limitations||[]),'本报告由人工触发，仅分析已取得材料；本次操作没有将会议判定为结束。'])];
        if(target.interviewReport){target.interviewReportHistory??=[];target.interviewReportHistory.push(structuredClone(target.interviewReport));}
        target.interviewReport=report;Object.assign(t,{status:'completed',lastFinishedAt:stamp(clock()),lastReason:report.totalScore===null?'已整理会后报告；缺少有效证据的维度保留为空。':'已生成带原话依据的三维评分草稿，等待人工复核。',lastError:null,retryAt:null,nextProbeAt:null});saved=report;
      });
      await notify(id,'onReportSaved',{report:saved,endingBasis,endingEvidence});
      return {status:'completed',reused:false,report:saved};
    }catch(error){await task(id,t=>Object.assign(t,{status:/not_configured|missing|auth|unavailable/.test(error?.code||'')?'blocked':'retrying',lastError:safeError(error),lastReason:'会后分析未完成，已保留原有报告。',retryAt:stamp(clock()+300000)}));throw error;}
    finally{busy.delete(id);}
  }
  async function execute(){for(const row of store.read().interviews||[]){if(!started||!settingsOf(store.read()).enabled)break;try{await runInterview(row.id,{automatic:true});}catch{}}return status();}
  function run(){if(running)return running;if(!started)return Promise.resolve(status());running=execute().finally(()=>{running=null;});return running;}
  async function start(){if(started)return status();started=true;epoch++;timer=setInterval(()=>{void run().catch(()=>{});},tickMs);timer.unref?.();void run().catch(()=>{});return status();}
  function stop(){started=false;epoch++;if(timer)clearInterval(timer);timer=null;}
  return {start,stop,run,runInterview,configure,status};
}
