import { sameLarkConnection } from './lark-context.mjs';

const longId = value => typeof value === 'string' && /^\d{10,25}$/.test(value.trim()) ? value.trim() : '';
const mismatch = () => Object.assign(new Error('本场已有其他飞书身份的会议关联，请明确提供当前应用入会后取得的长会议 ID；原记录将保留。'), { code: 'meeting_context_mismatch', statusCode: 409 });

/** Resolve only this interview's verified meeting context. No I/O or mutation. */
export function resolveInterviewMeetingContext(interview = {}, connection, { meetingId } = {}) {
  const prior = interview.liveSession, joined = interview.autoJoin;
  const explicit = typeof meetingId === 'string' ? meetingId.trim() : meetingId;
  if (explicit !== undefined && explicit !== null && explicit !== '' && !longId(explicit)) throw Object.assign(new Error('请使用 10–25 位数字的长会议 ID，9 位会议号不能读取会中内容。'), { code: 'invalid_reference', statusCode: 400 });
  const samePrior = sameLarkConnection(prior?.feishuConnection, connection);
  const sameJoined = Boolean(joined?.feishuConnection && sameLarkConnection(joined.feishuConnection, connection));
  let selected = '', source = 'none';
  if (longId(explicit)) { selected = longId(explicit); source = 'explicit'; }
  else if (joined?.status === 'joined' && sameJoined && longId(joined.meetingId)) { selected = longId(joined.meetingId); source = 'auto_join'; }
  else if (samePrior && longId(prior?.meetingId)) { selected = longId(prior.meetingId); source = 'live_session'; }
  if (!selected && ((prior?.meetingId && !samePrior) || (joined?.status === 'joined' && joined?.meetingId && !sameJoined))) throw mismatch();
  const reset = !selected || !samePrior || longId(prior?.meetingId) !== selected;
  return { meetingId: selected, pageToken: !reset && typeof prior?.pageToken === 'string' ? prior.pageToken : '', reset, source };
}
