import { createHash } from 'node:crypto';
import { professionalCriteria, sensitiveCriterion } from './criteria.mjs';
import { defaultPromptFor, ANALYSIS_SAFETY_INSTRUCTIONS } from './prompts.mjs';
import { callModel } from './model-api.mjs';
import { compilePrompt, promptTechnicalContract } from './prompt-governance.mjs';
import { runInterviewAgent } from './interview-agent.mjs';
import { RESUME_SOURCE_POLICY_VERSION, RESUME_SOURCE_POLICY_INSTRUCTIONS, isUsableAttachmentResume, excludedOnlineResumeMetadata, usesRetiredOnlineResume } from './resume-policy.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const issue = (message, code = 'invalid_analysis_input') => Object.assign(new Error(message), { code, statusCode: 400 });
const string = (value, max = 12000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const scenePrompt = scene => defaultPromptFor(scene);
const select = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, structuredClone(object[key])]));
const source = (sourceName, path, quote, claimType) => ({ source: sourceName, path, quote: string(quote, 120000), claimType });
const dimension = (name, status, finding, evidence = [], action = '') => ({ name, status, finding, evidence, action });
export const JOB_CONTEXT_POLICY_VERSION = '1.0';
export const JOB_CONTEXT_POLICY_INSTRUCTIONS = `岗位上下文政策 v${JOB_CONTEXT_POLICY_VERSION}：当前requirement/applicationRequirement是本次内部评估所用的岗位标准，jobContext.communicatingJobs记录BOSS真实沟通岗位及平台岗位标识；candidate.position和在线求职期望只表示候选人期望岗位，不能替代实际沟通岗位，也不能从简历文件名猜测沟通岗位。岗位未知时明确未知，名称相似或不同都不能自行建立平台岗位与内部需求映射。
仅未确认的岗位映射差异需要先中性确认本次沟通/面试针对哪个岗位及候选人意向；一个人可能同时沟通多个岗位，这不构成能力不足、欺骗或负面事实。mappingStatus=manual_override、resolution=keep_manual或confirmed=true的已确认差异保留双方事实，并按明确指定的内部需求评估，不重复要求确认，不自动覆盖平台岗位。不得因沟通岗位与当前评估岗位不同给候选人价值排名、自动拒绝或能力不足结论。`;
const idText = value => typeof value === 'string' ? value.trim().slice(0, 300) : Number.isSafeInteger(value) ? String(value) : '';
function jobFields(row, keys) { return Object.fromEntries(keys.flatMap(key => { if (key === 'confirmed') return typeof row?.[key] === 'boolean' ? [[key, row[key]]] : []; const value = idText(row?.[key]); return value ? [[key, value]] : []; })); }
function normalizeJobContext(value, requirement) {
  const provided = Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const applicationRequirement = { ...jobFields(value?.applicationRequirement, ['id', 'title']), ...(Number.isSafeInteger(value?.applicationRequirement?.version) ? { version: value.applicationRequirement.version } : {}) };
  if (applicationRequirement.id && requirement.id && applicationRequirement.id !== requirement.id) throw issue('岗位上下文的内部需求与当前评估需求不一致。', 'job_context_requirement_mismatch');
  if (!applicationRequirement.id && requirement.id) applicationRequirement.id = requirement.id;
  if (!applicationRequirement.title && requirement.title) applicationRequirement.title = requirement.title;
  if (applicationRequirement.version === undefined && Number.isSafeInteger(requirement.version)) applicationRequirement.version = requirement.version;
  const communicatingJobs = (Array.isArray(value?.communicatingJobs) ? value.communicatingJobs : []).slice(0, 100).map(row => jobFields(row, ['conversationId', 'platformJobId', 'jobTitle', 'bossJobId', 'mappedRequirementId', 'mappingStatus', 'sourceAccountKey', 'capturedAt', 'confirmed']));
  const conflicts = (Array.isArray(value?.conflicts) ? value.conflicts : []).slice(0, 100).map(row => jobFields(row, ['conversationId', 'currentRequirementId', 'mappedRequirementId', 'platformJobId', 'jobTitle', 'bossJobId', 'mappingStatus', 'capturedAt', 'resolution', 'confirmed']));
  return { provided, applicationRequirement, communicatingJobs, conflicts, policyVersion: JOB_CONTEXT_POLICY_VERSION };
}
const confirmedJobDifference = row => row?.confirmed === true || row?.resolution === 'keep_manual' || row?.mappingStatus === 'manual_override';
function jobContextState(jobContext, requirement) {
  const jobs = jobContext.communicatingJobs;
  const sameConversation = (a, b) => Boolean(a.conversationId && b.conversationId && a.conversationId === b.conversationId);
  const unresolvedConflicts = jobContext.conflicts.filter(row => row.currentRequirementId && row.mappedRequirementId && row.currentRequirementId !== row.mappedRequirementId && !confirmedJobDifference(row) && !jobs.some(job => sameConversation(job, row) && confirmedJobDifference(job)));
  const differingJobs = jobs.filter(job => job.mappedRequirementId && requirement.id && job.mappedRequirementId !== requirement.id);
  const unresolvedJobs = differingJobs.filter(job => !confirmedJobDifference(job) && !jobContext.conflicts.some(row => sameConversation(row, job) && confirmedJobDifference(row)));
  const hasConfirmedDifference = jobContext.conflicts.some(confirmedJobDifference) || differingJobs.some(job => confirmedJobDifference(job) || jobContext.conflicts.some(row => sameConversation(row, job) && confirmedJobDifference(row))) || jobs.some(job => job.mappingStatus === 'manual_override');
  return { provided: jobContext.provided, observedJobs: jobs.length, namedJobs: jobs.filter(job => job.jobTitle).length, mappedJobs: jobs.filter(job => job.mappedRequirementId).length, unresolvedDifference: Boolean(unresolvedConflicts.length || unresolvedJobs.length), confirmedDifference: hasConfirmedDifference, unknownCommunicationJob: !jobs.some(job => job.platformJobId || job.bossJobId || job.jobTitle), truncated: false, policyVersion: JOB_CONTEXT_POLICY_VERSION };
}
const resumeKind = () => 'attachment';
const sectionKeys = new Set(['workHistory', 'work', 'projectHistory', 'projects', 'project', 'education', 'skills', 'expectations', 'advantage', 'advantages', 'introduction', 'qualifications', 'certificates', 'certifications', 'training']);
function sectionStates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => sectionKeys.has(key)).map(([key, state]) => [key, typeof state === 'string' ? state.slice(0, 200) : typeof state === 'boolean' ? state : { ...(typeof state?.status === 'string' ? { status: state.status.slice(0, 200) } : {}), ...(Number.isInteger(state?.count) ? { count: state.count } : {}), ...(typeof state?.provided === 'boolean' ? { provided: state.provided } : {}), ...(typeof state?.truncated === 'boolean' ? { truncated: state.truncated } : {}) }]));
}
function resumeSources(values) {
  const valid = (Array.isArray(values) ? values : []).filter(isUsableAttachmentResume).slice(0, 20);
  const seen = new Set();
  const unique = valid.filter(row => { const key = `${resumeKind(row)}:${row.source || ''}:${row.sha256 || hash(row.text)}`; if (seen.has(key)) return false; seen.add(key); return true; });
  let remaining = 60000;
  return unique.map((row, index) => {
    const text = string(row.text, Math.min(40000, Math.floor(remaining / (unique.length - index)))); remaining -= text.length;
    const meta = row.sourceMeta || {};
    const sourceMeta = { ...Object.fromEntries(['source', 'capturedAt', 'readOnly', 'scope', 'sourceVersion', 'partial', 'truncated', 'detailsAvailable', 'rendering', 'ocrNeedsReview', 'ocrEngine', 'notes'].filter(key => ['string', 'boolean', 'number'].includes(typeof meta[key])).map(key => [key, typeof meta[key] === 'string' ? meta[key].slice(0, 1000) : meta[key]])), coverage: string(meta.coverage || row.coverage || 'parsed_attachment_text', 500) };
    const states = sectionStates(row.sectionStates || meta.sectionStates);
    return { ...select(row, ['id', 'name', 'kind', 'source', 'textStatus', 'sha256', 'createdAt', 'updatedAt']), materialKind: resumeKind(row), sourceMeta, sectionStates: states, text, textOriginalCharacters: row.text.trim().length, truncated: row.truncated === true || row.text.trim().length > text.length };
  });
}
const resumeMetadata = row => ({ id: row.id, name: row.name, sha256: row.sha256, textStatus: row.textStatus, materialKind: row.materialKind, source: row.source, coverage: row.sourceMeta.coverage, sectionStates: row.sectionStates, capturedAt: row.sourceMeta.capturedAt || row.createdAt, truncated: row.truncated });

