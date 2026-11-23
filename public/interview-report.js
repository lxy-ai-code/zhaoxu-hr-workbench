const DIMENSIONS=[
  {key:'answer_quality',label:'回答与解决问题质量',weight:40},
  {key:'role_fit',label:'岗位经验适配',weight:40},
  {key:'intent_alignment',label:'求职意愿与安排匹配',weight:20},
];
const array=value=>Array.isArray(value)?value:[];
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const round=value=>Math.round((value+Number.EPSILON)*100)/100;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function reportScoringRules(report) {
  if(!report||!Object.hasOwn(report,'evaluationRules'))return DIMENSIONS.map(row=>({...row}));
  const rules=report.evaluationRules;
  if(!object(rules)||Object.keys(rules).some(key=>key!=='dimensions')||!Array.isArray(rules.dimensions)||rules.dimensions.length!==DIMENSIONS.length)return null;
  const seen=new Set();
  for(const row of rules.dimensions){
    if(!object(row)||Object.keys(row).some(key=>!['key','label','weight'].includes(key))||!DIMENSIONS.some(item=>item.key===row.key)||seen.has(row.key)||typeof row.label!=='string'||!row.label.trim()||row.label.trim().length>60||/[<>\p{Cc}]/u.test(row.label)||!Number.isInteger(row.weight)||row.weight<1||row.weight>100)return null;
    seen.add(row.key);
  }
  if(rules.dimensions.reduce((sum,row)=>sum+row.weight,0)!==100)return null;
  return DIMENSIONS.map(fixed=>{const row=rules.dimensions.find(item=>item.key===fixed.key);return {key:row.key,label:row.label.trim(),weight:row.weight};});
}
export function interviewReportView(interview={}) {
  const report=interview.interviewReport||null,task=interview.interviewReportTask||{};
  const scoring=reportScoringRules(report),rulesValid=Boolean(scoring),definitions=scoring||DIMENSIONS.map(({key,label})=>({key,label,weight:null}));
  const rawDimensions=array(report?.dimensions),rowsValid=rawDimensions.length===DIMENSIONS.length&&new Set(rawDimensions.map(row=>row?.key)).size===DIMENSIONS.length&&rawDimensions.every(row=>object(row)&&DIMENSIONS.some(item=>item.key===row.key));
  const inconsistentWeights=rawDimensions.some(row=>row?.weight!==undefined&&row.weight!==definitions.find(item=>item.key===row?.key)?.weight);
  const dimensions=definitions.map(definition=>{const row=rawDimensions.find(item=>item?.key===definition.key)||{},score=rulesValid&&rowsValid&&!inconsistentWeights&&numeric(row.score)&&row.score>=0&&row.score<=100?row.score:null;return {...row,...definition,score,weightedScore:score===null?null:round(score*definition.weight/100)};});
  const fullyScored=Boolean(report)&&rulesValid&&dimensions.every(row=>row.score!==null);
  const totalScore=fullyScored?round(dimensions.reduce((sum,row)=>sum+row.weightedScore,0)):null;
  const scoredWeight=report&&rulesValid?dimensions.filter(row=>row.score!==null).reduce((sum,row)=>sum+row.weight,0):0;
  const labels={waiting:'等待会后材料',analyzing:'正在生成会后分析',completed:'会后分析已生成',blocked:'会后分析待处理',retrying:'会后分析暂未完成'};
  const scoringError=report&&!rulesValid?'报告保存的评分设置无效，已暂停展示分数；请核对生成时的模板版本。':report&&(!rowsValid||inconsistentWeights)?'报告维度与保存的评分设置不一致，已暂停展示分数；请核对原报告。':'';
  return {report,task,dimensions,totalScore,scoredWeight,earnedWeightedScore:scoredWeight?round(dimensions.reduce((sum,row)=>sum+(row.weightedScore??0),0)):null,rulesValid,scoringError,status:task.status||'waiting',label:labels[task.status]||'等待会后材料',error:typeof task.lastError==='string'?task.lastError:task.lastError?.message||'',history:array(interview.interviewReportHistory)};
}

