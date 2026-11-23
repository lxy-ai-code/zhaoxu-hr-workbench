const list=value=>Array.isArray(value)?value:[];
const scoreLabels={sourcing_match:'岗位匹配',conversation_priority:'回复优先级',resume_screen:'简历匹配',interview_report:'面试评分'};
const validScore=score=>typeof score?.score==='number'&&Number.isFinite(score.score)&&score.score>=0&&score.score<=100;
const matchingRows=rows=>list(rows).map(row=>typeof row==='string'?{text:row}:row).filter(row=>typeof row?.text==='string'&&row.text.trim()).slice(0,3);
const matchingList=(rows,esc)=>`<ul class="preparation-match-reasons">${rows.map(row=>`<li>${esc(row.text)}</li>`).join('')}</ul>`;
const rawString=value=>typeof value==='string'&&value.trim()?value:'';
function candidateProfileMarkup(profile,briefText,esc) {
  if(!profile||typeof profile!=='object'||Array.isArray(profile))return '';
  const works=list(profile.workHistory).map(row=>typeof row==='string'?{description:row}:row),education=list(profile.education).map(row=>typeof row==='string'?{description:row}:row),introduction=rawString(profile.introduction);
  const descriptionMarkup=(value,label='工作内容')=>{
    const description=rawString(value);
    if(!description)return '';
    const body=`<p class="candidate-profile-description">${esc(description)}</p>`;
    return description.length>240?`<details class="candidate-profile-long-description"><summary>${label} · 展开查看</summary>${body}</details>`:body;
  };
  const workMarkup=works.length?`<ol class="candidate-profile-timeline">${works.map(work=>`<li><span class="candidate-profile-period">${esc(rawString(work?.dateRange)||'—')}</span><div class="candidate-profile-record-heading"><strong>${esc(rawString(work?.company)||'—')}</strong><span>${esc(rawString(work?.position)||'—')}</span></div>${descriptionMarkup(work?.description)}</li>`).join('')}</ol>`:'<p class="candidate-profile-empty">—</p>';
  const educationMarkup=education.length?`<ol class="candidate-profile-timeline">${education.map(item=>`<li><span class="candidate-profile-period">${esc(rawString(item?.dateRange)||'—')}</span><div class="candidate-profile-record-heading"><strong>${esc(rawString(item?.school)||'—')}</strong></div><p class="candidate-profile-education-detail">${esc([rawString(item?.major),rawString(item?.degree)].filter(Boolean).join(' · ')||'—')}</p>${descriptionMarkup(item?.description,'补充说明')}</li>`).join('')}</ol>`:'<p class="candidate-profile-empty">—</p>';
  const original=introduction&&introduction.trim()!==rawString(briefText).trim()?rawString(briefText)?`<details class="candidate-profile-original"><summary>职业摘要原文</summary><div>${esc(introduction)}</div></details>`:`<div class="candidate-profile-original-text"><h5>职业摘要</h5><p>${esc(introduction)}</p></div>`:'';
  return `<section class="candidate-profile" aria-label="职业资料"><h4>职业资料</h4><dl class="candidate-profile-facts"><div><dt>城市</dt><dd>${esc(rawString(profile.city)||'—')}</dd></div></dl><div class="candidate-profile-columns"><section class="candidate-profile-work"><h5>工作经历</h5>${workMarkup}</section><section class="candidate-profile-education"><h5>教育经历</h5>${educationMarkup}</section></div>${original}</section>`;
}
export function renderCandidateCareerProfile(profile,{escape:esc,briefText=''}={}) {
  return candidateProfileMarkup(profile,briefText,esc);
}
export function sourceMaterialLabel(ref={}) {
  const source=String(ref.source||'');
  if(source==='resume'||/^resumes\[/.test(ref.path||''))return ref.name?`附件简历 · ${ref.name}`:'附件简历';
  if(source==='requirement'||/^requirement\.|^job\./.test(ref.path||''))return '本岗位职责与标准';
  if(source==='professionalKnowledge'||/^professionalKnowledge\[/.test(ref.path||''))return ref.title?`专业参考资料 · ${ref.title}`:'专业参考资料';
  if(['candidate','profile'].includes(source)||/^candidate\.|^career\./.test(ref.path||''))return '候选人职业资料';
  if(source==='transcript')return '本场会议原话';
  return ref.sourceLabel||'本次提供资料';
}
export function renderInterviewQuestion(question,index,{escape:esc,badge=label=>label}={}) {
  const q=typeof question==='string'?{question}:question||{},professional=q.type==='professional';
  const sources=list(q.evidence).filter(ref=>typeof ref.quote==='string'&&ref.quote.trim());
  const answer=q.referenceAnswer&&typeof q.referenceAnswer==='object'?q.referenceAnswer:{};
  const answerPoints=list(answer.keyPoints).filter(value=>typeof value==='string'&&value.trim());
  const referenceSources=list(answer.sourceRefs).filter(ref=>typeof ref.quote==='string'&&ref.quote.trim());
  const hasAnswer=Boolean(answer.text||answerPoints.length||professional);
  return `<article class="question spoken-question"><div class="question-top"><span class="question-number">QUESTION ${String(index+1).padStart(2,'0')}</span>${badge(professional?'专业知识题':'经历核验题',professional?'blue':'green')}${q.topic?`<span class="question-topic">${esc(q.topic)}</span>`:''}</div><h4 class="spoken-question-text">${esc(q.question||q.text||'')}</h4>${sources.length?`<details class="question-source"><summary>提问来源 · ${sources.length} 处原文</summary>${sources.map(ref=>`<blockquote><strong>${esc(sourceMaterialLabel(ref))}</strong><p>${esc(ref.quote)}</p></blockquote>`).join('')}</details>`:'<p class="question-source-note">依据岗位设计的面试问题，未引用候选人经历。</p>'}${hasAnswer||q.purpose?`<details class="question-reference"><summary>面试官参考答案与考察点 ${professional?badge(answer.verificationStatus==='verified'?'已核对参考资料':'答案待核验',answer.verificationStatus==='verified'?'green':'gray'):''}</summary>${q.purpose?`<p class="question-purpose"><b>考察点</b> ${esc(q.purpose)}</p>`:''}${answer.text?`<p>${esc(answer.text)}</p>`:''}${answerPoints.length?`<ul>${answerPoints.map(point=>`<li>${esc(point)}</li>`).join('')}</ul>`:''}${professional&&!answer.text&&!answerPoints.length?'<p>参考答案尚待补充核验，暂不作为标准答案使用。</p>':''}${referenceSources.map(ref=>`<blockquote><strong>${esc(sourceMaterialLabel(ref))}</strong><p>${esc(ref.quote)}</p></blockquote>`).join('')}</details>`:''}</article>`;
}
export function renderCandidateBrief(content={},ctx={}) {
  const {escape:esc}=ctx,brief=content.candidateBrief;
  const text=typeof brief==='string'?brief:brief?.text;
  const matches=ctx.hideFitReasons||validScore(content.scoreSummary)?[]:matchingRows(brief?.fitReasons);
  const basics=content.candidateBasics&&typeof content.candidateBasics==='object'&&!Array.isArray(content.candidateBasics)?content.candidateBasics:null;
  const profile=content.candidateProfile&&typeof content.candidateProfile==='object'&&!Array.isArray(content.candidateProfile)?content.candidateProfile:null;
  if(!text&&!matches.length&&!content.expectedSalary&&!basics&&!profile)return '';
  const raw=key=>typeof basics?.[key]==='string'&&basics[key].trim()?basics[key]:'';
  const fields=[['年龄','age'],['学历','degree'],['工作经验','experience'],['期望薪资','expectedSalary'],['目标岗位','targetPosition']];
  if(basics&&raw('interviewPosition')&&raw('interviewPosition').trim()!==raw('targetPosition').trim())fields.push(['本场岗位','interviewPosition']);
  const hasRecentWork=basics&&['recentCompany','recentPosition','recentPeriod'].some(key=>Object.hasOwn(basics,key));
  const recentWork=[raw('recentCompany'),raw('recentPosition')].filter(Boolean).join(' · ');
  const recentHtml=hasRecentWork?`<div class="candidate-basic candidate-basic-recent"><dt>最近工作</dt><dd><span>${esc(recentWork||'—')}</span>${raw('recentPeriod')?`<small>${esc(raw('recentPeriod'))}</small>`:''}</dd></div>`:'';
  const basicsHtml=basics?`<dl class="candidate-basics">${fields.map(([label,key])=>`<div class="candidate-basic"><dt>${label}</dt><dd>${esc(raw(key)||'—')}</dd></div>`).join('')}${recentHtml}</dl>`:'';
  const heading=text||basics||profile?`<header class="candidate-brief-heading"><h3>面试人简介</h3>${raw('name')?`<strong class="candidate-basics-name">${esc(raw('name'))}</strong>`:''}</header>`:'';
  return `<section class="doc-section candidate-brief">${heading}${basicsHtml}${text?`<div class="candidate-brief-text">${esc(text)}</div>`:''}${list(brief?.highlights).length?`<ul class="candidate-brief-highlights">${brief.highlights.map(item=>`<li>${esc(item.text||'')}</li>`).join('')}</ul>`:''}${!basics&&content.expectedSalary?`<p class="candidate-salary"><span>期望薪资</span><strong>${esc(content.expectedSalary)}</strong></p>`:''}${candidateProfileMarkup(profile,text,esc)}${matches.length?`<div class="candidate-fit-reasons"><h4>匹配点</h4>${matchingList(matches,esc)}</div>`:''}</section>`;
}
export function renderPreparationScore(score={},ctx={}) {
  const {escape:esc}=ctx;
  if(!validScore(score))return '';
  const label=scoreLabels[score.kind||score.scene]||score.label||'已有评分',matches=matchingRows(score.matchReasons);
  const sources=matches.flatMap(row=>list(row.evidence)).filter(ref=>typeof ref?.quote==='string'&&ref.quote.trim());
  return `<section class="preparation-score-summary"><header><strong>${esc(label)}</strong><span class="preparation-score-value">${esc(score.score)}<small> / 100</small></span></header>${matches.length?matchingList(matches,esc):''}<details class="preparation-score-record"><summary>评分记录</summary><div>${score.stale?'<p>历史结果 · 标准或资料已更新</p>':''}${score.createdAt?`<p>评分时间：${esc(score.createdAt)}</p>`:''}${score.summary?`<p>${esc(score.summary)}</p>`:''}${list(score.reasons).length?`<ul>${score.reasons.map(row=>`<li>${esc(typeof row==='string'?row:row.text||'')}</li>`).join('')}</ul>`:''}${sources.map(ref=>`<blockquote><strong>${esc(sourceMaterialLabel(ref))}</strong><p>${esc(ref.quote)}</p></blockquote>`).join('')}</div></details></section>`;
}