export function buildAnalysisInput(scene, context = {}) {
  scenePrompt(scene);
  const originalRequirement = context.requirement ?? {};
  const requirement = select(originalRequirement, ['id', 'title', 'department', 'city', 'headcount', 'salaryRange', 'owner', 'priority', 'status', 'jd', 'version', 'businessGoal', 'requestReason', 'headcountJustification', 'budget', 'targetDate', 'reportingTo', 'teamContext', 'successCriteria', 'hiringReason', 'expectedOutcomes', 'workloadEvidence', 'currentTeamSize', 'budgetApproved', 'approvalStatus', 'targetStartDate', 'alternatives', 'marketEvidence']);
  requirement.mustHaves = professionalCriteria(originalRequirement.mustHaves);
  requirement.excludedCriteriaCount = (Array.isArray(originalRequirement.mustHaves) ? originalRequirement.mustHaves : []).filter(value => typeof value === 'string' && sensitiveCriterion.test(value)).length;
  const candidate = select(context.candidate ?? {}, ['id', 'name', 'source', 'city', 'workYear', 'degree', 'salary', 'position', 'company', 'school', 'major', 'introduction', 'workHistory', 'capturedAt']);
  const jobContext = normalizeJobContext(context.jobContext, requirement);
  const jobContextCoverage = { ...jobContextState(jobContext, requirement), candidateExpectedPositionPresent: Boolean(candidate.position), truncated: (Array.isArray(context.jobContext?.communicatingJobs) && context.jobContext.communicatingJobs.length > 100) || (Array.isArray(context.jobContext?.conflicts) && context.jobContext.conflicts.length > 100) };
  const application = select(context.application ?? {}, ['id', 'stage', 'reviewStatus', 'notes', 'criteriaVersion']);
  const interview = select(context.interview ?? {}, ['id', 'title', 'round', 'startAt', 'endAt', 'interviewer', 'status', 'meetingId', 'minuteToken']);
  const excludedPriorInterviewPack = usesRetiredOnlineResume(context.document);
  const document = excludedPriorInterviewPack ? {} : select(context.document ?? {}, ['id', 'title', 'type', 'criteriaVersion', 'version', 'createdAt']);
  if (!excludedPriorInterviewPack && context.document?.content) document.content = select(context.document.content, ['summary', 'criteria', 'questions', 'coreJudgments', 'agenda', 'notes', 'evidence', 'transcript']);
  const rawTranscript = typeof context.transcript === 'string' ? context.transcript : typeof context.transcript?.text === 'string' ? context.transcript.text : context.interview?.transcriptReview?.transcript ?? '';
  const transcript = string(rawTranscript, 120000);
  const materialSource = typeof context.source === 'string' ? string(context.source, 1000) : select(context.source, ['kind', 'type', 'id', 'title', 'url', 'reference', 'documentId', 'revisionId', 'minuteToken', 'noteId', 'meetingId', 'identity', 'artifactType', 'scope', 'capturedAt', 'coverage', 'textStatus', 'sourceRefs']);
  const sourceEvidence = [];
  for (const key of ['title', 'jd', 'businessGoal', 'requestReason', 'headcountJustification', 'budget', 'targetDate', 'reportingTo', 'teamContext', 'successCriteria', 'hiringReason', 'expectedOutcomes', 'workloadEvidence', 'salaryRange', 'approvalStatus', 'marketEvidence']) if (requirement[key] !== undefined && requirement[key] !== '') sourceEvidence.push(source('requirement', `requirement.${key}`, typeof requirement[key] === 'string' ? requirement[key] : JSON.stringify(requirement[key]), 'provided_requirement'));
  requirement.mustHaves.forEach((value, i) => sourceEvidence.push(source('requirement', `requirement.mustHaves[${i}]`, value, 'provided_requirement')));
  if (jobContext.provided) {
    if (jobContext.applicationRequirement.title) sourceEvidence.push({ ...source('job_context', 'jobContext.applicationRequirement.title', jobContext.applicationRequirement.title, 'provided_requirement'), roleType: 'application_requirement', requirementId: jobContext.applicationRequirement.id });
    jobContext.communicatingJobs.forEach((job, index) => {
      const key = job.jobTitle ? 'jobTitle' : job.platformJobId ? 'platformJobId' : job.bossJobId ? 'bossJobId' : null;
      if (key) sourceEvidence.push({ ...source('job_context', `jobContext.communicatingJobs[${index}].${key}`, job[key], 'platform_communication_job'), roleType: 'communicating_job', ...jobFields(job, ['conversationId', 'platformJobId', 'bossJobId', 'mappedRequirementId', 'mappingStatus', 'capturedAt', 'confirmed']) });
    });
    jobContext.conflicts.forEach((conflict, index) => { if (conflict.mappedRequirementId) sourceEvidence.push({ ...source('job_context', `jobContext.conflicts[${index}].mappedRequirementId`, conflict.mappedRequirementId, 'job_mapping_record'), roleType: 'mapping_difference', ...jobFields(conflict, ['conversationId', 'currentRequirementId', 'mappedRequirementId', 'resolution', 'confirmed']) }); });
  }
  if (candidate.introduction) sourceEvidence.push(source('candidate', 'candidate.introduction', candidate.introduction, 'candidate_self_report'));
  for (const key of ['workYear', 'degree', 'school', 'major', 'position', 'company', 'salary']) if (typeof candidate[key] === 'string' && candidate[key]) sourceEvidence.push(source('candidate', `candidate.${key}`, candidate[key], 'platform_career_summary'));
  for (const [i, work] of (Array.isArray(candidate.workHistory) ? candidate.workHistory : []).entries()) sourceEvidence.push(source('candidate', `candidate.workHistory[${i}]`, typeof work === 'string' ? work : [work.company, work.position, work.description, work.startDate, work.endDate].filter(Boolean).join(' · '), 'platform_career_summary'));
  const resumes = resumeSources(context.resumes);
  const excludedResumes = [...excludedOnlineResumeMetadata(context.resumes), ...(Array.isArray(context.excludedResumes) ? context.excludedResumes.filter(row => row?.reason === 'online_resume_retired').map(row => ({id: row.id, reason: row.reason})) : [])];
  const providedResumeText = resumes.map(row => `【附件简历解析原文 · ${row.name || row.id || '资料'}】\n${row.text}`).join('\n\n');
  const resumeText = string(providedResumeText, 120000);
  if (resumes.length) resumes.forEach((row, index) => sourceEvidence.push({ ...source('resume', `resumes[${index}].text`, row.text, 'candidate_self_report'), fileId: row.id, sha256: row.sha256, name: row.name, materialKind: row.materialKind, coverage: row.sourceMeta.coverage, sectionStates: row.sectionStates, capturedAt: row.sourceMeta.capturedAt || row.createdAt }));
  else if (resumeText) sourceEvidence.push(source('resume', 'resumeText', resumeText, 'candidate_self_report'));
  let messageBudget = 15000, knowledgeBudget = 15000;
  const messages = (Array.isArray(context.messages) ? context.messages : []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(-30).map(row => {
    const text = string(row.text, Math.min(2000, messageBudget)); messageBudget -= text.length;
    return { ...select(row, ['id', 'conversationId', 'sentAt']), sender: ['candidate','hr','system','unknown'].includes(row.sender) ? row.sender : 'unknown', text };
  }).filter(row => row.text);
  messages.forEach((row,index) => sourceEvidence.push({ ...source('message', `messages[${index}].text`, row.text, row.sender === 'candidate' ? 'candidate_self_report' : 'provided_message'), messageId: row.id, conversationId: row.conversationId, sender: row.sender }));
  const professionalKnowledge = (Array.isArray(context.professionalKnowledge) ? context.professionalKnowledge : Array.isArray(originalRequirement.professionalKnowledge) ? originalRequirement.professionalKnowledge : []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 8).map(row => {
    const text = string(row.text, Math.min(3000, knowledgeBudget)); knowledgeBudget -= text.length;
    return { id: string(row.id, 180), title: string(row.title, 300), url: /^https:\/\//i.test(row.url || '') ? string(row.url, 1000) : '', text, verified: row.verified === true };
  }).filter(row => row.text);
  professionalKnowledge.forEach((row,index) => sourceEvidence.push({ ...source('knowledge', `professionalKnowledge[${index}].text`, row.text, row.verified ? 'verified_professional_reference' : 'provided_professional_reference'), knowledgeId: row.id, title: row.title, url: row.url, verified: row.verified }));
  const lines = transcript.split(/\n+/).map((text, i) => ({ text: text.trim(), path: `transcript.lines[${i}]`, speaker: /^(?:候选人|应聘者|candidate)\s*[:：]/i.test(text) ? 'candidate' : /^(?:面试官|招聘官|hr|interviewer)\s*[:：]/i.test(text) ? 'interviewer' : 'unknown' })).filter(row => row.text);
  const transcriptEvidence = lines.map(line => source('transcript', line.path, line.text, 'transcript_statement'));
  return {
    scene, requirement, candidate, application, document, interview, resumes, resumeText, messages, professionalKnowledge, transcript, transcriptLines: lines, jobContext, jobContextPolicyVersion: JOB_CONTEXT_POLICY_VERSION, resumeSourcePolicyVersion: RESUME_SOURCE_POLICY_VERSION,
    provenance: { ...(context.provenance ? structuredClone(context.provenance) : { requirementVersion: requirement.version }), resumeFiles: resumes.map(resumeMetadata) },
    source: materialSource,
    sourceRefs: Array.isArray(context.sourceRefs) ? structuredClone(context.sourceRefs) : [],
    sourceEvidence, transcriptEvidence,
    previousAlerts: Array.isArray(context.previousAlerts) ? context.previousAlerts.slice(-50) : [],
    seenAlertKeys: Array.isArray(context.seenAlertKeys) ? context.seenAlertKeys.filter(value => typeof value === 'string').slice(-100) : [],
    previousTranscriptFingerprint: string(context.previousTranscriptFingerprint, 100),
    transcriptFingerprint: hash(transcript),
    coverage: { resume: resumeText ? 'provided_resume_text' : 'not_provided', resumeOriginalCharacters: resumes.length ? resumes.reduce((sum, row) => sum + row.textOriginalCharacters, 0) : providedResumeText.length, resumeCharacters: resumeText.length, resumeTruncated: providedResumeText.trim().length > 120000 || resumes.some(row => row.truncated) || (Array.isArray(context.resumes) && context.resumes.filter(isUsableAttachmentResume).length > 20), resumeSources: resumes.map(resumeMetadata), resumeSourcePolicyVersion: RESUME_SOURCE_POLICY_VERSION, excludedResumes, excludedPriorInterviewPack, hasOnlineDetails: false, hasAttachmentText: resumes.length > 0, jobContext: jobContextCoverage, transcript: transcript ? materialSource?.artifactType === 'document_content' ? 'provided_document_content_not_verified_transcript' : 'provided_transcript_only' : 'not_provided', transcriptOriginalCharacters: rawTranscript.length, transcriptCharacters: transcript.length, transcriptTruncated: rawTranscript.trim().length > 120000, externalMarketVerified: false, backgroundCheckPerformed: false },
  };
}

function preparedInput(scene, input) { return input?.scene === scene && input.resumeSourcePolicyVersion === RESUME_SOURCE_POLICY_VERSION && Array.isArray(input.sourceEvidence) && Array.isArray(input.transcriptEvidence) ? input : buildAnalysisInput(scene, input); }
function basis(scene, input, prompt) {
  return { scene, generator: 'rules', status: 'draft', title: `${scenePrompt(scene).name} · ${input.requirement?.title || '岗位待确认'}`, summary: '', conclusion: '', dimensions: [], clarifyingQuestions: [], recommendations: [], evidence: [], questions: [], coreJudgments: [], promptId: prompt.id, promptVersion: prompt.version, sourceRefs: structuredClone(prompt.sourceRefs ?? []), provenance: input.provenance, createdAt: new Date().toISOString(), inputFingerprint: hash(input), coverage: input.coverage, jobContext: structuredClone(input.jobContext), jobContextPolicyVersion: JOB_CONTEXT_POLICY_VERSION, limitations: ['规则草稿，未调用大模型；资料中未出现的信息保留待核验。', '仅用于岗位相关事实与证据整理，不作自动录用、淘汰或候选人价值评分。'] };
}
const careerSources = input => input.sourceEvidence.filter(item => ['candidate', 'resume'].includes(item.source));
function relatedEvidence(criterion, rows) {
  const tokens = String(criterion).match(/[A-Za-z][A-Za-z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,6}/g) ?? [];
  const seen = new Set();
  return rows.filter(row => { const quote = row.quote.trim(); if (seen.has(quote) || !tokens.some(token => quote.toLowerCase().includes(token.toLowerCase()))) return false; seen.add(quote); return true; }).slice(0, 2);
}
const requiredSources = (input, keys) => input.sourceEvidence.filter(row => keys.some(key => row.path === `requirement.${key}`));

function applyJobContextReview(scene, output, input) {
  if (!['resume_screen', 'interview_prep', 'interview_verify'].includes(scene) || !input.jobContext?.provided) return output;
  const context = input.jobContext, coverage = input.coverage.jobContext;
  const title = input.requirement.title || context.applicationRequirement.title || '当前内部需求（名称待补）';
  const names = [...new Set(context.communicatingJobs.map(job => job.jobTitle).filter(Boolean))];
  const platformDescription = names.length ? `BOSS 实际沟通岗位为“${names.join('”“')}”` : coverage.unknownCommunicationJob ? '尚未取得 BOSS 实际沟通岗位' : '已取得 BOSS 岗位标识，实际岗位名称尚未取得';
  const evidence = input.sourceEvidence.filter(row => row.source === 'job_context').slice(0, 20);
  const reviewStatus = coverage.unresolvedDifference ? 'needs_confirmation' : coverage.confirmedDifference ? 'confirmed_override' : coverage.unknownCommunicationJob ? 'unknown' : context.communicatingJobs.every(job => job.mappedRequirementId === input.requirement.id && Boolean(job.mappedRequirementId)) ? 'mapped' : 'mapping_unconfirmed';
  const finding = coverage.unresolvedDifference
    ? `本次按内部需求“${title}”整理职业证据；${platformDescription}，并存在尚未确认的岗位映射差异。候选人可能同时沟通多个岗位，差异不表示能力不足或负面事实，应先确认本次评估岗位及意向。`
    : coverage.confirmedDifference
      ? `本次按内部需求“${title}”评估；${platformDescription}。岗位差异已经人工确认保留，本次依明确指定的内部需求继续，不重复要求确认，也不覆盖平台原始岗位事实。`
      : `本次内部评估需求为“${title}”；${platformDescription}。${reviewStatus === 'mapped' ? '已保存的岗位映射对应当前内部需求。' : '尚未形成完整的岗位对应信息，不从名称、简历文件名或候选人期望岗位猜测。'}候选人期望岗位与沟通岗位分别保留。`;
  const action = coverage.unresolvedDifference ? '先确认这次沟通或面试针对哪个岗位、候选人是否希望了解该岗位，再使用相应需求标准复核职业证据。' : coverage.confirmedDifference ? '保留人工确认记录与双方岗位事实，按已确认的内部需求继续职业证据核验。' : reviewStatus === 'mapped' ? '使用当前需求版本分析职业证据，保留沟通岗位来源及映射记录。' : '补齐实际沟通岗位及平台标识到内部需求的可靠对应关系；未知项保持未知。';
  const reviewDimension = { ...dimension('本次评估与实际沟通岗位（系统核对）', reviewStatus === 'mapped' || reviewStatus === 'confirmed_override' ? 'adequate' : 'needs_verification', finding, evidence, action), origin: 'job_context_policy', policyVersion: JOB_CONTEXT_POLICY_VERSION };
  output.dimensions = output.dimensions.filter(row => row.origin !== 'job_context_policy');
  if (coverage.unresolvedDifference) output.dimensions.unshift(reviewDimension); else output.dimensions.push(reviewDimension);
  output.jobContextReview = { status: reviewStatus, policyVersion: JOB_CONTEXT_POLICY_VERSION, evaluationRequirement: { id: input.requirement.id || context.applicationRequirement.id, title, version: input.requirement.version ?? context.applicationRequirement.version }, communicatingJobs: structuredClone(context.communicatingJobs), conflicts: structuredClone(context.conflicts) };
  if (coverage.unresolvedDifference) {
    const question = `请先确认本次沟通或面试是否针对“${title}”，以及候选人是否希望了解该岗位；不要把其他岗位的沟通记录直接当作本次岗位意向。`;
    if (!output.clarifyingQuestions.includes(question)) output.clarifyingQuestions.unshift(question);
    if (!output.recommendations.includes(action)) output.recommendations.unshift(action);
    if (output.generator === 'rules') output.conclusion = '先确认本次评估岗位与候选人意向，再复核下列职业证据；岗位沟通差异不构成能力不足或负面事实，不自动拒绝。';
  }
  const seen = new Set(output.evidence.map(row => `${row.path}:${row.quote}`));
  output.evidence.push(...evidence.filter(row => { const key = `${row.path}:${row.quote}`; if (seen.has(key)) return false; seen.add(key); return true; }));
  return output;
}

export function generateRuleAnalysis(scene, rawInput, prompt = scenePrompt(scene)) {
  const input = preparedInput(scene, rawInput);
  const output = basis(scene, input, prompt);
  Object.assign(output, { generator: 'materials', title: '已收集资料 · 尚未分析',
    summary: '已整理本场岗位和已取得资料，尚未按提示词执行分析；材料不足的部分保留原状。',
    conclusion: '请使用智能体或模型API按当前模板分析。',
    evidence: input.sourceEvidence,
    limitations: ['仅列出已取得资料，不生成业务判断、分数或面试问题。'],
    ...(scene === 'live_assist' ? { quiet: true, alerts: [], transcriptFingerprint: input.transcriptFingerprint, seenAlertKeys: input.seenAlertKeys } : {}),
  });
  if (scene !== 'requirement_analysis' && !input.coverage.hasAttachmentText) output.limitations.push('尚无可解析附件简历；本次不能核对完整履历，只保留岗位标准、明确标注的职业摘要和会议原话。');
  if (input.coverage.excludedResumes.length || input.coverage.excludedPriorInterviewPack) output.limitations.push('历史在线简历及含在线正文的旧面试包已排除，不作为本次简历证据。');
  return applyJobContextReview(scene, output, input);
}

function parseObject(parsed) {
  if (typeof parsed === 'string') {
    const text = parsed.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    try { parsed = JSON.parse(text); } catch { throw issue('模型未返回有效 JSON 对象，没有用规则结果冒充模型分析。', 'model_schema_invalid'); }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw issue('模型分析必须是 JSON 对象。', 'model_schema_invalid');
  return parsed;
}
function textRequired(value, name) { if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw issue(`模型字段 ${name} 无效。`, 'model_schema_invalid'); return value.trim(); }
const arrayRequired = (value, name) => { if (!Array.isArray(value) || value.length > 100) throw issue(`模型字段 ${name} 应为有界数组。`, 'model_schema_invalid'); return value; };
function cleanEvidence(value, name, input) {
  return arrayRequired(value, name).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw issue(`模型字段 ${name} 中的证据必须带原话。`, 'model_schema_invalid');
    const quote = textRequired(item.quote, `${name}.quote`);
    const resolved = input && [...input.sourceEvidence, ...input.transcriptEvidence].find(row => row.path === item.path && row.quote.includes(quote));
    if (input && !resolved) throw issue('模型引用未出现在标注的来源路径中，未保存为有效分析。', 'model_unverified_evidence');
    return { source: resolved?.source ?? (string(item.source, 200) || 'provided_material'), path: resolved?.path ?? string(item.path, 500), quote, claimType: resolved?.claimType ?? 'model_cited_statement', ...(resolved?.source === 'resume' ? select(resolved, ['fileId', 'sha256', 'name', 'materialKind', 'coverage', 'sectionStates', 'capturedAt']) : {}), ...(resolved?.source === 'job_context' ? select(resolved, ['roleType', 'requirementId', 'conversationId', 'platformJobId', 'bossJobId', 'mappedRequirementId', 'mappingStatus', 'resolution', 'confirmed', 'capturedAt']) : {}), ...(resolved?.source === 'message' ? select(resolved, ['messageId','conversationId','sender']) : {}), ...(resolved?.source === 'knowledge' ? select(resolved, ['knowledgeId','title','url','verified']) : {}) };
  });
}
const questionAside = /职业摘要(?:把|将|显示|提到)|(?:简历|平台资料|候选人资料)(?:显示|把|将)|(?:具体范围|业务范围)(?:会)?先由(?:我们|面试官)说明|(?:面试官|出题说明|提问说明|来源说明)\s*[:：]/;
const privateBrief = /性格|人格|聪明|智商|智力|情商|家庭情况|忠诚度|(?:长期|未来)(?:会|能|一定|很)?稳定|稳定性(?:高|低|强|弱|好|差)|留任概率/;
const candidateCitation = (ref, input) => ['candidate','resume'].includes(ref.source) || ref.source === 'message' && input?.sourceEvidence.find(row => row.path === ref.path)?.sender === 'candidate';
function preparationText(value, name, max) {
  const text = textRequired(value, name);
  if (text.length > max || sensitiveCriterion.test(text) || privateBrief.test(text)) throw issue(`${name}包含超长文本或不适用于面试准备的个人属性判断。`, 'model_unsafe_result');
  return text;
}
function normalizePreparationQuestion(item, input) {
  const result = { topic: textRequired(item?.topic, 'questions.topic'), question: textRequired(item?.question, 'questions.question'), purpose: string(item.purpose, 2000), evidence: cleanEvidence(item.evidence ?? [], 'questions.evidence', input) };
  // Historical analyses still load without a fabricated type or reference answer.
  if (item.type === undefined && item.referenceAnswer === undefined) return result;
  if (!['experience','professional'].includes(item.type)) throw issue('面试题类型应为经历题或专业知识题。', 'model_schema_invalid');
  if (result.question.length > 400 || questionAside.test(result.question)) throw issue('面试问句应可直接朗读，来源和出题说明请放在独立字段。', 'model_question_not_readable');
  if (input && item.type === 'experience' && !result.evidence.some(ref => candidateCitation(ref,input))) throw issue('经历题应引用本场候选人职业资料、附件或本人聊天原话。', 'model_unverified_evidence');
  if (input && item.type === 'professional' && !result.evidence.some(ref => ref.source === 'requirement')) throw issue('专业题应保留本场岗位要求的关联原文。', 'model_unverified_evidence');
  const answer = item.referenceAnswer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || !['verified','needs_verification','not_applicable'].includes(answer.verificationStatus)) throw issue('参考答案需要明确的核对状态。', 'model_schema_invalid');
  if (typeof answer.text !== 'string' || answer.text.length > 3000 || !Array.isArray(answer.keyPoints) || answer.keyPoints.length > 8 || answer.keyPoints.some(row => typeof row !== 'string' || !row.trim() || row.length > 500)) throw issue('参考答案或要点格式无效。', 'model_schema_invalid');
  if (sensitiveCriterion.test(answer.text) || privateBrief.test(answer.text) || answer.keyPoints.some(row => sensitiveCriterion.test(row) || privateBrief.test(row))) throw issue('参考答案包含不适用于岗位面试的个人属性内容。', 'model_unsafe_result');
  const sourceRefs = cleanEvidence(answer.sourceRefs ?? [], 'questions.referenceAnswer.sourceRefs', input);
  if (item.type === 'professional' && (answer.verificationStatus === 'not_applicable' || !answer.text.trim() && !answer.keyPoints.length)) throw issue('专业题需提供供面试官核对的参考答案或关键要点。', 'model_schema_invalid');
  if (answer.verificationStatus === 'verified' && (!input || !sourceRefs.some(ref => ref.source === 'knowledge' && ref.verified === true))) throw issue('已核对参考答案必须有本次提供并已确认的专业资料原文。', 'model_unverified_answer');
  return { ...result, type: item.type, referenceAnswer: { text: answer.text.trim(), keyPoints: answer.keyPoints.map(row => row.trim()), verificationStatus: answer.verificationStatus, sourceRefs } };
}
function normalizeCandidateBrief(value, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string' || value.text.length > 600 || !Array.isArray(value.highlights) || value.highlights.length > 4) throw issue('候选人简介格式无效。', 'model_schema_invalid');
  const evidence = cleanEvidence(value.evidence ?? [], 'candidateBrief.evidence', input);
  if (value.text.trim() && (!evidence.length || input && evidence.some(ref => !candidateCitation(ref,input)))) throw issue('候选人简介需要来自本人职业资料、附件或聊天的准确依据。', 'model_unverified_evidence');
  const text = value.text.trim() ? preparationText(value.text, 'candidateBrief.text', 600) : '';
  const highlights = value.highlights.map(row => {
    if (!row || typeof row !== 'object') throw issue('候选人记忆点格式无效。', 'model_schema_invalid');
    const refs = cleanEvidence(row.evidence ?? [], 'candidateBrief.highlights.evidence', input);
    if (!refs.length || refs.length > 4 || input && refs.some(ref => !candidateCitation(ref,input))) throw issue('每个候选人记忆点都需要对应职业资料原话。', 'model_unverified_evidence');
    return { text: preparationText(row.text, 'candidateBrief.highlights.text', 220), evidence: refs };
  });
  const fitReasons = value.fitReasons === undefined ? undefined : arrayRequired(value.fitReasons, 'candidateBrief.fitReasons').map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw issue('岗位匹配理由格式无效。', 'model_schema_invalid');
    const refs = cleanEvidence(row.evidence ?? [], 'candidateBrief.fitReasons.evidence', input);
    if (refs.length < 2 || refs.length > 6 || !refs.some(ref => candidateCitation(ref,input)) || !refs.some(ref => ref.source === 'requirement') || refs.some(ref => !candidateCitation(ref,input) && ref.source !== 'requirement')) throw issue('每条岗位匹配理由都需要本人职业资料和本场岗位要求的准确原文。', 'model_unverified_evidence');
    return { text: preparationText(row.text, 'candidateBrief.fitReasons.text', 220), evidence: refs };
  });
  if (fitReasons?.length > 3) throw issue('请保留最多三条关键岗位匹配理由。', 'model_schema_invalid');
  if (evidence.length > 10) throw issue('候选人简介引用过多，请保留关键原话。', 'model_schema_invalid');
  return { text, highlights, evidence, ...(fitReasons === undefined ? {} : { fitReasons }) };
}
export function normalizeModelAnalysis(scene, value, context = {}) {
  scenePrompt(scene);
  if (context.input) context = { ...context, input: preparedInput(scene, context.input) };
  const prompt = context.prompt ?? scenePrompt(scene), parsed = parseObject(value);
  if (['score', 'ranking', 'hireDecision', 'rejectDecision', 'candidateScore', 'fitScore'].some(key => Object.hasOwn(parsed, key))) throw issue('模型返回候选人评分或用人决定，当前工作流不接受此类结果。', 'model_unsafe_result');
  const result = { scene, generator: 'model', status: 'draft', title: textRequired(parsed.title, 'title'), summary: textRequired(parsed.summary, 'summary'), conclusion: textRequired(parsed.conclusion, 'conclusion'), promptId: prompt.id, promptVersion: prompt.version, sourceRefs: structuredClone(prompt.sourceRefs ?? []), model: context.model, createdAt: new Date().toISOString() };
  const listOfText = name => arrayRequired(parsed[name], name).map((item, i) => textRequired(item, `${name}[${i}]`));
  result.dimensions = arrayRequired(parsed.dimensions, 'dimensions').map(item => {
    if (!item || !['adequate', 'missing', 'risk', 'needs_verification'].includes(item.status)) throw issue('模型维度状态不符合约定。', 'model_schema_invalid');
    return dimension(textRequired(item.name, 'dimensions.name'), item.status, textRequired(item.finding, 'dimensions.finding'), cleanEvidence(item.evidence, 'dimensions.evidence', context.input), textRequired(item.action, 'dimensions.action'));
  });
  result.clarifyingQuestions = listOfText('clarifyingQuestions'); result.recommendations = listOfText('recommendations'); result.coreJudgments = listOfText('coreJudgments');
  result.agenda = parsed.agenda === undefined ? [] : listOfText('agenda');
  if (result.coreJudgments.length > 3) throw issue('本场核心判断不得超过 3 条。', 'model_schema_invalid');
  result.evidence = cleanEvidence(parsed.evidence, 'evidence', context.input);
  result.questions = arrayRequired(parsed.questions, 'questions').map(item => scene === 'interview_prep' ? normalizePreparationQuestion(item, context.input) : ({ topic: textRequired(item?.topic, 'questions.topic'), question: textRequired(item?.question, 'questions.question'), purpose: string(item.purpose, 2000), evidence: cleanEvidence(item.evidence ?? [], 'questions.evidence', context.input) }));
  if (scene === 'interview_prep' && parsed.candidateBrief !== undefined) result.candidateBrief = normalizeCandidateBrief(parsed.candidateBrief, context.input);
  const generatedCriteria = [...result.questions.map(item => `${item.topic} ${item.question}`), ...result.coreJudgments, ...result.clarifyingQuestions];
  if (generatedCriteria.some(item => sensitiveCriterion.test(item)) || /(?:建议|决定|直接|应当|予以)(?:录用|淘汰|拒绝|不予录用)/.test(result.conclusion)) throw issue('模型结果包含不适当的个人属性追问或自动用人决定，需重新生成职业证据分析。', 'model_unsafe_result');
  if (scene === 'live_assist') {
    if (typeof parsed.quiet !== 'boolean') throw issue('会中提示必须明确 quiet 状态。', 'model_schema_invalid');
    result.quiet = parsed.quiet;
    const alerts = arrayRequired(parsed.alerts ?? [], 'alerts');
    if (alerts.length > 2) throw issue('会中提示一次最多 2 条。', 'model_schema_invalid');
    result.alerts = alerts.map(item => ({ id: `alert_${hash(`${context.input?.interview?.id ?? 'current'}:${item.topic}:${item.question}`).slice(0, 20)}`, topic: textRequired(item.topic, 'alerts.topic'), question: textRequired(item.question, 'alerts.question'), reason: string(item.reason, 2000), evidence: cleanEvidence(item.evidence ?? [], 'alerts.evidence', context.input) }));
    if (result.quiet && (result.alerts.length || result.questions.length)) throw issue('quiet=true 时不应同时生成打断提示。', 'model_schema_invalid');
    if (result.alerts.some(item => sensitiveCriterion.test(item.question))) throw issue('会中提示包含不适当个人属性追问。', 'model_unsafe_result');
    if (context.input) {
      const seen = new Set(context.input.seenAlertKeys);
      result.alerts = result.alerts.filter(alert => !seen.has(alert.id) && !context.input.previousAlerts.some(previous => previous.question === alert.question));
      result.quiet = !result.alerts.length;
      result.questions = result.alerts.map(({ topic, question, evidence }) => ({ topic, question, purpose: '核对本段证据缺口', evidence }));
      result.transcriptFingerprint = context.input.transcriptFingerprint;
      result.seenAlertKeys = [...new Set([...seen, ...result.alerts.map(alert => alert.id)])];
    }
  }
  if (context.input) { result.coverage = context.input.coverage; result.provenance = context.input.provenance; result.inputFingerprint = hash(context.input); result.jobContext = structuredClone(context.input.jobContext); result.jobContextPolicyVersion = JOB_CONTEXT_POLICY_VERSION; }
  return context.input ? applyJobContextReview(scene, result, context.input) : result;
}

