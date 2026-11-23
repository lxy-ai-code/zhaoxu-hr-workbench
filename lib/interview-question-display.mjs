import { createHash } from 'node:crypto';

export const questionTextHash = question => createHash('sha256').update(typeof question === 'string' ? question : question?.question || '').digest('hex');
const clean = value => typeof value === 'string' ? value.trim() : '';

/** Compatibility accessor: only display metadata already stored on each question.
 * No person, employer, document version or topic selects a business rewrite.
 */
export function buildReviewedQuestionDisplay(document) {
  if (document?.type !== 'interview_pack' || !Array.isArray(document.content?.questions)) return [];
  return document.content.questions.flatMap(question => {
    const sourceQuestion = typeof question === 'string' ? question : question?.question || '';
    const display = explicitDisplay(question?.display, questionTextHash(sourceQuestion));
    return display ? [{ ...display, sourceQuestion }] : [];
  });
}

function explicitDisplay(value, hash) {
  if (!value || value.sourceQuestionHash !== hash || !clean(value.title) || value.title.length > 8 || !clean(value.mainQuestion) || value.mainQuestion.length > 45 || !Array.isArray(value.followUps) || value.followUps.length < 2 || value.followUps.length > 3 || value.followUps.some(item => !clean(item) || item.length > 16) || !clean(value.focus) || value.focus.length > 20) return null;
  return { title: clean(value.title), mainQuestion: clean(value.mainQuestion), followUps: value.followUps.map(clean), focus: clean(value.focus), sourceQuestionHash: hash, origin: 'explicit_display' };
}

/** Pure presentation adapter. The fallback splits only at existing punctuation;
 * it never fabricates a conclusion or silently ellipsizes the source question.
 */
export function questionDisplay(originalQuestion) {
  const sourceQuestion = typeof originalQuestion === 'string' ? originalQuestion : originalQuestion?.question || '';
  const sourceQuestionHash = questionTextHash(sourceQuestion);
  const explicit = explicitDisplay(originalQuestion?.display, sourceQuestionHash);
  if (explicit) return { ...explicit, sourceQuestion };
  const parts = sourceQuestion.match(/[^。！？；\n]+[。！？；]?/gu)?.map(clean).filter(Boolean) || [];
  const clauses = (parts[0] || clean(sourceQuestion)).match(/[^：:，,]+[：:，,]?/gu)?.map(clean).filter(Boolean) || [];
  const first = parts[0] || clean(sourceQuestion);
  const mainQuestion = first.length <= 45 ? first : clauses[0] || first;
  const remaining = first.length > 45 ? [...clauses.slice(1), ...parts.slice(1)] : parts.slice(1);
  return { title: clean(originalQuestion?.topic).split(/[：:]/)[0] || '案例核验', mainQuestion, followUps: remaining, focus: '', sourceQuestion, sourceQuestionHash, origin: 'source_punctuation', requiresFullSource: mainQuestion.length > 45 || remaining.length > 3 || remaining.some(row => row.length > 16) };
}
