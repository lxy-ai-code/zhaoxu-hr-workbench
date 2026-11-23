import { candidateProfileView } from './candidate-master.mjs';
import {digest,uid,now} from './store.mjs';
import {professionalCriteria,sensitiveCriterion} from './criteria.mjs';
import {professionalPriorityText} from './reply-priority.mjs';
import {defaultPromptFor} from './prompts.mjs';
import {compilePrompt,promptTechnicalContract} from './prompt-governance.mjs';
import {evaluationRulesFor,normalizeEvaluationRules} from './evaluation-rules.mjs';
import {callModel} from './model-api.mjs';
import {runInterviewAgent} from './interview-agent.mjs';

export const SOURCING_MATCH_VERSION='sourcing_match_v1';
const fail=(message,code='invalid_sourcing_match')=>Object.assign(new Error(message),{code,statusCode:400});
const arr=value=>Array.isArray(value)?value:[];
const safe=(value,max=12000)=>professionalPriorityText(typeof value==='string'?value:'',max);
const canonical=value=>String(value??'').trim().replace(/\s+/g,' ');
const occupationalAction=/负责|亲自|推动|完成|设计|落地|交付|建立|搭建|优化|管理|跟进|维护|编制|核算|开发|实施|协调|主导|组织了|运营了/;
const occupationalObject=/招聘|交付|绩效|薪酬|员工关系|组织|团队|业务|流程|项目|渠道|数据|核算|对账|财务|运营|开发|系统|产品|客户|销售|供应链|培训|人才|合同|预算|账务|审计|报表/;
const isTaskRef=row=>row?.source==='profile'&&/^career\.(?:introduction$|workHistory\[\d+\]\.(?:description|responsibilities|achievements)$)/.test(row.path)&&row.quote.length>=12&&occupationalAction.test(row.quote)&&occupationalObject.test(row.quote);
const promptFor=state=>state.prompts?.find(row=>row.scene==='sourcing_match')||defaultPromptFor('sourcing_match');
function locate(state,{sourceId,requirementId}={}){
  const source=arr(state.sourcingCandidates).find(row=>row.id===sourceId);
  if(!source||!source.sourceAccountKey||!source.externalId||source.channel&&source.channel!=='boss_search')throw fail('搜索来源不存在或缺少稳定平台身份。');
  const candidate=arr(state.candidates).find(row=>row.id===source.candidateId&&row.source==='boss'&&row.sourceAccountKey===source.sourceAccountKey&&row.externalId===source.externalId);
  if(!candidate)throw fail('搜索来源与人物主档的账号或平台身份不一致，未分析其他人的资料。','identity_mismatch');
  const selected=requirementId??source.requirementId??null;
  const requirement=selected?arr(state.requirements).find(row=>row.id===selected):null;
  if(selected&&!requirement)throw fail('请选择存在的内部招聘需求。','requirement_not_found');
  return {source,candidate,requirement};
}
function careerRows(values,keys){return arr(values).slice(0,15).map(value=>Object.fromEntries(keys.flatMap(key=>{const text=safe(value?.[key],3000);return text?[[key,text]]:[]}))).filter(value=>Object.keys(value).length);}
export function buildSourcingMatchInput(state,options={}){
  const {source,candidate,requirement}=locate(state,options),profile=candidateProfileView(candidate,source.profile||{});
  const career={expectedPosition:safe(profile.expectedPosition||profile.position,300),introduction:safe(profile.introduction),workHistory:careerRows(profile.workHistory,['company','position','description','responsibilities','achievements','dateRange']),education:careerRows(profile.education,['degree','major']),skills:arr(profile.skills).filter(value=>typeof value==='string').slice(0,40).map(value=>safe(value,300)).filter(Boolean)};
  const job={requirementId:requirement?.id||null,title:safe(requirement?.title,300),jd:safe(requirement?.jd,16000),mustHaves:professionalCriteria(requirement?.mustHaves).map(value=>safe(value,1000)),businessGoal:safe(requirement?.businessGoal,4000),successCriteria:safe(requirement?.successCriteria,4000),version:requirement?.version||null};
  const sourceEvidence=[];
  for(const key of ['title','jd','businessGoal','successCriteria'])if(job[key])sourceEvidence.push({source:'requirement',path:`job.${key}`,quote:job[key],claimType:'provided_requirement'});
  job.mustHaves.forEach((quote,index)=>sourceEvidence.push({source:'requirement',path:`job.mustHaves[${index}]`,quote,claimType:'provided_requirement'}));
  for(const key of ['expectedPosition','introduction'])if(career[key])sourceEvidence.push({source:'profile',path:`career.${key}`,quote:career[key],claimType:'platform_career_summary'});
  for(const [index,work]of career.workHistory.entries())for(const[key,quote]of Object.entries(work))sourceEvidence.push({source:'profile',path:`career.workHistory[${index}].${key}`,quote,claimType:'platform_career_summary'});
  career.skills.forEach((quote,index)=>sourceEvidence.push({source:'profile',path:`career.skills[${index}]`,quote,claimType:'platform_career_summary'}));
  const coverage={kind:'search_recommendation_summary',completeResume:false,chatIncluded:false,attachmentIncluded:false,job:job.requirementId&&(job.jd||job.mustHaves.length)?'selected_requirement':'needs_requirement',sourceCapturedAt:source.capturedAt||null};
  return {scene:'sourcing_match',policyVersion:SOURCING_MATCH_VERSION,sourceId:source.id,candidateId:candidate.id,identity:{source:'boss',sourceAccountKey:source.sourceAccountKey,externalId:source.externalId},job,career,sourceEvidence,coverage,evaluationRules:evaluationRulesFor(promptFor(state)),scoreEligible:Boolean(coverage.job==='selected_requirement'&&sourceEvidence.some(isTaskRef))};
}
export function sourcingMatchAnalysisKey(state,options={}){
  const input=buildSourcingMatchInput(state,options),prompt=promptFor(state),{version,...job}=input.job;
  const sortedRows=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,canonical(value)]))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return digest(JSON.stringify({policy:SOURCING_MATCH_VERSION,identity:input.identity,job:Object.fromEntries(Object.entries(job).map(([key,value])=>[key,Array.isArray(value)?value.map(canonical):typeof value==='string'?canonical(value):value])),career:{...input.career,introduction:canonical(input.career.introduction),workHistory:sortedRows(input.career.workHistory),education:sortedRows(input.career.education),skills:input.career.skills.map(canonical).sort()},template:{id:prompt.id,content:digest(JSON.stringify(compilePrompt(prompt,{})))}}));
}
export function normalizeSourcingMatch(raw,input){
  const rules=normalizeEvaluationRules('sourcing_match',input.evaluationRules),labels=Object.fromEntries(rules.dimensions.map(row=>[row.key,row.label]));
  if(!raw||typeof raw!=='object'||!safe(raw.summary))throw fail('匹配分析需要可复核的摘要。');
  const generated=[raw.title,raw.summary,...arr(raw.reasons),...arr(raw.gaps),...arr(raw.dimensions).map(row=>row?.rationale)].filter(value=>typeof value==='string').join(' ');
  if(sensitiveCriterion.test(generated)||/直接淘汰|自动拒绝|不予录用|建议录用|不值得回复|不值得考虑|不值得沟通|人格|撒谎/.test(generated))throw fail('结果含不适用于职业匹配的个人属性或招聘决定，未保存。');
  const evidence=rows=>arr(rows).slice(0,30).map(row=>{const original=input.sourceEvidence.find(item=>item.source===row?.source&&item.path===row?.path),quote=typeof row?.quote==='string'?row.quote.trim():'';if(!original||!quote||!original.quote.includes(quote))throw fail('分析引用无法对应本次搜索摘要或所选岗位。');return {...original,quote};});
  const score=raw.score;let dimensions=[];
  if(score!==null){
    if(!input.scoreEligible)throw fail('岗位标准或具体职业任务不足，应保留未知匹配分。');
    if(!Number.isInteger(score)||score<0||score>100)throw fail('匹配参考分必须为0到100整数或null。');
    if(arr(raw.dimensions).length!==2)throw fail('匹配分需要当前模板的两个维度。');
    const max=Object.fromEntries(rules.dimensions.map(row=>[row.key,row.maxPoints])),seen=new Set();
    dimensions=raw.dimensions.map(row=>{if(!max[row.key]||seen.has(row.key)||row.maxPoints!==max[row.key]||!Number.isInteger(row.points)||row.points<0||row.points>max[row.key])throw fail('匹配维度、分值上限或唯一性不符合当前模板。');seen.add(row.key);const refs=evidence(row.evidence);if(row.points>0&&!refs.length)throw fail('非零匹配分缺少来源证据。');if(row.key==='role_relevance'&&row.points>0&&!refs.some(isTaskRef))throw fail('职业匹配分不能只引用职位名称、学历、年限或我方JD。');if(row.key==='intent_alignment'&&row.points>0&&(!refs.some(ref=>ref.source==='profile'&&ref.path==='career.expectedPosition')||!refs.some(ref=>ref.source==='requirement'&&ref.path==='job.title')))throw fail('意向匹配须分别引用个人期望与评估岗位。');return {key:row.key,name:labels[row.key],points:row.points,maxPoints:row.maxPoints,rationale:safe(row.rationale,2000),evidence:refs};});
    if(dimensions.reduce((sum,row)=>sum+row.points,0)!==score)throw fail('匹配维度之和与总分不一致。');
  }
  const strings=rows=>arr(rows).filter(value=>typeof value==='string').slice(0,15).map(value=>safe(value,2000)).filter(Boolean);
  const recommendation=['review_profile','clarify','needs_requirement','insufficient'].includes(raw.recommendation)?raw.recommendation:score===null?'insufficient':'clarify';
  return {title:safe(raw.title||'搜索推荐人选岗位匹配',200),summary:safe(raw.summary,4000),score,band:score===null?'insufficient':score>=rules.thresholds.high?'high':score>=rules.thresholds.normal?'normal':'low',dimensions,reasons:strings(raw.reasons),evidence:evidence(raw.evidence),gaps:strings(raw.gaps),recommendation,status:'draft'};
}
export function createSourcingMatchRecord(state,options,raw,{generator='codex',model,usage}={}){
  if(!['codex','model','agent'].includes(generator))throw fail('匹配分析来源必须明确标为Codex辅助、模型API或智能体。');
  const input=buildSourcingMatchInput(state,options),prompt=promptFor(state),result=normalizeSourcingMatch(raw,input),analysisKey=sourcingMatchAnalysisKey(state,options);
  return {...result,id:uid('analysis'),scene:'sourcing_match',generator,...(model?{model}:{}),...(usage?{usage}:{}),sourceId:input.sourceId,candidateId:input.candidateId,requirementId:input.job.requirementId,sourceAccountKey:input.identity.sourceAccountKey,externalId:input.identity.externalId,createdAt:now(),promptId:prompt.id,promptVersion:prompt.version,evaluationRules:structuredClone(input.evaluationRules),requirementVersion:input.job.version,analysisKey,sourceFingerprint:analysisKey,coverage:input.coverage,sourceSnapshot:{policyVersion:SOURCING_MATCH_VERSION,sourceId:input.sourceId,identity:input.identity,requirementId:input.job.requirementId,profile:input.career,evaluationRules:structuredClone(input.evaluationRules),coverage:input.coverage},limitations:['匹配分仅帮助安排职业资料复核，入池与后续招聘决定由HR操作。','当前只有搜索/推荐摘要，未分析聊天、附件或完整简历。']};
}
function reboundReview(row,input){
  const rebind=references=>arr(references).map(reference=>{
    const field=reference?.path?.split('.').at(-1),quote=typeof reference?.quote==='string'?reference.quote.trim():'';
    const exact=input.sourceEvidence.find(item=>item.source===reference.source&&item.path===reference.path&&quote&&item.quote.includes(quote));
    const current=exact||input.sourceEvidence.find(item=>item.source===reference.source&&item.path.split('.').at(-1)===field&&quote&&item.quote.includes(quote));
    if(!current)throw fail('旧引用已不在当前搜索材料中，不能复用。');
    return {...current,quote};
  });
  return normalizeSourcingMatch({...row,evidence:rebind(row.evidence),dimensions:arr(row.dimensions).map(dimension=>({...dimension,evidence:rebind(dimension.evidence)}))},input);
}
export function findReusableSourcingMatch(state,options={}, {generator}={}){
  const key=sourcingMatchAnalysisKey(state,options),input=buildSourcingMatchInput(state,options),allowed=generator?[generator]:['codex','model','agent'];
  for(const row of arr(state.analyses)){
    if(row.scene!=='sourcing_match'||!allowed.includes(row.generator)||row.sourceId!==input.sourceId||row.candidateId!==input.candidateId||row.requirementId!==input.job.requirementId||row.sourceAccountKey!==input.identity.sourceAccountKey||row.externalId!==input.identity.externalId||row.analysisKey!==key)continue;
    try{return {...structuredClone(row),...reboundReview(row,input),reused:true,stale:false,message:'所选岗位、职业摘要与模板未变化，已复用并对应当前引文，本次未调用API。'};}catch{}
  }
  return null;
}
export function saveSourcingMatch(state,row){
  const input=buildSourcingMatchInput(state,{sourceId:row.sourceId,requirementId:row.requirementId});
  if(row.candidateId!==input.candidateId||row.sourceAccountKey!==input.identity.sourceAccountKey||row.externalId!==input.identity.externalId)throw fail('分析记录与搜索来源身份不一致。','identity_mismatch');
  state.analyses??=[];
  const existing=state.analyses.find(item=>item.scene==='sourcing_match'&&item.sourceId===row.sourceId&&item.requirementId===row.requirementId&&item.analysisKey===row.analysisKey&&item.generator===row.generator);
  if(existing&&!row.forced){
    const stale=existing.analysisKey!==sourcingMatchAnalysisKey(state,{sourceId:row.sourceId,requirementId:row.requirementId});
    if(row.reused&&!stale){const checked=reboundReview(row,input);Object.assign(existing,{evidence:checked.evidence,dimensions:checked.dimensions,reused:true});existing.sourceSnapshot={...existing.sourceSnapshot,profile:structuredClone(input.career),coverage:structuredClone(input.coverage)};}
    const current={...existing,stale};return row.reused?{...current,reused:true,message:row.message}:current;
  }
  const saved={...structuredClone(row),stale:row.analysisKey!==sourcingMatchAnalysisKey(state,{sourceId:row.sourceId,requirementId:row.requirementId})};state.analyses.unshift(saved);return saved;
}
export async function analyzeSourcingMatch(state,options={}, {generator='model',secrets,fetchImpl,lookupImpl,force=false,agentRunner=runInterviewAgent}={}){
  if(!['model','agent','auto','rules'].includes(generator))throw fail('请选择模型API、智能体或当前系统配置的分析方式。');
  if(!force){const cached=findReusableSourcingMatch(state,options);if(cached)return cached;}
  const input=buildSourcingMatchInput(state,options);
  const prompt=promptFor(state),modelInput={scene:input.scene,policyVersion:input.policyVersion,job:input.job,career:input.career,sourceEvidence:input.sourceEvidence,coverage:input.coverage,evaluationRules:input.evaluationRules,scoreEligible:input.scoreEligible};
  const selectedGenerator=['rules','auto'].includes(generator)?state.settings?.interviewCopilot?.mode==='api'?'model':'agent':generator;
  if(selectedGenerator==='agent'){
    const technical=promptTechnicalContract(prompt.scene),compiled=compilePrompt(prompt,modelInput),provider=state.settings?.interviewCopilot?.agentProvider||'codex';
    const response=await agentRunner({input:modelInput,prompt:{systemPrompt:compiled.systemPrompt,userPrompt:technical.userPrompt.replace('{{input}}','见本轮唯一结构化JSON材料')},schema:technical.outputSchema,provider});
    return {...createSourcingMatchRecord(state,options,response.output??response,{generator:'agent',model:response.model||response.provider||provider,usage:response.usage}),forced:force===true};
  }
  const settings=state.settings?.model||{};
  if(!settings.baseUrl||!settings.model)throw Object.assign(fail('请在系统配置中接入模型API，或选择智能体分析；分析不会回退到固定规则。','model_not_configured'),{status:'awaiting_model'});
  if(!secrets?.getModelKey)throw fail('模型密钥服务不可用。','model_secret_unavailable');
  const apiKey=await secrets.getModelKey(settings.baseUrl);
  const response=await callModel({settings,apiKey,...compilePrompt(prompt,modelInput),fetchImpl,lookupImpl});
  let raw;try{raw=JSON.parse(response.content);}catch{throw fail('模型没有返回有效JSON，未保存匹配分。');}
  return {...createSourcingMatchRecord(state,options,raw,{generator:'model',model:response.model,usage:response.usage}),forced:force===true};
}
