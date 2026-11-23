import { candidateProfileView } from './candidate-master.mjs';
import { digest, uid, now } from './store.mjs';
import { professionalCriteria } from './criteria.mjs';
import { isUsableAttachmentResume, isRetiredOnlineResume } from './resume-policy.mjs';
import { defaultPromptFor } from './prompts.mjs';
import { compilePrompt } from './prompt-governance.mjs';
import { evaluationRulesFor, normalizeEvaluationRules } from './evaluation-rules.mjs';
import { callModel } from './model-api.mjs';
import { jobForConversation } from './job-mappings.mjs';
import { professionalPriorityText, privateProfessionalStatement as privateStatement } from './professional-text.mjs';
export { professionalPriorityText } from './professional-text.mjs';

export const REPLY_PRIORITY_VERSION='reply_priority_v1';
const fail=message=>Object.assign(new Error(message),{statusCode:400,code:'invalid_priority_analysis'});
function careerRows(rows,keys){return (Array.isArray(rows)?rows:[]).slice(0,12).map(row=>Object.fromEntries(keys.flatMap(key=>{const value=professionalPriorityText(row?.[key],3000);return value?[[key,value]]:[]}))).filter(row=>Object.keys(row).length);}
export function buildReplyPriorityInput(state,conversationId){
  const conversation=state.conversations.find(row=>row.id===conversationId);if(!conversation)throw fail('会话不存在。');
  const candidate=(state.candidates||[]).find(row=>row.id===conversation.candidateId&&row.sourceAccountKey===conversation.sourceAccountKey&&row.externalId===conversation.candidateExternalId);
  const requirement=(state.requirements||[]).find(row=>row.id===conversation.requirementId);
  const meta=conversation.profileMeta;
  const profile=candidateProfileView(candidate,meta?.accountKey===conversation.sourceAccountKey&&meta.currentConversationId===conversation.externalId&&meta.currentPeerId===conversation.peerId ? conversation.profile||{} : {});
  const application=(state.applications||[]).find(row=>row.candidateId===candidate?.id&&row.requirementId===requirement?.id);
  const files=(state.resumes||[]).filter(row=>!isRetiredOnlineResume(row)&&candidate&&row.candidateId===candidate.id&&(!row.applicationId||row.applicationId===application?.id));
  const resumes=files.filter(isUsableAttachmentResume).slice(0,8).map(row=>({id:row.id,sha256:row.sha256,text:professionalPriorityText(row.text,18000),truncated:row.truncated===true||row.text.length>18000,source:row.source}));
  const messages=(state.messages||[]).filter(row=>row.conversationId===conversationId&&row.type!=='profile_card'&&['candidate','hr'].includes(row.sender)).sort((a,b)=>Date.parse(a.sentAt||0)-Date.parse(b.sentAt||0)).slice(-40).map(row=>({id:row.id,sender:row.sender,text:professionalPriorityText(row.text,4000),sentAt:row.sentAt,type:row.type})).filter(row=>row.text);
  if(!messages.length&&conversation.lastMessage)messages.push({id:'last-preview',sender:conversation.lastSender||'unknown',text:professionalPriorityText(conversation.lastMessage,4000),sentAt:conversation.lastMessageAt,type:'preview'});
  const career={position:professionalPriorityText(candidate?.profileManualFields?.includes('position')?candidate.position:profile.position||candidate?.position||conversation.peerPosition,200),introduction:professionalPriorityText(profile.introduction||candidate?.introduction),workHistory:careerRows(profile.workHistory||candidate?.workHistory,['company','position','description','responsibilities','achievements','dateRange']),education:careerRows(profile.education||candidate?.education,['degree','major']),skills:(Array.isArray(profile.skills)?profile.skills:[]).filter(item=>typeof item==='string').map(item=>professionalPriorityText(item,200))};
  const job={communicatedJobId:conversation.communicatedJobExternalId||conversation.communicatedJobNumericId||'',communicatedTitle:professionalPriorityText(conversation.communicatedPosition,200),desiredTitle:career.position,requirementId:requirement?.id||null,requirementTitle:professionalPriorityText(requirement?.title,200),jd:professionalPriorityText(requirement?.jd,16000),mustHaves:professionalCriteria(requirement?.mustHaves).map(row=>professionalPriorityText(row,600)),requirementVersion:requirement?.version||null,mappingStatus:conversation.jobMappingStatus||'unmapped',unconfirmedConflict:Boolean(conversation.jobMappingConflict&&!conversation.jobMappingConflict.confirmed)};
  const sourceEvidence=[];
  for(const key of ['communicatedTitle','desiredTitle','jd'])if(job[key])sourceEvidence.push({source:'job',path:`job.${key}`,quote:job[key]});
  job.mustHaves.forEach((quote,i)=>sourceEvidence.push({source:'job',path:`job.mustHaves[${i}]`,quote}));
  for(const key of ['position','introduction'])if(career[key])sourceEvidence.push({source:'profile',path:`career.${key}`,quote:career[key]});
  career.workHistory.forEach((row,i)=>Object.entries(row).forEach(([key,quote])=>sourceEvidence.push({source:'profile',path:`career.workHistory[${i}].${key}`,quote})));
  messages.forEach((row,i)=>sourceEvidence.push({source:'message',path:`messages[${i}].text`,quote:row.text}));
  resumes.forEach((row,i)=>sourceEvidence.push({source:'resume',path:`resumes[${i}].text`,quote:row.text}));
  const taskStatement=/负责|亲自|推动|参与|搭建|招聘|绩效|员工关系|组织诊断|HRBP|hrbp/;
  const hasCareerEvidence=Boolean(career.introduction||career.workHistory.some(row=>row.description||row.responsibilities||row.achievements)||resumes.length||messages.some(row=>row.sender==='candidate'&&row.text.length>=40&&taskStatement.test(row.text)));
  const coverage={profile:Object.keys(profile).length?'professional_summary':'not_collected',attachment:resumes.length?'parsed_attachment':files.length?'unparsed_attachment':'not_available',messages:messages.some(row=>row.type!=='preview')?'captured_history':'previews_only',historyComplete:conversation.historyComplete===true,job:job.requirementId&&job.jd&&!job.unconfirmedConflict?'mapped_requirement':'needs_confirmation',attachmentCount:files.length,parsedAttachmentCount:resumes.length};
  const prompt=state.prompts?.find(row=>row.scene==='conversation_priority')||defaultPromptFor('conversation_priority');
  return {policyVersion:REPLY_PRIORITY_VERSION,conversationId,candidateId:candidate?.id||null,job,career,messages,resumes,coverage,sourceEvidence,evaluationRules:evaluationRulesFor(prompt),scoreEligible:Boolean(job.requirementId&&job.jd&&job.communicatedJobId&&!job.unconfirmedConflict&&hasCareerEvidence),lastSender:conversation.lastSender||'unknown'};
}
export function replyPriorityFingerprint(state,conversationId){const input=buildReplyPriorityInput(state,conversationId);const prompt=state.prompts?.find(row=>row.scene==='conversation_priority')||defaultPromptFor('conversation_priority');return digest(JSON.stringify({input,promptId:prompt.id,promptVersion:prompt.version}));}
const canonicalText=value=>String(value??'').trim().replace(/\s+/g,' ');
const greetingKey=value=>canonicalText(value).replace(/[\p{P}\p{S}\s]/gu,'').toLowerCase();
const routineGreetings=new Set([
  '你好','您好','谢谢','好的','收到','在吗',
  'BOSS好我对这份工作很感兴趣你看我有机会深入沟通下吗',
  '我对这个岗位很感兴趣期待您的回复',
  '我对HRBP很感兴趣希望可以深聊谢谢',
  '您好可以聊聊吗您这个职位我很有兴趣希望进一步了解',
  '我对这个职位很感兴趣希望您能看看我的简历谢谢',
].map(greetingKey));
const canonicalRows=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,canonicalText(value)]))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
/** Material/communication cache key. IDs and timestamps of messages or local
 * files are provenance, not reasons to pay for the same judgment again. */
