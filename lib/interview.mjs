import { digest, now, uid } from './store.mjs';
import { professionalCriteria } from './criteria.mjs';
import { buildCandidateJobContext } from './job-mappings.mjs';
import { RESUME_SOURCE_POLICY_VERSION, isUsableAttachmentResume, excludedOnlineResumeMetadata, isRetiredOnlineResume } from './resume-policy.mjs';
import { defaultPromptFor } from './prompts.mjs';
import { promptFingerprint } from './prompt-governance.mjs';
import { chooseInterviewScoreSummary } from './interview-score-summary.mjs';
import { candidateBasicInfo } from './candidate-basic-info.mjs';
import { candidateCareerProfile } from './candidate-career-profile.mjs';

function excerpt(text, max = 200) { const value = String(text || '').trim(); return value.length > max ? `${value.slice(0, max)}…` : value; }

const list = value => Array.isArray(value) ? value : [];
const preparationFailure = () => Object.assign(new Error('会前分析与当前候选人、岗位、应聘流程或提示词版本不一致，请按当前资料重新生成。'), { code: 'preparation_analysis_mismatch', statusCode: 409 });

export function buildInterviewPack(state, applicationId, options = {}) {
  const application = state.applications.find(row => row.id === applicationId);
  if (!application) throw Object.assign(new Error('应聘流程不存在。'), { statusCode: 404 });
  const candidate = state.candidates.find(row => row.id === application.candidateId);
  const requirement = state.requirements.find(row => row.id === application.requirementId);
  if (!candidate || !requirement) throw new Error('关联的候选人或招聘需求不存在。');
  const safeCriteria = professionalCriteria(requirement.mustHaves);
  const candidateResumes = (state.resumes || []).filter(row => row.candidateId === candidate.id && (!row.applicationId || row.applicationId === applicationId));
  const resumes = candidateResumes.filter(isUsableAttachmentResume);
  const excludedResumes = excludedOnlineResumeMetadata(candidateResumes);
  const jobContext=buildCandidateJobContext(state,candidate,requirement);
  const jobContextKey={...jobContext,communicatingJobs:jobContext.communicatingJobs.map(({capturedAt,...row})=>row)};
  const prompt = list(state.prompts).find(row => row.scene === 'interview_prep') || defaultPromptFor('interview_prep');
  const existingScore = chooseInterviewScoreSummary(state,{candidateId:candidate.id,requirementId:requirement.id,applicationId:application.id});
  const expectedSalary = typeof candidate.salary === 'string' ? candidate.salary.trim() : '';
  const fingerprint = promptFingerprint(prompt);
  const currentAnalysis = row => row?.scene === 'interview_prep' && row.generator !== 'rules'
    && row.applicationId === application.id && row.candidateId === candidate.id && row.requirementId === requirement.id
    && row.requirementVersion === requirement.version && row.promptId === prompt.id && row.promptVersion === prompt.version
    && (row.promptFingerprint || row.sourceSnapshot?.prompt?.fingerprint) === fingerprint
    && !list(row.sourceSnapshot?.resumes).some(isRetiredOnlineResume);
  if (options.analysis && !currentAnalysis(options.analysis)) throw preparationFailure();
  const analysis = options.analysis === undefined
    ? list(state.analyses).filter(currentAnalysis).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0] || null
    : options.analysis;
  const matchReasons = structuredClone(list(analysis?.candidateBrief?.fitReasons));
  const scoreSummary = existingScore ? { ...existingScore, matchReasons, matchReasonsAnalysisId: analysis?.id || null } : null;
  const analysisKey = analysis ? { id: analysis.id, inputFingerprint: analysis.inputFingerprint, promptFingerprint: fingerprint, summary: analysis.summary, candidateBrief: analysis.candidateBrief, dimensions: analysis.dimensions, questions: analysis.questions, coreJudgments: analysis.coreJudgments, agenda: analysis.agenda } : null;
  const key = digest(JSON.stringify({ preparationPolicyVersion: 'prompt_driven_v2', resumeSourcePolicyVersion: RESUME_SOURCE_POLICY_VERSION, applicationId, requirementVersion: requirement.version, candidate: { name: candidate.name, introduction: candidate.introduction, workHistory: candidate.workHistory, degree: candidate.degree, school: candidate.school, salary:expectedSalary }, criteria: requirement.mustHaves, resumes: resumes.map(row => ({ id: row.id, sha256: row.sha256 })),jobContext:jobContextKey, prompt: { id: prompt.id, version: prompt.version, fingerprint, systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, evaluationRules: prompt.evaluationRules }, analysis: analysisKey, scoreSummary }));
  const existing = state.documents.find(row => row.type === 'interview_pack' && row.generationKey === key);
  if (existing) return existing;
  const sourceEvidence = [
    ...(candidate.introduction ? [{ fieldPath: 'candidate.introduction', quote: candidate.introduction, label: '候选人自述' }] : []),
    ...(candidate.workHistory ?? []).map((work, index) => ({ fieldPath: `candidate.workHistory[${index}]`, quote: `${work.company} · ${work.position}`, label: '平台工作经历摘要' })),
    ...resumes.map(row => ({ fieldPath: `resumes[id=${row.id}].text`, quote: excerpt(row.text, 1200), label: '附件简历解析原文节选', resumeId: row.id, sha256: row.sha256, coverage: row.coverage, ocrNeedsReview: row.sourceMeta?.ocrNeedsReview === true, capturedAt: row.capturedAt || row.createdAt })),
    ...jobContext.communicatingJobs.filter(row=>row.jobTitle).map(row=>({fieldPath:`conversations[id=${row.conversationId}].communicatedPosition`,quote:row.jobTitle,label:'BOSS实际沟通岗位',platformJobId:row.platformJobId})),
  ];
  const criteria = list(analysis?.dimensions).map(row => ({ criterion: row.name, finding: row.finding, evidence: list(row.evidence).map(ref => ref.quote).filter(Boolean).join('；'), sourceRefs: structuredClone(list(row.evidence)), sourcePath: row.evidence?.[0]?.path || null, gap: row.action, status: row.status }));
  const questions = structuredClone(list(analysis?.questions));
  const document = {
    id: uid('doc'), type: 'interview_pack', title: `${candidate.name} · ${requirement.title} · 面试一页纸`,
    applicationId, candidateId: candidate.id, requirementId: requirement.id, generationKey: key,
    criteriaVersion: requirement.version, version: state.documents.filter(row => row.applicationId === applicationId && row.type === 'interview_pack').length + 1,
    generator: analysis?.generator || 'materials', analysisId: analysis?.id || null,
    promptId: prompt.id, promptVersion: prompt.version, promptFingerprint: fingerprint,
    preparationStatus: analysis ? 'draft' : 'pending_analysis', createdAt: now(),
    content: {
      summary: analysis?.summary || `${candidate.name}，${candidate.workYear || '经验待补充'}，${candidate.degree || '学历待补充'}。目标岗位：${requirement.title}。${candidate.introduction ? `候选人自述：${excerpt(candidate.introduction, 280)}` : '当前没有自述材料。'}`,
      candidateBrief: analysis?.candidateBrief ? structuredClone(analysis.candidateBrief) : null,
      candidateBasics: candidateBasicInfo(candidate,requirement),
      candidateProfile: candidateCareerProfile(candidate),
      expectedSalary,
      expectedSalaryEvidence: expectedSalary ? {source:'candidate',path:'candidate.salary',quote:expectedSalary,claimType:'platform_career_summary'} : null,
      scoreSummary,
      professionalKnowledge: structuredClone(list(analysis?.sourceSnapshot?.professionalKnowledge)),
      criteria, questions, coreJudgments: structuredClone(list(analysis?.coreJudgments)),
      agenda: structuredClone(list(analysis?.agenda)),
      ...(analysis ? { analysis: structuredClone(analysis) } : {}),
      evidence: sourceEvidence,
      jobContext,
      jobContextNote:jobContext.conflicts.some(row=>!row.confirmed)?'实际沟通岗位与本次评估需求存在未确认差异，请先确认本次岗位与意向。':jobContext.communicatingJobs.length?'实际沟通岗位、候选人期望岗位和内部评估需求分别保留。':'实际沟通岗位尚未取得，不能用期望岗位代替。',
      resumeSourcePolicyVersion: RESUME_SOURCE_POLICY_VERSION, excludedResumes,
      resumeSources: resumes.map(row => ({ id: row.id, name: row.name, kind: row.kind, source: row.source, sha256: row.sha256, coverage: row.coverage, capturedAt: row.capturedAt || row.createdAt })),
      materialNote: resumes.length ? '已列出附件解析原文与职业摘要来源；自述仍待核验。' : '尚无可解析附件简历；当前仅保存岗位标准和职业摘要，不能称为完整履历分析。',
      notes: analysis ? `依据会前准备提示词 v${prompt.version} 的分析草稿整理，问题与判断均保留本次生成结果，供面试官复核。` : `仅整理已保存资料，面试判断、问题和议程待按提示词生成（会前准备 v${prompt.version}）。`,
      requirementSnapshot: { title: requirement.title, jd: requirement.jd, mustHaves: safeCriteria, version: requirement.version },
      sourceCapturedAt: candidate.capturedAt,
    },
  };
  state.documents.unshift(document);
  return document;
}

