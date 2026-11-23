import { DEFAULT_PROMPTS, defaultPromptFor, DEFAULT_PROMPT_MIGRATIONS, promptDefaultFingerprint } from './prompts.mjs';
import { buildAnalysisInput, analyzeWithProvider, analyzeWithAgent } from './analysis.mjs';
import { migratePromptGovernance, promptFingerprint } from './prompt-governance.mjs';
import { digest, uid, now, addActivity } from './store.mjs';
import { ensureJobMappingState, buildCandidateJobContext } from './job-mappings.mjs';
import { isUsableAttachmentResume, isRetiredOnlineResume, RESUME_SOURCE_POLICY_VERSION } from './resume-policy.mjs';

export function ensureAdvancedState(state) {
  let changed = false;
  if(ensureJobMappingState(state))changed=true;
  for (const key of ['prompts', 'analyses', 'resumes']) if (!Array.isArray(state[key])) { state[key] = []; changed = true; }
  for (const prompt of DEFAULT_PROMPTS) if (!state.prompts.some(row => row.id === prompt.id)) { state.prompts.push({ ...structuredClone(prompt), createdAt: now(), updatedAt: now() }); changed = true; }
  for(const prompt of state.prompts)if(['live_assist','interview_verify'].includes(prompt.scene)){const replacement=prompt.scene==='live_assist'?'interview_copilot':'interview_report';if(prompt.retired!==true||prompt.replacedBy!==replacement){prompt.retired=true;prompt.replacedBy=replacement;changed=true;}}
  for (const migration of DEFAULT_PROMPT_MIGRATIONS) {
    const row = state.prompts.find(item => item.id === migration.id);
    if (!row || row.version !== migration.fromVersion || ![migration.previousDefaultFingerprint, migration.previousDefaultFingerprintWithoutSourceRefs].includes(promptDefaultFingerprint(row))) continue;
    const history = [...(row.previousVersions || []), { ...structuredClone(row), previousVersions: undefined }].slice(-20);
    Object.assign(row, defaultPromptFor(row.scene), { createdAt: row.createdAt, updatedAt: now(), previousVersions: history });
    changed = true;
  }
  if (!state.settings.model) { state.settings.model = { baseUrl: '', model: '', temperature: 0.2, maxTokens: 2500, timeoutMs: 60000, jsonMode: false }; changed = true; }
  if (migratePromptGovernance(state)) changed = true;
  return changed;
}
// Historical seeded analyses are kept in storage. New analyses must execute the saved template.
export function seedCodexRequirementAnalysis() { return null; }

export function analysisContext(state, request) {
  let application, candidate, requirement, interview, document;
  if (request.interviewId) { interview = state.interviews.find(row => row.id === request.interviewId); if (!interview) throw new Error('面试场次不存在。'); }
  const applicationId = request.applicationId || interview?.applicationId;
  if (interview && applicationId !== interview.applicationId) throw Object.assign(new Error('面试场次与应聘流程不一致。'), { statusCode: 400 });
  if (applicationId) { application = state.applications.find(row => row.id === applicationId); if (!application) throw new Error('应聘流程不存在。'); }
  const candidateId = request.candidateId || application?.candidateId || interview?.candidateId;
  if (candidateId) candidate = state.candidates.find(row => row.id === candidateId);
  const requirementId = request.requirementId || application?.requirementId || interview?.requirementId;
  if (requirementId) requirement = state.requirements.find(row => row.id === requirementId);
  if (!requirement) throw Object.assign(new Error('请先选择有效招聘需求。'), { statusCode: 400 });
  if (application && (candidateId !== application.candidateId || requirementId !== application.requirementId)) throw Object.assign(new Error('候选人、需求和应聘流程关联不一致。'), { statusCode: 400 });
  if (interview && (candidateId !== interview.candidateId || requirementId !== interview.requirementId)) throw Object.assign(new Error('面试场次、候选人与招聘需求关联不一致。'), { statusCode: 400 });
  if (request.scene !== 'requirement_analysis' && !candidate) throw Object.assign(new Error('请先选择候选人及其应聘流程。'), { statusCode: 400 });
  document = state.documents.find(row => row.id === interview?.documentId) || state.documents.find(row => row.applicationId === application?.id && row.type === 'interview_pack');
  const candidateResumes = state.resumes.filter(row => row.candidateId === candidate?.id && (!row.applicationId || row.applicationId === application?.id));
  const resumes = candidateResumes.filter(isUsableAttachmentResume);
  const excludedResumes = candidateResumes.filter(isRetiredOnlineResume).map(row => ({ id: row.id, reason: 'online_resume_retired' }));
  if (request.scene === 'resume_screen' && !resumes.length) throw Object.assign(new Error('请先下载 BOSS 已授权附件或上传已有简历，并完成文本解析。在线简历功能已停用，历史在线快照和聊天顶部摘要不用于初筛。'), { statusCode: 400 });
  const stored = request.scene === 'live_assist'
    ? [{ text: interview?.liveSession?.transcript, source: interview?.liveSession?.source }, { text: interview?.transcriptReview?.transcript, source: { kind: 'manual_transcript' } }]
    : [{ text: interview?.meetingMaterial?.transcript, source: interview?.meetingMaterial?.source }, { text: interview?.transcriptReview?.transcript, source: { kind: 'manual_transcript' } }, { text: interview?.liveSession?.transcript, source: interview?.liveSession?.source }];
  const selected = typeof request.transcript === 'string'
    ? { text: request.transcript, source: stored.find(row => row.text && row.text.trim() === request.transcript.trim())?.source || { kind: 'manual_transcript' } }
    : stored.find(row => row.text?.trim()) || { text: '', source: { kind: 'manual_transcript' } };
  const transcript = selected.text;
  if (['live_assist', 'interview_verify'].includes(request.scene) && !transcript.trim()) throw Object.assign(new Error('请先读取飞书会议记录或粘贴本场逐字稿，再分析本场内容。'), { statusCode: 400 });
  const source = selected.source || { kind: 'manual_transcript' };
  const conversationIds=new Set((state.conversations||[]).filter(row=>row.candidateId===candidate?.id&&(!row.requirementId||row.requirementId===requirement.id)&&(!candidate?.sourceAccountKey||row.sourceAccountKey===candidate.sourceAccountKey)).map(row=>row.id));
  const messages=(state.messages||[]).filter(row=>conversationIds.has(row.conversationId)&&row.sender==='candidate').sort((a,b)=>(Date.parse(a.sentAt)||0)-(Date.parse(b.sentAt)||0)).slice(-30);
  const professionalKnowledge=request.professionalKnowledge||requirement.professionalKnowledge||document?.content?.professionalKnowledge||[];
  return { requirement, candidate, application, interview, document, resumes, excludedResumes, messages,professionalKnowledge,jobContext:buildCandidateJobContext(state,candidate,requirement),resumeText: resumes.map(row => `【附件简历解析原文 · ${row.name} · ${row.sha256.slice(0, 12)}】\n${row.text}`).join('\n\n'), transcript, source, previousAlerts: interview?.liveSession?.alerts || [], seenAlertKeys: interview?.liveSession?.seenAlertKeys || [], previousTranscriptFingerprint: interview?.liveSession?.lastAnalyzedFingerprint || '' };
}

