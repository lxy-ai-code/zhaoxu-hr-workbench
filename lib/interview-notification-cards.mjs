import { runLark, LarkCliError } from './lark-cli.mjs';
import { larkArguments, normalizeLarkConnection, sameLarkConnection, withLarkErrorContext } from './lark-context.mjs';
import { safeFeishuMeetingUrl } from './feishu-interviews.mjs';
import { normalizeEvaluationRules } from './evaluation-rules.mjs';
import { digest } from './store.mjs';

const kinds = new Set(['invitation', 'joined', 'summarizing', 'summary']);
const text = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];
const clip = (value, limit) => {
  const chars = [...text(value)];
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
};
const esc = value => String(value ?? '').replace(/[&<>*~`\[\]()#_\\]/g, c => `&#${c.charCodeAt(0)};`);
const md = (content, size = 'normal', extra = {}) => ({ tag: 'markdown', content, text_size: size, margin: '0px', ...extra });
const block = (elements, background = 'grey-50') => ({
  tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
  columns: [{ tag: 'column', width: 'weighted', weight: 1, background_style: background, padding: '12px', vertical_spacing: '4px', elements }],
});
const folded = (title, elements) => ({
  tag: 'collapsible_panel', expanded: false, direction: 'vertical', vertical_spacing: '8px', padding: '8px',
  border: { color: 'grey-100', corner_radius: '5px' },
  header: { title: { tag: 'plain_text', content: title }, background_color: 'grey-50', padding: '8px', width: 'fill', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 }, elements,
});
const fail = (message, code = 'invalid_interview_notification') => new LarkCliError(message, { code, statusCode: 400 });
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

function safeCalendarUrl(value) {
  const safe = safeFeishuMeetingUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  return /^(?:applink\.feishu\.cn|applink\.larksuite\.com|applink\.larkoffice\.com)$/.test(url.hostname)
    && /^\/client\/calendar\/event\/detail\/?$/.test(url.pathname) ? safe : '';
}
function formatTime(value, options) {
  return Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...options }).format(new Date(value)) : '';
}
function timeLabel(interview) {
  const start = formatTime(interview?.startAt, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const end = formatTime(interview?.endAt, { hour: '2-digit', minute: '2-digit', hour12: false });
  return start ? `${start}${end ? `–${end}` : ''} · 北京时间` : '面试时间以已收到的飞书日程为准';
}
function buttons(interview, { meeting = true } = {}) {
  const urls = [
    ...(meeting && safeFeishuMeetingUrl(interview?.meetingUrl) ? [{ label: '进入本场会议', url: safeFeishuMeetingUrl(interview.meetingUrl) }] : []),
    ...(safeCalendarUrl(interview?.calendarUrl) ? [{ label: '查看飞书日程', url: safeCalendarUrl(interview.calendarUrl) }] : []),
  ];
  return urls.slice(0, 2).map((item, index) => ({
    tag: 'button', type: index ? 'default' : 'primary_filled', width: 'fill',
    text: { tag: 'plain_text', content: item.label }, behaviors: [{ type: 'open_url', default_url: item.url }],
  }));
}
function reportView(report) {
  const rules = normalizeEvaluationRules('interview_report', report.evaluationRules);
  const seen = new Set();
  if (array(report.dimensions).length !== rules.dimensions.length) throw fail('总结缺少完整的评分维度。');
  const dimensions = rules.dimensions.map(definition => {
    const row = report.dimensions.find(item => item.key === definition.key);
    if (!row || row.weight !== definition.weight || seen.has(row.key)) throw fail('总结权重与报告保存的评分设置不一致。');
    seen.add(row.key);
    const score = row.score === null ? null : Number.isFinite(row.score) && row.score >= 0 && row.score <= 100 && array(row.evidence).length ? row.score : null;
    return { ...definition, score, reason: clip(row.reason, 100), weightedScore: score === null ? null : round(score * definition.weight / 100) };
  });
  const total = dimensions.every(row => row.score !== null) ? round(dimensions.reduce((sum, row) => sum + row.weightedScore, 0)) : null;
  return { dimensions, total };
}

/**
 * Card 2.0 / compact / turquoise (completed summary: green).
 * lark-im-card-create P0–P7: one focal result, 2–5 grouped visual blocks,
 * weighted columns, escaped source text, only official returned open_url links.
 * Report text is the already-normalized professional report, never transcripts.
 */
export function buildInterviewNotificationCard({ kind, interview = {}, candidate, requirement, report, assistanceEnabled = false, captureEnabled = false } = {}) {
  if (!kinds.has(kind)) throw fail('不支持的面试消息类型。');
  const person = clip(candidate?.name, 24), role = clip(requirement?.title, 32);
  const subtitle = [person, role, clip(interview.round, 12)].filter(Boolean).join(' · ') || clip(interview.title, 60) || '本场面试';
  let title, summary, elements;
  const context = block([md(`**${esc(subtitle)}**`), md(`<font color='grey'>${esc(timeLabel(interview))}</font>`, 'notation')]);
  if (kind === 'invitation') {
    title = '云咩咩 · 面试邀请'; summary = `${subtitle} · 面试已安排`;
    elements = [block([md('**已为你安排这场面试**', 'heading-3'), md(esc(timeLabel(interview))), md(`<font color='grey'>${esc(clip(interview.location, 80) || '通过飞书会议参加')}</font>`, 'notation')], 'turquoise-50'),
      block([md(`**${esc(subtitle)}**`), md('请按日程加入本场面试。已启用的面试资料与相关通知会在这里送达。', 'notation')]), ...buttons(interview)];
  } else if (kind === 'joined') {
    const active = assistanceEnabled === true && captureEnabled === true;
    title = '云咩咩 · 已加入会议'; summary = `${subtitle} · ${active ? '开始面试辅助' : '已加入本场会议'}`;
    elements = [block([md(active ? '**已加入，开始辅助面试**' : '**已加入本场会议**', 'heading-3'), md(active ? '我会结合岗位、候选资料和本场已取得的记录，整理关键追问与节奏建议。' : '本场持续辅助暂未开启。如需辅助，请联系HR在工作台开启会中读取与持续辅助。'), ...(active ? [md("<font color='grey'>仅在重要节点提醒，不逐句接话。</font>", 'notation')] : [])], 'turquoise-50'), context, ...buttons(interview)];
  } else if (kind === 'summarizing') {
    title = '云咩咩 · 正在整理总结'; summary = `${subtitle} · 会议已结束`;
    elements = [block([md('**会议已结束，正在整理总结**', 'heading-3'), md('将结合本场问答、岗位标准与候选资料，汇总评分依据和需要复核的问题。'), md("<font color='grey'>整理完成后，总结会直接送到这里。</font>", 'notation')], 'turquoise-50'), context];
  } else {
    if (!report || report.interviewId !== interview.id || (report.candidateId && interview.candidateId !== report.candidateId) || (report.requirementId && interview.requirementId !== report.requirementId)) throw fail('面试总结与本场候选人或岗位不一致。');
    const view = reportView(report);
    title = '云咩咩 · 面试总结'; summary = `${subtitle} · ${view.total === null ? '资料不足，暂不完整评分' : `本场加权参考 ${view.total}/100`}`;
    const metrics = { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns: view.dimensions.map(row => ({
      tag: 'column', width: 'weighted', weight: 1, background_style: 'grey-50', padding: '8px', vertical_spacing: '4px',
      elements: [md(`**${row.score === null ? '待核验' : `${row.score}/100`}**`, 'normal', { text_align: 'center' }), md(esc(row.label), 'notation', { text_align: 'center' }), md(`<font color='grey'>权重 ${row.weight}%</font>`, 'notation', { text_align: 'center' })],
    })) };
    const reasons = view.dimensions.map(row => md(`**${esc(row.label)}**\n${esc(row.reason || '缺少本场可归属的回答依据，保留待核验。')}`, 'notation'));
    const discussion = report.discussion || {}, topics = array(discussion.topics).slice(0, 6), openQuestions = array(discussion.openQuestions).slice(0, 4), nextRound = array(discussion.nextRoundFocus).slice(0, 4);
    const followUps = array(report.followUps).filter(item => typeof item === 'string' && item.trim()).slice(0, 2);
    const hasDiscussion = topics.length || openQuestions.length || nextRound.length;
    if (hasDiscussion) {
      const quoted = rows => array(rows).slice(0, 1).map(row => md(`<font color='grey'>原话：${esc(clip(row.quote, 180))}</font>`, 'notation'));
      const details = [block([md('**评分依据**'), ...reasons]),
        ...topics.map(row => block([md(`**${esc(row.title)}**`), md(esc(row.summary), 'notation'), ...quoted(row.evidence)])),
        ...(openQuestions.length ? [block([md('**没谈清的事**'), ...openQuestions.flatMap(row => [md(esc(row.question)), ...(text(row.reason) ? [md(esc(row.reason), 'notation')] : []), ...quoted(row.evidence)])])] : []),
        ...(nextRound.length ? [block([md('**下一轮交接**'), ...nextRound.flatMap(row => [md(esc(row.question)), ...(text(row.purpose) ? [md(esc(row.purpose), 'notation')] : []), ...quoted(row.evidence)])])] : []),
      ];
      elements = [block([md(view.total === null ? '**资料不足，暂不完整评分**' : `**本场加权参考 ${view.total} / 100**`, 'heading-3'), md(esc(clip(report.summary, 150))), ...topics.slice(0, 2).map(row => md(`**${esc(clip(row.title, 24))}** · ${esc(clip(row.summary, 90))}`, 'notation'))], 'green-50'), metrics,
        ...(nextRound.length ? [block([md('**下一轮接着问**'), md(esc(nextRound[0].question))], 'turquoise-50')] : []),
        folded('展开话题、评分依据与交接', details), ...buttons(interview, { meeting: false })];
    } else {
      elements = [block([md(view.total === null ? '**资料不足，暂不完整评分**' : `**本场加权参考 ${view.total} / 100**`, 'heading-3'), md(esc(clip(report.summary, 150))), md("<font color='grey'>依据本场已取得材料，供面试官复核。</font>", 'notation')], 'green-50'), metrics, block(reasons),
        ...(followUps.length ? [block([md('**建议补充核对**'), ...followUps.map((item, index) => md(`${index + 1}. ${esc(clip(item, 100))}`, 'notation'))])] : []), ...buttons(interview, { meeting: false })];
    }
  }
  const card = {
    schema: '2.0', config: { update_multi: true, width_mode: 'compact', enable_forward: false, summary: { content: clip(summary, 100) } },
    header: { title: { tag: 'plain_text', content: title }, subtitle: { tag: 'plain_text', content: subtitle }, template: kind === 'summary' ? 'green' : 'turquoise', icon: { tag: 'standard_icon', token: 'myai_colorful' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements },
  };
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 24000) throw fail('面试通知内容过长，未发送。');
  return card;
}

export function interviewNotificationBinding(input = {}) {
  const { kind, interview = {}, report } = input;
  if (!kinds.has(kind) || !text(interview.id) || !text(interview.eventId) || !text(interview.calendarId)) throw fail('消息缺少本场已确认的日程范围。');
  const meetingId = input.meetingId || interview.autoJoin?.meetingId || interview.liveSession?.meetingId || '';
  if (kind !== 'invitation' && !text(meetingId)) throw fail('会中与会后消息必须关联本场明确会议。');
  if (input.meetingId && [interview.autoJoin?.meetingId, interview.liveSession?.meetingId].filter(Boolean).some(id => id !== input.meetingId)) throw fail('通知会议与本场已绑定会议不一致。');
  if (kind === 'summary' && (!text(report?.id) || report.interviewId !== interview.id)) throw fail('总结缺少本场报告标识。');
  return { kind, interviewId: interview.id, applicationId: interview.applicationId || '', candidateId: interview.candidateId || '', requirementId: interview.requirementId || '', calendarId: interview.calendarId, eventId: interview.eventId, meetingId, reportId: kind === 'summary' ? report.id : '' };
}

export async function sendInterviewNotification(input = {}, { runner = runLark } = {}) {
  const connection = normalizeLarkConnection(input.connection);
  if (connection.identity !== 'bot' || !connection.profile || !connection.appId || !/^ou_[A-Za-z0-9_-]{1,200}$/.test(input.recipientOpenId || '') || !text(input.operationId)) throw fail('面试消息需要当前应用和已确认的飞书接收人。', 'invalid_notification_recipient');
  if (!input.interview?.feishuConnection || !sameLarkConnection(input.interview.feishuConnection, connection)) throw fail('本场日程不属于当前飞书应用。', 'calendar_context_mismatch');
  const binding = interviewNotificationBinding(input), card = buildInterviewNotificationCard(input);
  const idempotencyKey = `hrnotify_${digest(JSON.stringify([binding, connection, input.recipientOpenId])).slice(0, 40)}`;
  try {
    const result = await runner(larkArguments(['im', '+messages-send', '--user-id', input.recipientOpenId, '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', idempotencyKey, '--format', 'json'], connection), { write: true, timeoutMs: 60000 });
    const data = result?.data ?? result, messageId = data?.message_id || data?.message?.message_id;
    if (result?.ok === false || (result?.identity && result.identity !== 'bot') || typeof messageId !== 'string' || !messageId) throw fail('面试消息未取得可确认的送达回执，未自动重发。', 'unknown_delivery');
    return { status: 'sent', kind: input.kind, operationId: input.operationId, messageId, recipientOpenId: input.recipientOpenId, feishuConnection: connection, idempotencyKey, binding };
  } catch (error) { throw withLarkErrorContext(error, connection); }
}