export function createInterviewReportFeatures(ctx,{reopen}={}) {
  const {state,api,run,notify,loadWorkspace,escape:esc,badge,btn,icon,dateLabel}=ctx;
  const sourceName={codex:'Codex 分析',api:'模型 API 分析',evidence_check:'资料完整性检查'};
  const format=value=>Number.isInteger(value)?String(value):String(Math.round(value*100)/100);
  function discussionHtml(report) {
    const discussion=report?.discussion||{},topics=array(discussion.topics),openQuestions=array(discussion.openQuestions),nextRound=array(discussion.nextRoundFocus);
    const evidence=rows=>array(rows).length?`<details class="report-evidence"><summary>查看相关原话 ${icon('down')}</summary>${array(rows).map(row=>`<blockquote>${esc(row.quote||'')}<small>${esc(row.segmentId||'来源片段')}</small></blockquote>`).join('')}</details>`:'';
    if(!topics.length&&!openQuestions.length&&!nextRound.length)return '';
    return `<div class="report-discussion">${topics.length?`<section class="report-discussion-topics"><header><h4>本场聊了什么</h4><span>${topics.length} 个话题</span></header><div>${topics.map(topic=>`<article><h5>${esc(topic.title||'本场话题')}</h5><p>${esc(topic.summary||'')}</p>${evidence(topic.evidence)}</article>`).join('')}</div></section>`:''}${openQuestions.length?`<section class="report-open-questions"><header><h4>没谈清的事</h4></header>${openQuestions.map(item=>`<article><h5>${esc(item.question||'')}</h5>${item.reason?`<p>${esc(item.reason)}</p>`:''}${evidence(item.evidence)}</article>`).join('')}</section>`:''}${nextRound.length?`<section class="report-next-round"><header><h4>下一轮接着问</h4><span>给下一位面试官的交接</span></header>${nextRound.map((item,index)=>`<article><small>重点 ${index+1}</small><h5 class="spoken-question-text">${esc(item.question||'')}</h5>${item.purpose?`<p>${esc(item.purpose)}</p>`:''}${evidence(item.evidence)}</article>`).join('')}</section>`:''}</div>`;
  }
  function resultHtml(interview,{history=false}={}) {
    const view=interviewReportView(interview),report=view.report;
    if(!report)return '<div class="report-empty"><strong>尚未生成本场会后分析</strong><p>会议结束后，结合岗位、附件资料与明确归属的候选人发言生成报告。材料不足时保留未知。</p></div>';
    const source=report.sourceCoverage||{},included=source.includedSegments??source.segmentCount,kinds={live_meeting:'飞书会中记录',manual_transcript:'已保存逐字稿',minutes:'飞书妙记',note:'飞书会议纪要',document:'会议结果文档'},sourceParts=[kinds[source.kind]||source.kind||source.sourceKind,Number.isInteger(included)?`${included} 段记录`:null,Number.isInteger(source.candidateSegments)?`${source.candidateSegments} 段明确候选人发言`:null,source.truncated?'只覆盖本次已取得范围':null].filter(Boolean);
    return `<article class="interview-report-result"><header><div><h3>${esc(report.title||'会后三维分析')}</h3><p>${esc(sourceName[report.generator]||'面试分析草稿')} · ${esc(dateLabel(report.createdAt)||'')} · 供人工复核</p></div>${badge(report.status==='insufficient_evidence'?'资料不足，暂不完整评分':'分析草稿',report.status==='insufficient_evidence'?'orange':'gray')}</header><div class="interview-report-total"><div><span>加权总分</span><strong>${view.totalScore===null?'暂不评分':format(view.totalScore)}${view.totalScore===null?'':'<small> / 100</small>'}</strong></div><p>${esc(view.scoringError||(view.totalScore===null?`已取得评分依据的维度覆盖 ${view.scoredWeight}% 权重；缺项不按零分计，不折算成完整总分。`:view.dimensions.map(d=>`${d.label} ${d.weight}%`).join(' ＋ ')))}</p></div>${report.summary?`<p class="interview-report-summary">${esc(report.summary)}</p>`:''}${discussionHtml(report)}<div class="interview-report-dimensions">${view.dimensions.map(d=>`<section class="interview-report-dimension"><div class="report-dimension-heading"><span>${d.weight===null?'权重待核对':`${d.weight}% 权重`}</span><strong>${d.score===null?'暂无依据':`${format(d.score)} / 100`}</strong></div><h4>${esc(d.label)}</h4><div class="report-weighted">加权贡献 <b>${d.weightedScore===null?'—':`${format(d.weightedScore)} / ${d.weight}`}</b></div><p class="report-dimension-reason">${esc(d.reason||'目前缺少可归属、可引用的评分依据。')}</p>${array(d.evidence).length?`<details class="report-evidence"><summary>原话依据 ${array(d.evidence).length} 条 ${icon('down')}</summary>${array(d.evidence).map(e=>`<blockquote>${esc(e.quote||'')}<small>${esc(e.segmentId||'来源片段')}</small></blockquote>`).join('')}</details>`:''}${array(d.gaps).length?`<div class="report-dimension-gaps"><span>仍需核对</span><ul>${array(d.gaps).map(gap=>`<li>${esc(gap)}</li>`).join('')}</ul></div>`:''}</section>`).join('')}</div>${array(report.followUps).length?`<section class="report-follow-ups"><h4>建议补充核对</h4><ul>${array(report.followUps).map(item=>`<li>${esc(item)}</li>`).join('')}</ul></section>`:''}${array(report.limitations).length||sourceParts.length?`<details class="report-boundaries"><summary>资料范围与说明 ${icon('down')}</summary>${sourceParts.length?`<p>${sourceParts.map(esc).join(' · ')}</p>`:''}${array(report.limitations).map(item=>`<p>${esc(item)}</p>`).join('')}</details>`:''}${!history?'<footer>评分仅说明本场已取得的岗位相关证据，不代表智力、人格或长期稳定性的判断，不自动产生录用决定。</footer>':''}</article>`;
  }
  function renderPanel(interview) {
    const view=interviewReportView(interview),settings=state.data?.settings?.interviewCopilot||{},mode=settings.mode==='api'?'模型 API':'Codex 智能体';
    return `<section class="interview-report-panel" aria-label="会后三维分析"><header class="interview-report-toolbar"><div><h3>会后分析</h3><p>基于本场记录与岗位资料，按本次分析模板的评分设置展示理由和原话依据；历史报告沿用生成时的设置。</p></div><div class="inline-actions">${badge(mode,'gray')}${btn('adv-generate-report',view.report?'检查更新并分析':'生成会后分析','spark','primary small',`data-id="${esc(interview.id)}" ${view.status==='analyzing'?'disabled':''}`)}${btn('priority-open-template','分析模板','spark','small',`data-scene="interview_report"`)}</div></header>${view.status==='analyzing'||view.error?`<p class="report-runtime ${view.error?'error':''}">${esc(view.error||view.label)}</p>`:''}${view.task.lastReason?`<p class="report-runtime">${esc(view.task.lastReason)}</p>`:''}${resultHtml(interview)}${view.history.length?`<details class="report-history"><summary>历史会后分析 ${view.history.length} 版 ${icon('down')}</summary>${[...view.history].reverse().map((report,index)=>`<details><summary>${esc(report.title||`历史版本 ${view.history.length-index}`)} · ${esc(dateLabel(report.createdAt)||'')}</summary>${resultHtml({interviewReport:report},{history:true})}</details>`).join('')}</details>`:''}</section>`;
  }
  function renderSettings() {
    const settings={enabled:false,delaySeconds:90,...state.data?.settings?.interviewReport},runtime=state.data?.interviewReportStatus||{};
    const saved=runtime.settings||settings;
    return `<section class="panel interview-report-settings" id="interview-report-settings"><div class="panel-header"><div><h2 class="panel-title">会后自动分析</h2><p class="panel-subtitle">会议结束并积累结果后，沿用上方选定的智能体 / API 模式；相同材料复用报告。</p></div>${badge(saved.enabled?'已启用':'已暂停',saved.enabled?'green':'gray')}</div><div class="panel-body"><form id="adv-report-settings-form"><div class="form-grid"><div class="field full"><label class="copilot-enable-field"><input type="checkbox" name="enabled" value="true" ${saved.enabled?'checked':''}>会议结束后自动生成分析报告</label></div><div class="field"><label for="report-delay">会后等待时间（秒）</label><input id="report-delay" class="control" name="delaySeconds" type="number" min="30" max="3600" required value="${esc(saved.delaySeconds??90)}"><small>等待会议结果落地后再分析，可调整为 30–3600 秒。</small></div></div><button class="btn small primary" type="submit">${icon('check')}保存会后分析配置</button></form></div></section>`;
  }
  function handleAction(button) {
    if(button.dataset.action!=='adv-generate-report')return false;
    const interviewId=button.dataset.id;
    run(button,async()=>{const result=await api(`/api/interviews/${encodeURIComponent(interviewId)}/report`,'POST',{});await loadWorkspace();reopen?.(interviewId,'verify');notify(result.reused?'资料没有变化，已复用本场会后分析。':'会后分析已生成，请核对评分依据。');});return true;
  }
  function handleSubmit(event) {
    const form=event.target;if(form.id!=='adv-report-settings-form')return false;
    event.preventDefault();if(!form.reportValidity())return true;
    const values=Object.fromEntries(new FormData(form));
    run(event.submitter||form.querySelector('button[type=submit]'),async()=>{await api('/api/interview-report/settings','PATCH',{enabled:values.enabled==='true',delaySeconds:Number(values.delaySeconds)});await loadWorkspace();ctx.render?.();notify('会后分析配置已保存。');});return true;
  }
  return {renderPanel,renderSettings,handleAction,handleSubmit};
}
