import { sourcingMatchAnalysisKey } from './sourcing-match.mjs';
import { replyPriorityAnalysisKey } from './reply-priority.mjs';
import { professionalPriorityText } from './professional-text.mjs';

const labels = { sourcing_match: '岗位匹配参考', conversation_priority: '回复优先级', resume_screen: '附件初筛参考', interview_report: '上轮面试参考' };
const clean = (value, limit = 500) => professionalPriorityText(typeof value === 'string' ? value : '', limit);
const array = value => Array.isArray(value) ? value : [];

/** Read-only projection of existing, correctly scoped judgments; never scores. */
export function chooseInterviewScoreSummary(state, { candidateId, requirementId, applicationId } = {}) {
  const candidate = array(state.candidates).find(row => row.id === candidateId);
  const requirement = array(state.requirements).find(row => row.id === requirementId);
  if (!candidate || !requirement) return null;
  const candidates = array(state.analyses).filter(row => row.candidateId === candidateId && row.requirementId === requirementId
    && Object.hasOwn(labels, row.scene) && Number.isFinite(row.score) && row.score >= 0 && row.score <= 100
    && (!row.applicationId || !applicationId || row.applicationId === applicationId));
  for (const interview of array(state.interviews)) {
    const report = interview.interviewReport;
    if (interview.candidateId !== candidateId || interview.requirementId !== requirementId || applicationId && interview.applicationId !== applicationId
      || !report || report.candidateId !== candidateId || report.requirementId !== requirementId || report.interviewId !== interview.id
      || !Number.isFinite(report.totalScore) || report.totalScore < 0 || report.totalScore > 100) continue;
    candidates.push({ ...report, score: report.totalScore, scene: 'interview_report', reasons: array(report.dimensions).map(row => row.reason), humanReviewRequired: true });
  }
  const rows = candidates.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  for (const row of rows) {
    let stale = Boolean(row.stale || row.requirementVersion && row.requirementVersion !== requirement.version);
    if (row.scene === 'sourcing_match') {
      const source = array(state.sourcingCandidates).find(item => item.id === row.sourceId);
      if (!source || source.candidateId !== candidateId || source.requirementId !== requirementId
        || candidate.sourceAccountKey && source.sourceAccountKey !== candidate.sourceAccountKey) continue;
      try { stale ||= !row.analysisKey || row.analysisKey !== sourcingMatchAnalysisKey(state, { sourceId: row.sourceId, requirementId }); } catch { stale = true; }
    } else if (row.scene === 'conversation_priority') {
      const conversation = array(state.conversations).find(item => item.id === row.conversationId);
      if (!conversation || conversation.candidateId !== candidateId || conversation.requirementId !== requirementId
        || candidate.sourceAccountKey && conversation.sourceAccountKey !== candidate.sourceAccountKey) continue;
      try { stale ||= !row.analysisKey || row.analysisKey !== replyPriorityAnalysisKey(state, row.conversationId); } catch { stale = true; }
    } else {
      const prompt = array(state.prompts).find(item => item.id === row.promptId);
      if (prompt && row.promptVersion !== prompt.version) stale = true;
    }
    const reasons = array(row.reasons?.length ? row.reasons : row.dimensions).map(value => clean(typeof value === 'string' ? value : value?.rationale || value?.reason || value?.finding, 300)).filter(Boolean).slice(0, 2);
    const summary = clean(row.summary, 500);
    if (!summary && !reasons.length) continue;
    return { score: row.score, kind: row.scene, label: labels[row.scene], summary, reasons, stale,
      promptVersion: row.promptVersion || null, createdAt: row.createdAt || null, analysisId: row.id,
      requirementId, candidateId, applicationId: row.applicationId || applicationId || null,
      humanReviewRequired: true };
  }
  return null;
}