export async function runAnalysis(state, request, { secrets, fetchImpl, lookupImpl, agentRunner } = {}) {
  const scene = request.scene; defaultPromptFor(scene);
  const requested = request.generator || 'auto';
  if (!['rules', 'auto', 'agent', 'model'].includes(requested)) throw Object.assign(new Error('请选择智能体或模型API分析。'), { statusCode: 400 });
  const generator = ['auto','rules'].includes(requested) ? state.settings.interviewCopilot?.mode === 'api' ? 'model' : 'agent' : requested;
  const prompt = request.promptId ? state.prompts.find(row => row.id === request.promptId && row.scene === scene) : state.prompts.find(row => row.scene === scene);
  if (!prompt) throw Object.assign(new Error('提示词不存在或与分析场景不匹配。'), { statusCode: 400 });
  const context = analysisContext(state, request), input = buildAnalysisInput(scene, context);
  // Generated preparation must not feed itself back as changed material.
  if (scene === 'interview_prep') input.document = {};
  const fingerprint = promptFingerprint(prompt);
  const analysisKey = digest(JSON.stringify({ scene, input, fingerprint, generator, engine: generator === 'model' ? state.settings.model : state.settings.interviewCopilot?.agentProvider || 'codex' }));
  const cached = state.analyses.find(row => row.analysisKey === analysisKey);
  if (cached) return { ...structuredClone(cached), reused: true };
  let result;
  if (generator === 'model') {
    const apiKey = await secrets.getModelKey(state.settings.model.baseUrl);
    result = await analyzeWithProvider({ scene, input, prompt, modelSettings: state.settings.model, apiKey, fetchImpl, lookupImpl });
  } else result = await analyzeWithAgent({ scene, input, prompt, provider: state.settings.interviewCopilot?.agentProvider || 'codex', agentRunner });
  return { ...result, analysisKey, promptFingerprint: fingerprint, id: uid('analysis'), requirementId: context.requirement.id, requirementVersion: context.requirement.version, candidateId: context.candidate?.id || null, applicationId: context.application?.id || null, interviewId: context.interview?.id || null, updatedAt: now(), sourceSnapshot: { messages: input.messages, professionalKnowledge: input.professionalKnowledge, requirementVersion: context.requirement.version, requirementUpdatedAt: context.requirement.updatedAt, prompt: { id: prompt.id, version: prompt.version, fingerprint }, resumes: context.resumes.map(row => ({ id: row.id, sha256: row.sha256, name: row.name, kind: row.kind, source: row.source, textStatus: row.textStatus, coverage: row.coverage, capturedAt: row.capturedAt, sectionStates: row.sectionStates || null })), transcriptHash: context.transcript ? digest(context.transcript) : null, transcriptCharacters: context.transcript.length, meetingSource: context.source || null, jobContext: input.jobContext, jobContextPolicyVersion: result.jobContextPolicyVersion, coverage: input.coverage, resumeSourcePolicyVersion: RESUME_SOURCE_POLICY_VERSION, excludedResumes: context.excludedResumes } };
}
export function saveAnalysis(state, row) {
  const existing = state.analyses.find(item => item.id === row.id || row.analysisKey && item.analysisKey === row.analysisKey);
  if (existing) return { ...existing, reused: true };
  state.analyses.unshift(row);
  if (row.scene === 'interview_verify') state.evaluations.unshift({ id: uid('evaluation'), applicationId: row.applicationId, interviewId: row.interviewId, type: 'interview_verification', reviewer: row.generator === 'model' ? '模型草稿' : '规则草稿', criteriaVersion: row.requirementVersion, evidence: row.evidence, conclusion: row.conclusion, status: 'draft', analysisId: row.id, createdAt: now() });
  addActivity(state, 'analysis', row.title, `${row.generator === 'model' ? 'API分析' : row.generator === 'agent' ? '智能体分析' : '历史草稿'} · 提示词 v${row.promptVersion}，结论待人工复核。`);
  return row;
}