export function replyPriorityAnalysisKey(state,conversationId){
  const input=buildReplyPriorityInput(state,conversationId),conversation=state.conversations.find(row=>row.id===conversationId),prompt=state.prompts?.find(row=>row.scene==='conversation_priority')||defaultPromptFor('conversation_priority');
  const platformJob=jobForConversation(state,conversation);
  const identity={source:conversation.source||'unknown',account:conversation.sourceAccountKey,candidate:conversation.candidateExternalId||`conversation:${conversation.externalId}`};
  const career={...input.career,introduction:canonicalText(input.career.introduction),workHistory:canonicalRows(input.career.workHistory),education:canonicalRows(input.career.education),skills:input.career.skills.map(canonicalText).sort()};
  const messages=[];
  for(const row of input.messages){if(routineGreetings.has(greetingKey(row.text)))continue;const next={sender:row.sender,text:canonicalText(row.text)};if(JSON.stringify(messages.at(-1))!==JSON.stringify(next))messages.push(next);}
  const files=input.resumes.map(row=>({sha256:row.sha256,text:digest(canonicalText(row.text)),truncated:row.truncated})).sort((a,b)=>String(a.sha256).localeCompare(String(b.sha256)));
  const {requirementVersion,...jobFields}=input.job;
  const job={...jobFields,communicatedJobId:platformJob?.id||input.job.communicatedJobId,jd:canonicalText(input.job.jd),mustHaves:input.job.mustHaves.map(canonicalText)};
  const context={policy:REPLY_PRIORITY_VERSION,identity,job,career,files,attachmentState:input.coverage.attachment,attachmentCount:input.coverage.attachmentCount,messages,lastSender:input.lastSender,communicationStatus:conversation.communicationStatus||'new',template:{id:prompt.id,content:digest(JSON.stringify(compilePrompt(prompt,{})))}};
  return digest(JSON.stringify(context));
}
const evidenceSender=(input,source)=>source?.source==='message'?input.messages[Number(source.path?.match(/^messages\[(\d+)\]/)?.[1])]?.sender:undefined;
function rebindEvidence(input,rows,{state,existing}={}){
  return (Array.isArray(rows)?rows:[]).map(row=>{
    const pieces=String(row.quote||'').trim().split(/\s+/).map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    if(!pieces.length||!pieces[0])throw fail('已有引文不可复用。');
    const pattern=new RegExp(pieces.join('\\s+'),'u');
    const previousMessageIndex=Number(row.path?.match(/^messages\[(\d+)\]/)?.[1]);
    const previousMessageId=existing?.sourceSnapshot?.messageIds?.[previousMessageIndex];
    const sender=row.sender||state?.messages?.find(message=>message.id===previousMessageId)?.sender;
    const candidates=input.sourceEvidence.filter(source=>source.source===row.source&&pattern.test(source.quote)&&(!sender||row.source!=='message'||evidenceSender(input,source)===sender));
    if(row.source==='message'&&!sender&&new Set(candidates.map(source=>evidenceSender(input,source))).size>1)throw fail('已有引文的发言方不明确，不能跨发言方复用。');
    for(const source of candidates){const match=source.quote.match(pattern);if(match)return {source:source.source,path:source.path,quote:match[0],...(source.source==='message'?{sender:evidenceSender(input,source)}:{})};}
    throw fail('已有引文不在当前材料中，需重新分析。');
  });
}
export function findReusableReplyPriority(state,conversationId){
  const key=replyPriorityAnalysisKey(state,conversationId),fingerprint=replyPriorityFingerprint(state,conversationId),input=buildReplyPriorityInput(state,conversationId);
  for(const row of state.analyses||[]){
    if(row.scene!=='conversation_priority'||!['codex','model'].includes(row.generator)||!(row.analysisKey===key||(!row.analysisKey&&row.sourceFingerprint===fingerprint)))continue;
    try{normalizeReplyPriority({...row,evidence:rebindEvidence(input,row.evidence,{state,existing:row}),dimensions:(row.dimensions||[]).map(dimension=>({...dimension,evidence:rebindEvidence(input,dimension.evidence,{state,existing:row})}))},input);return row;}catch{}
  }
  return null;
}
export function reuseReplyPriorityRecord(state,conversationId,existing){
  if(!existing)return null;
  const key=replyPriorityAnalysisKey(state,conversationId),fingerprint=replyPriorityFingerprint(state,conversationId);
  if(existing.analysisKey?existing.analysisKey!==key:existing.sourceFingerprint!==fingerprint)return null;
  try{
    const input=buildReplyPriorityInput(state,conversationId),raw={...existing,evidence:rebindEvidence(input,existing.evidence,{state,existing}),dimensions:(existing.dimensions||[]).map(row=>({...row,evidence:rebindEvidence(input,row.evidence,{state,existing})}))};
    const checked=normalizeReplyPriority(raw,input);
    if(existing.conversationId===conversationId)return {...structuredClone(existing),...checked,analysisKey:key,reused:true,forced:false,generatedAt:existing.generatedAt||existing.createdAt,message:'判断依据未变化，已复用已有分析；本次未调用模型。'};
    return {...createReplyPriorityRecord(state,conversationId,raw,{generator:existing.generator,model:existing.model}),reused:true,forced:false,reusedFrom:existing.id,reusedFromConversationId:existing.conversationId,generatedAt:existing.generatedAt||existing.createdAt,message:'判断依据未变化，已复用并重新对应当前原文；本次未调用模型。'};
  }catch{return null;}
}
export function ensureReplyPriorityCacheKeys(state){
  let changed=false;
  for(const conversation of state.conversations||[]){
    const current=conversation.replyPriority;if(!current||current.analysisKey||current.sourceFingerprint!==replyPriorityFingerprint(state,conversation.id))continue;
    const key=replyPriorityAnalysisKey(state,conversation.id);current.analysisKey=key;
    const stored=state.analyses?.find(row=>row.id===current.id);if(stored)stored.analysisKey=key;
    changed=true;
  }
  return changed;
}
export function normalizeReplyPriority(raw,input){
  const rules=normalizeEvaluationRules('conversation_priority',input.evaluationRules),maxPoints=Object.fromEntries(rules.dimensions.map(row=>[row.key,row.maxPoints])),labels=Object.fromEntries(rules.dimensions.map(row=>[row.key,row.label]));
  if(!raw||typeof raw!=='object'||!String(raw.summary||'').trim())throw fail('模型没有返回可核对的回复分析。');
  const generated=[raw.summary,raw.replyDraft,...(Array.isArray(raw.reasons)?raw.reasons:[]),...(Array.isArray(raw.dimensions)?raw.dimensions.map(row=>row?.rationale):[])].filter(row=>typeof row==='string').join(' ');
  if(privateStatement.test(generated))throw fail('回复排序理由包含不适用的个人属性，未保存评分。');
  function evidence(rows){return (Array.isArray(rows)?rows:[]).slice(0,20).map(row=>{const original=input.sourceEvidence.find(item=>item.path===row?.path&&item.source===row?.source);const quote=String(row?.quote||'').trim();if(!quote||!original||!original.quote.includes(quote))throw fail('模型引用未能对应本次取得的职业资料，未保存评分。');return {source:original.source,path:original.path,quote,...(original.source==='message'?{sender:evidenceSender(input,original)}:{})};});}
  const strings=(rows,max=10)=>(Array.isArray(rows)?rows:[]).slice(0,max).map(row=>professionalPriorityText(typeof row==='string'?row:'',2000)).filter(Boolean);
  let score=raw.score,dimensions=[];
  if(score!==null){
    if(!input.scoreEligible)throw fail('岗位或职业资料不足，只能返回待补充，不能生成数值分。');
    if(!Number.isInteger(score)||score<0||score>100)throw fail('回复优先分必须是0到100的整数或未知。');
    if(!Array.isArray(raw.dimensions)||raw.dimensions.length!==3)throw fail('评分需提供三个固定维度及证据。');
    const seen=new Set();dimensions=raw.dimensions.map(row=>{const max=maxPoints[row.key];if(!max||seen.has(row.key)||row.maxPoints!==max||!Number.isInteger(row.points)||row.points<0||row.points>max)throw fail('评分维度或范围不符合当前模板的回复优先级设置。');seen.add(row.key);const refs=evidence(row.evidence);if(row.points>0&&!refs.length)throw fail('评分维度缺少原文证据。');return {key:row.key,name:labels[row.key],points:row.points,maxPoints:max,rationale:professionalPriorityText(row.rationale,2000),evidence:refs};});
    if(dimensions.reduce((sum,row)=>sum+row.points,0)!==score)throw fail('维度之和与总分不一致，未保存评分。');
    if(dimensions.find(row=>row.key==='role_relevance').points>0&&!dimensions.find(row=>row.key==='role_relevance').evidence.some(row=>row.source==='resume'||(row.source==='profile'&&/^career\.(?:introduction$|workHistory\[\d+\]\.(?:description|responsibilities|achievements)$)/.test(row.path))||(row.source==='message'&&row.quote.length>=20&&input.messages[Number(row.path.match(/^messages\[(\d+)\]/)?.[1])]?.sender==='candidate')))throw fail('岗位职业证据不能仅由职位名称、我方JD或我方消息证明。');
  }
  const recommendation=['reply_now','clarify_first','waiting','insufficient'].includes(raw.recommendation)?raw.recommendation:score==null?'insufficient':'clarify_first';
  const summary=professionalPriorityText(raw.summary,3000),replyDraft=professionalPriorityText(raw.replyDraft,3000);
  if(/直接淘汰|自动拒绝|不予录用|建议录用|不值得回复|不值得考虑|人格|撒谎/.test(generated))throw fail('结果含招聘决定或未经核实的人身判断，未保存。');
  return {title:professionalPriorityText(raw.title||'回复优先级分析',200),summary,score,band:score==null?'insufficient':score>=rules.thresholds.high?'high':score>=rules.thresholds.normal?'normal':'low',dimensions,reasons:strings(raw.reasons),evidence:evidence(raw.evidence),gaps:strings(raw.gaps),recommendation,replyDraft,status:'draft'};
}
export async function analyzeReplyPriority(state,conversationId,{secrets,fetchImpl,lookupImpl,force=false}={}){
  if(!force){const cached=findReusableReplyPriority(state,conversationId);const reused=cached&&reuseReplyPriorityRecord(state,conversationId,cached);if(reused)return reused;}
  const input=buildReplyPriorityInput(state,conversationId),prompt=state.prompts?.find(row=>row.scene==='conversation_priority')||defaultPromptFor('conversation_priority');
  const settings=state.settings.model||{};if(!settings.baseUrl||!settings.model)throw Object.assign(new Error('请先在系统配置中接入模型 API，自动回复分析不会改用规则打分。'),{statusCode:400,code:'model_not_configured'});
  const apiKey=await secrets.getModelKey(settings.baseUrl);
  const response=await callModel({settings,apiKey,...compilePrompt(prompt,input),fetchImpl,lookupImpl});
  let raw;try{raw=JSON.parse(response.content)}catch{throw fail('模型没有返回有效 JSON，未生成评分。')}
  return {...createReplyPriorityRecord(state,conversationId,raw,{generator:'model',model:response.model,usage:response.usage}),forced:force===true};
}
export function createReplyPriorityRecord(state,conversationId,raw,{generator='codex',model,usage}={}){
  if(!['model','codex'].includes(generator))throw fail('回复优先级只使用模型或明确标注的首批 Codex 人工辅助分析。');
  const input=buildReplyPriorityInput(state,conversationId),prompt=state.prompts?.find(row=>row.scene==='conversation_priority')||defaultPromptFor('conversation_priority'),result=normalizeReplyPriority(raw,input),conversation=state.conversations.find(row=>row.id===conversationId);
  return {...result,id:uid('analysis'),scene:'conversation_priority',generator,model,usage,conversationId,candidateId:input.candidateId,requirementId:conversation.requirementId||null,applicationId:input.candidateId?(state.applications||[]).find(row=>row.candidateId===input.candidateId&&row.requirementId===conversation.requirementId)?.id||null:null,createdAt:now(),promptId:prompt.id,promptVersion:prompt.version,evaluationRules:structuredClone(input.evaluationRules),requirementVersion:input.job.requirementVersion,sourceFingerprint:replyPriorityFingerprint(state,conversationId),analysisKey:replyPriorityAnalysisKey(state,conversationId),coverage:input.coverage,conclusion:result.score==null?'资料不足，先补充或确认后由 HR 安排沟通。':'仅用于回复待办排序，需 HR 复核。',clarifyingQuestions:result.gaps,recommendations:result.reasons,questions:[],coreJudgments:[],sourceSnapshot:{policyVersion:REPLY_PRIORITY_VERSION,conversationId,messageIds:input.messages.map(row=>row.id),resumeFiles:input.resumes.map(({id,sha256})=>({id,sha256})),requirementId:input.job.requirementId,requirementVersion:input.job.requirementVersion,evaluationRules:structuredClone(input.evaluationRules),coverage:input.coverage},limitations:['回复优先分不代表录用资格或候选人价值。','未取得的聊天、附件和职业经历保留为信息缺口。']};
}
export function saveReplyPriority(state,row){
  const conversation=state.conversations.find(item=>item.id===row.conversationId);if(!conversation)throw fail('会话不存在。');
  state.analyses??=[];const existing=state.analyses.find(item=>item.scene==='conversation_priority'&&item.conversationId===row.conversationId&&item.sourceFingerprint===row.sourceFingerprint&&item.generator===row.generator);
  const saved=row.forced?row:existing||row;if(!existing||row.forced)state.analyses.unshift(row);
  if(existing&&row.reused&&!row.forced){Object.assign(existing,{analysisKey:row.analysisKey,reused:true,generatedAt:row.generatedAt||existing.createdAt});}
  conversation.replyPriority=structuredClone(saved);
  return row.reused?{...saved,reused:true,forced:false,message:row.message}:saved;
}