export function prepareTranscriptReview(document, transcript) {
  const text = String(transcript || '').trim();
  if (!text) throw Object.assign(new Error('请先填写本场访谈记录或逐字稿。'), { statusCode: 400 });
  const reminders = list(document?.content?.questions).map(question => ({
    topic: question.topic, status: 'needs_review',
    evidence: '尚未标注对应原话', question: question.question,
  }));
  return { generator: 'materials', status: 'draft', transcript: text, reminders, note: '已保存人工记录原文；仅沿用已有会前问题供人工标注，尚未按会后提示词分析，也未自动配对问题与发言。' };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function careerProfileHtml(document) {
  const saved=document.content?.candidateProfile;
  if(!document.candidateId||saved?.candidateId!==document.candidateId)return '';
  const p=candidateCareerProfile({id:saved.candidateId,city:saved.city,introduction:saved.introduction,capturedAt:saved.capturedAt,workHistory:saved.workHistory,education:saved.education});
  if(!p.city&&!p.introduction&&!p.workHistory.length&&!p.education.length)return '';
  const work=p.workHistory.map(row=>'<li>'+([row.company,row.position].some(Boolean)?'<strong>'+escapeHtml([row.company,row.position].filter(Boolean).join(' · '))+'</strong>':'')+(row.dateRange?'<div><small>'+escapeHtml(row.dateRange)+'</small></div>':'')+(row.description?'<p class="career-original">'+escapeHtml(row.description)+'</p>':'')+(!Object.values(row).some(Boolean)?'—':'')+'</li>').join('');
  const education=p.education.map(row=>'<li>'+(row.school?'<strong>'+escapeHtml(row.school)+'</strong>':'')+([row.major,row.degree].some(Boolean)?'<div>'+escapeHtml([row.major?'专业 '+row.major:'',row.degree?'学历 '+row.degree:''].filter(Boolean).join(' · '))+'</div>':'')+(row.dateRange?'<div><small>'+escapeHtml(row.dateRange)+'</small></div>':'')+(row.description?'<p class="career-original">'+escapeHtml(row.description)+'</p>':'')+(!Object.values(row).some(Boolean)?'—':'')+'</li>').join('');
  return '<details class="candidate-career-profile"><summary>完整候选人资料</summary>'+(p.city?'<p><strong>城市：</strong>'+escapeHtml(p.city)+'</p>':'')+(p.introduction?'<h3>职业摘要</h3><p class="career-original">'+escapeHtml(p.introduction)+'</p>':'')+(work?'<h3>工作经历</h3><ol>'+work+'</ol>':'')+(education?'<h3>教育经历</h3><ol>'+education+'</ol>':'')+(p.capturedAt?'<small>资料更新时间：'+escapeHtml(p.capturedAt)+'</small>':'')+'</details>';
}
export function renderDocumentHtml(document) {
  const c = document.content || {};
  const label = document.generator === 'materials' || document.preparationStatus === 'pending_analysis' ? '资料汇总 · 待按提示词分析' : document.generator === 'template' ? '历史规则草稿' : '提示词分析草稿';
  const agendaText = row => typeof row === 'string' ? row : [row?.duration || row?.time, row?.title || row?.topic || row?.content].filter(Boolean).join('：');
  const sourceLabel = ref => ({candidate:'BOSS职业资料',resume:'附件简历',message:'聊天原话',requirement:'岗位要求',knowledge:'专业参考资料'}[ref?.source] || ref?.label || '资料来源');
  const citations = refs => list(refs).map(ref => '<blockquote>'+escapeHtml(ref.quote)+'<br><small>'+escapeHtml(sourceLabel(ref)+' · '+(ref.title || ref.path || ref.fieldPath || '本场已提供资料'))+'</small></blockquote>').join('');
  const brief = c.candidateBrief && typeof c.candidateBrief === 'object' ? c.candidateBrief : null;
  const score = c.scoreSummary && Number.isFinite(c.scoreSummary.score) ? c.scoreSummary : null;
  const basics = c.candidateBasics && typeof c.candidateBasics === 'object' ? candidateBasicInfo({name:c.candidateBasics.name,age:c.candidateBasics.age,degree:c.candidateBasics.degree,workYear:c.candidateBasics.experience,salary:c.candidateBasics.expectedSalary,position:c.candidateBasics.targetPosition,workHistory:[{company:c.candidateBasics.recentCompany,position:c.candidateBasics.recentPosition,dateRange:c.candidateBasics.recentPeriod}]},{title:c.candidateBasics.interviewPosition}) : null;
  const basicRows=basics?[['姓名',basics.name],['年龄',basics.age],['学历',basics.degree],['工作经验',basics.experience],['期望薪资',basics.expectedSalary],['目标岗位',basics.targetPosition],...(basics.interviewPosition&&basics.interviewPosition!==basics.targetPosition?[['本场岗位',basics.interviewPosition]]:[]),['最近工作',[basics.recentCompany,basics.recentPosition,basics.recentPeriod].filter(Boolean).join(' · ')]]:[];
  const basicsBlock=basicRows.length?'<dl class="candidate-basic-info">'+basicRows.map(([label,value])=>'<div><dt>'+label+'</dt><dd>'+escapeHtml(value||'—')+'</dd></div>').join('')+'</dl>':'';
  const currentBrief=brief&&Object.hasOwn(brief,'text')?typeof brief.text==='string'?brief.text:'':c.summary||'尚无可用职业简介。';
  const profile = '<h2>候选人简介</h2>'+basicsBlock+(currentBrief?'<p>'+escapeHtml(currentBrief)+'</p>':'')+(list(brief?.highlights).length?'<ul>'+list(brief.highlights).map(row=>'<li>'+escapeHtml(row.text)+'</li>').join('')+'</ul>':'')+(!basics?'<p><strong>期望薪资：</strong>'+escapeHtml(c.expectedSalary || '来源未提供')+'</p>':'')+(list(brief?.evidence).length?'<details><summary>简介来源</summary>'+citations(brief.evidence)+'</details>':'');
  const fitReasons = list(score?.matchReasons?.length ? score.matchReasons : brief?.fitReasons).slice(0,3);
  const matching = fitReasons.length ? '<ul>'+fitReasons.map(row=>'<li>'+escapeHtml(typeof row==='string'?row:row.text)+'</li>').join('')+'</ul>' : '';
  const scoreBlock = score ? '<section><h2>'+escapeHtml(score.label || '岗位匹配')+' · '+escapeHtml(score.score)+'/100</h2>'+matching+'<details><summary>评分记录</summary><small>'+escapeHtml(score.stale?'历史记录 · 标准或资料已更新':'已有评分')+'</small><p>'+escapeHtml(score.summary || '')+'</p><ul>'+list(score.reasons).slice(0,2).map(row=>'<li>'+escapeHtml(typeof row==='string'?row:row.text||'')+'</li>').join('')+'</ul>'+fitReasons.map(row=>citations(row.evidence)).join('')+'</details></section>' : matching ? '<section><h2>匹配点</h2>'+matching+'</section>' : '';
  const questions = list(c.questions).map((row,index)=>{
    const answer=row.referenceAnswer,answerVisible=answer&&(answer.text||list(answer.keyPoints).length),status={verified:'已引用确认的专业资料',needs_verification:'参考答案待业务核对',not_applicable:'开放案例，无唯一标准答案'}[answer?.verificationStatus]||'参考答案待核对';
    return '<section class="question"><small>QUESTION '+String(index+1).padStart(2,'0')+' · '+escapeHtml(row.type==='professional'?'专业知识题':row.type==='experience'?'经历 / 项目题':'面试题')+'</small><h3>'+escapeHtml(typeof row==='string'?row:row.question)+'</h3>'+(row.purpose?'<p class="muted">考察点：'+escapeHtml(row.purpose)+'</p>':'')+(list(row.evidence).length?'<details><summary>题目来源</summary>'+citations(row.evidence)+'</details>':'')+(answerVisible?'<details><summary>面试官参考答案 · '+escapeHtml(status)+'</summary><p>'+escapeHtml(answer.text)+'</p><ul>'+list(answer.keyPoints).map(point=>'<li>'+escapeHtml(point)+'</li>').join('')+'</ul>'+citations(answer.sourceRefs)+'</details>':'')+'</section>';
  }).join('');
  const jobContextBlock=c.jobContext?'<p>本场评估需求：'+escapeHtml(c.jobContext.applicationRequirement?.title||'待确认')+'</p><p>实际沟通岗位：'+escapeHtml(list(c.jobContext.communicatingJobs).map(row=>row.jobTitle||'岗位未知').join('；')||'尚未取得')+'</p><small>'+escapeHtml(c.jobContextNote)+'</small>':'';
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+escapeHtml(document.title)+'</title><style>body{font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif;color:#25344a;max-width:900px;margin:48px auto;padding:0 24px}h1{font-size:28px}h2{margin-top:30px;font-size:20px}h3{font-size:17px;line-height:1.9}section{border-top:1px solid #ddd;padding:16px 0}small,.muted{color:#64748b}blockquote{background:#f4f7f7;margin:12px 0;padding:12px 18px}li{margin:8px 0}details{margin:14px 0}summary{cursor:pointer;color:#42745d;font-size:14px}.question h3{margin:8px 0 14px}.career-original{white-space:pre-wrap;overflow-wrap:anywhere}.candidate-career-profile{padding:15px;border:1px solid #dfe7df;border-radius:8px}.candidate-career-profile h3{margin-top:20px}.candidate-basic-info{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 20px;padding:16px;background:#f4f8f5;border-radius:8px}.candidate-basic-info dt{font-size:12px;color:#7b8d81}.candidate-basic-info dd{margin:2px 0 0;font-size:14px;overflow-wrap:anywhere}@media(max-width:600px){.candidate-basic-info{grid-template-columns:repeat(2,minmax(0,1fr))}}@media print{body{margin:0;max-width:none}details{display:block}}</style><h1>'+escapeHtml(document.title)+'</h1><small>招序 HR · '+escapeHtml(document.createdAt)+'</small>'+profile+scoreBlock+careerProfileHtml(document)+'<h2>面试问题</h2>'+questions+(list(c.agenda).length?'<h2>建议面试议程</h2><ul>'+list(c.agenda).map(row=>'<li>'+escapeHtml(agendaText(row))+'</li>').join('')+'</ul>':'')+'<details><summary>资料说明</summary><p>'+escapeHtml(label)+'</p>'+jobContextBlock+(c.materialNote?'<p>'+escapeHtml(c.materialNote)+'</p>':'')+list(c.criteria).map(row=>'<section><strong>'+escapeHtml(row.criterion)+'</strong><blockquote>'+escapeHtml(row.evidence)+'</blockquote><small>'+escapeHtml(row.gap)+'</small></section>').join('')+citations(c.evidence)+'<p>'+escapeHtml(Array.isArray(c.notes)?c.notes.join('\n'):c.notes||'')+'</p></details></html>';
}