export function renderAnalysisPrompt(prompt, input) {
  return compilePrompt(prompt, input);
}

export async function analyzeWithProvider({ scene, input: rawInput, prompt = scenePrompt(scene), modelSettings, apiKey = '', fetchImpl, lookupImpl } = {}) {
  const input = preparedInput(scene, rawInput);
  const rendered = renderAnalysisPrompt(prompt, input);
  const response = await callModel({ settings: modelSettings, apiKey, ...rendered, fetchImpl, lookupImpl });
  return { ...normalizeModelAnalysis(scene, response.content, { prompt, input, model: response.model }), usage: response.usage };
}

export async function analyzeWithAgent({ scene, input: rawInput, prompt = scenePrompt(scene), provider = 'codex', agentRunner = runInterviewAgent } = {}) {
  const input = preparedInput(scene, rawInput), compiled = compilePrompt(prompt, input);
  const response = await agentRunner({ input, provider, schema: promptTechnicalContract(scene).outputSchema,
    prompt: { systemPrompt: compiled.systemPrompt, userPrompt: promptTechnicalContract(scene).userPrompt.replace('{{input}}', '使用本轮随附的结构化JSON材料') } });
  return { ...normalizeModelAnalysis(scene, response.output, { prompt, input, model: response.model }),
    generator: 'agent', provider: response.provider || provider };
}
