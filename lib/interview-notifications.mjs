import { digest, uid } from './store.mjs';
import { normalizeLarkConnection, sameLarkConnection } from './lark-context.mjs';
import { resolveInterviewRecipients, notificationEnabled, recipientRosterKey } from './interview-recipients.mjs';

const phases = new Set(['invitation', 'preparation', 'joined', 'copilot', 'summarizing', 'summary']);
const settled = new Set(['sent', 'invited', 'failed', 'unknown_delivery', 'cancelled']);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const stamp = time => new Date(time).toISOString();
const cancelled = row => ['cancelled', 'canceled', 'deleted'].includes(row?.status) || ['cancelled', 'canceled', 'deleted'].includes(row?.calendarStatus);
const fail = (message, code = 'notification_context_mismatch') => Object.assign(new Error(message), { code, statusCode: 409 });
const safeError = error => ({
  code: /^[A-Za-z0-9_.:-]{1,100}$/.test(String(error?.code || '')) ? error.code : 'notification_failed',
  message: String(error?.message || '消息发送尚未完成。').replace(/https?:\/\/\S+/g, '[链接省略]').replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret|cookie)\s*[:=]\s*)[^\s,;]+/gi, '[凭据省略]').slice(0, 400),
});
const meetingIdOf = row => row.autoJoin?.meetingId || row.liveSession?.meetingId || null;
const phaseOf = kind => kind === 'calendar_invitation' ? 'invitation' : kind;
function connectionOf(state, row) {
  const connection = normalizeLarkConnection(state.settings?.feishuConnection);
  if (connection.identity !== 'bot' || !connection.profile || !connection.appId || !row.feishuConnection || !sameLarkConnection(row.feishuConnection, connection) || row.notifications?.connection && !sameLarkConnection(row.notifications.connection, connection)) throw fail('本场日程、接收人名单与当前机器人应用不一致。');
  if (row.calendarStatus !== 'synced' || !row.eventId) throw fail('本场飞书日程尚未取得明确创建回执。', 'calendar_not_synced');
  return connection;
}
function endEvidence(row, options) {
  if (options.endingBasis && !['confirmed_end', 'manual_confirmed_end'].includes(options.endingBasis)) return null;
  const evidence = Object.hasOwn(options, 'endingEvidence') ? options.endingEvidence : row.interviewReportTask?.endingEvidence || row.interviewReport?.endingEvidence;
  const validSource = evidence?.meetingStatus === 3 || ['live_capture_end_event', 'manual_interview_completion'].includes(evidence?.source);
  return validSource && evidence.meetingId === meetingIdOf(row) && timestamp(evidence.verifiedAt) > 0 ? evidence : null;
}
function exactReport(row, value) {
  const report = value || row.interviewReport;
  return report && report.id === row.interviewReport?.id && report.interviewId === row.id && report.applicationId === row.applicationId && report.candidateId === row.candidateId && report.requirementId === row.requirementId && ['confirmed_end', 'manual_confirmed_end'].includes(report.endingBasis) && report.endingEvidence?.meetingId === meetingIdOf(row) ? report : null;
}
function recipientPhasePassed(row, kind, options, recipientOpenId) {
  const addedAt = Math.max(timestamp(row.notifications?.recipientAddedAt?.[recipientOpenId]), timestamp(row.notifications?.stageEnabledAt?.[kind]), timestamp(row.notifications?.enabledAt));
  const eventAt = kind === 'joined' ? timestamp(row.autoJoin?.joinedAt)
    : kind === 'summary' ? timestamp((options.report || row.interviewReport)?.createdAt)
      : kind === 'summarizing' ? timestamp(endEvidence(row, options)?.verifiedAt) : 0;
  return addedAt > 0 && eventAt > 0 && eventAt < addedAt;
}
function eligible(state, row, kind, options, now) {
  if (!row || !phases.has(kind)) return '消息阶段或面试场次无效。';
  if (!options.test && !options.manual && state.settings?.interviewAutomation?.enabled !== true) return '面试自动通知已暂停。';
  if (!notificationEnabled(state, row, kind)) return '本场未启用该阶段消息或未选择接收人。';
  if (cancelled(row)) return '本场面试已取消。';
  try { connectionOf(state, row); } catch (error) { return error.message; }
  if (['invitation', 'preparation', 'joined', 'copilot'].includes(kind) && (!timestamp(row.endAt) || now >= timestamp(row.endAt) || ['completed', 'finished', 'ended'].includes(row.status))) return '本场会前或会中消息已过期。';
  if (kind === 'joined') {
    if (row.notifications?.enabled !== true || row.autoJoin?.status !== 'joined' || !timestamp(row.autoJoin.joinedAt) || timestamp(row.autoJoin.joinedAt) < timestamp(row.notifications.enabledAt) || !sameLarkConnection(row.autoJoin.feishuConnection, state.settings.feishuConnection) || !/^\d{10,25}$/.test(meetingIdOf(row) || '')) return '等待本场机器人已入会的明确回执。';
  }
  if (kind === 'summarizing' && (row.notifications?.enabled !== true || row.interviewReportTask?.status !== 'analyzing' || !endEvidence(row, options))) return '等待本场已结束的依据和实际开始分析的状态。';
  if (kind === 'summary') {
    const report = exactReport(row, options.report);
    if (row.notifications?.enabled !== true || !report || timestamp(report.createdAt) < timestamp(row.notifications.enabledAt) || report.id === row.notifications.baseline?.reportId) return '等待本次启用通知后生成的正式结束报告。';
  }
  return '';
}
function contentKey(row, kind, options) {
  if (options.contentKey !== undefined) return String(options.contentKey).slice(0, 300);
  if (kind === 'summary') return String((options.report || row.interviewReport)?.id || '');
  if (kind === 'copilot') return digest(JSON.stringify(options.decision || {}));
  return '';
}
function scopeOf(connection, row, kind, recipientOpenId, options) {
  return { connection, interviewId: row.id, applicationId: row.applicationId, candidateId: row.candidateId, requirementId: row.requirementId,
    eventId: row.eventId, calendarId: row.calendarId || null,
    meetingId: ['joined', 'copilot', 'summarizing', 'summary'].includes(kind) ? meetingIdOf(row) : null,
    kind, recipientOpenId, contentKey: contentKey(row, kind, options), test: options.test === true,
  };
}
const publicReceipt = row => ({ ...structuredClone(row), ...(row.connection ? { feishuConnection: row.connection } : {}) });
function aggregate(receipts, connection, reason = '') {
  const sent = receipts.filter(row => ['sent', 'invited'].includes(row.status));
  const uncertain = receipts.some(row => ['sending', 'unknown_delivery'].includes(row.status));
  const status = receipts.length && sent.length === receipts.length ? 'sent' : sent.length ? 'partial' : uncertain ? 'unknown_delivery' : 'skipped';
  const first = sent.find(row => row.messageId) || receipts.find(row => row.messageId);
  return { status, ...(first?.messageId ? { messageId: first.messageId } : {}), recipientReceipts: receipts.map(publicReceipt),
    ...(connection ? { feishuConnection: connection } : {}), ...(receipts[0] ? { recipientOpenId: receipts[0].recipientOpenId } : {}), ...(reason ? { reason } : {}),
    reused: receipts.length > 0 && receipts.every(row => row.reused === true),
  };
}

/** Per-recipient durable delivery. No transport is called inside Store.mutate. */
export function createInterviewNotifications({ store, services = {}, clock = Date.now, tickMs = 20000 } = {}) {
  if (!store?.read || !store?.mutate) throw new Error('Interview notifications require a persistent store.');
  let started = false, timer = null, running = null, recovered = false;
  const inflight = new Map();
  const interviewOf = (state, id) => state.interviews?.find(row => row.id === id);
  async function recover() {
    if (recovered) return;
    if (store.read().interviews?.some(row => row.notifications?.deliveries?.some(item => item.status === 'sending'))) await store.mutate(state => {
      for (const row of state.interviews || []) for (const item of row.notifications?.deliveries || []) if (item.status === 'sending') Object.assign(item, { status: 'unknown_delivery', updatedAt: stamp(clock()), error: { code: 'interrupted', message: '服务在送达回执前中断，请到飞书核验；本次不自动重发。' } });
    });
    recovered = true;
  }
  function status() {
    const state = store.read(), counts = { sent: 0, failed: 0, unknown: 0, sending: 0 };
    for (const row of state.interviews || []) for (const delivery of row.notifications?.deliveries || []) {
      if (['sent', 'invited'].includes(delivery.status)) counts.sent++;
      else if (delivery.status === 'failed') counts.failed++;
      else if (delivery.status === 'unknown_delivery') counts.unknown++;
      else if (delivery.status === 'sending') counts.sending++;
    }
    return { started, running: inflight.size > 0, enabled: state.settings?.interviewAutomation?.enabled === true, queue: counts };
  }
  async function updateReceipt(id, deliveryKey, fn) {
    return store.mutate(state => { const delivery = interviewOf(state, id)?.notifications?.deliveries?.find(row => row.deliveryKey === deliveryKey); if (delivery) { fn(delivery); delivery.updatedAt = stamp(clock()); } });
  }
  async function oneRecipient(id, kind, recipient, options, roster, expectedConnection) {
    const phase = phaseOf(kind);
    const claim = await store.mutate(state => {
      const row = interviewOf(state, id), reason = eligible(state, row, phase, options, clock());
      if (reason || recipientRosterKey(state, row, phase) !== roster) return { skipped: true, reason: reason || '本场接收人已变化。' };
      if (recipientPhasePassed(row, phase, options, recipient.openId)) return { skipped: true, reason: '该阶段发生于本接收人加入之前，不补发历史状态。' };
      const connection = connectionOf(state, row);
      if (!sameLarkConnection(connection, expectedConnection)) return { skipped: true, reason: '本场飞书应用已变化。' };
      const scope = scopeOf(connection, row, kind, recipient.openId, options), deliveryKey = digest(JSON.stringify(scope));
      row.notifications ??= { enabled: true, legacyOnly: true, deliveries: [] };
      row.notifications.deliveries ??= [];
      const prior = row.notifications.deliveries.find(item => item.deliveryKey === deliveryKey);
      if (prior && (settled.has(prior.status) || prior.status === 'sending')) return { reused: true, receipt: { ...structuredClone(prior), reused: true } };
      const operationId = prior?.operationId || uid('interview_message');
      const entry = { deliveryKey, scope, kind, recipientOpenId: recipient.openId, recipientName: recipient.name, connection, operationId,
        ...(options.operationId ? { parentOperationId: String(options.operationId).slice(0, 200) } : {}), status: 'sending', attemptedAt: stamp(clock()), test: options.test === true,
      };
      row.notifications.deliveries.push(entry);
      return { row: structuredClone(row), state: structuredClone(state), connection, operationId, deliveryKey };
    });
    if (claim.receipt) return claim.receipt;
    if (claim.skipped) return { kind, recipientOpenId: recipient.openId, status: 'cancelled', reason: claim.reason, reused: false };
    // The claim is durable; a second state check occurs immediately before I/O.
    const latest = store.read(), current = interviewOf(latest, id);
    if (eligible(latest, current, phase, options, clock()) || recipientPhasePassed(current, phase, options, recipient.openId) || recipientRosterKey(latest, current, phase) !== roster || !sameLarkConnection(connectionOf(latest, current), claim.connection)) {
      await updateReceipt(id, claim.deliveryKey, receipt => Object.assign(receipt, { status: 'cancelled', error: { code: 'context_changed', message: '发送前本场接收人或应用发生变化，未发送。' } }));
      return publicReceipt(interviewOf(store.read(), id).notifications.deliveries.find(row => row.deliveryKey === claim.deliveryKey));
    }
    const args = { kind, interview: claim.row, state: claim.state,
      candidate: claim.state.candidates?.find(row => row.id === claim.row.candidateId), requirement: claim.state.requirements?.find(row => row.id === claim.row.requirementId),
      document: claim.state.documents?.find(row => row.id === claim.row.documentId), report: options.report || claim.row.interviewReport,
      recipientOpenId: recipient.openId, recipientName: recipient.name, connection: claim.connection, operationId: claim.operationId,
      test: options.test === true, decision: options.decision, input: options.input,
      captureEnabled: claim.state.settings?.interviewAutomation?.liveCaptureEnabled === true,
      assistanceEnabled: claim.state.settings?.interviewCopilot?.enabled === true && claim.state.settings?.interviewAutomation?.liveCaptureEnabled === true,
    };
    try {
      const sender = kind === 'calendar_invitation' ? services.inviteCalendarRecipient : kind === 'preparation' ? services.sendPreparation : services.send;
      const calendarConfirmed = kind === 'calendar_invitation' && current.calendarInviteeIds?.includes(recipient.openId);
      if (!calendarConfirmed && typeof sender !== 'function') throw Object.assign(new Error('本阶段的机器人消息发送能力尚未配置。'), { code: 'notification_transport_unavailable', definitelyNotSent: true });
      const receipt = calendarConfirmed
        ? { status: 'invited', eventId: current.eventId, calendarId: current.calendarId, recipientOpenId: recipient.openId, feishuConnection: claim.connection, source: 'calendar_create_receipt' }
        : await sender(args);
      if (receipt?.recipientOpenId !== recipient.openId || !sameLarkConnection(receipt.feishuConnection, claim.connection)
        || (kind === 'calendar_invitation' ? receipt.status !== 'invited' || receipt.eventId !== current.eventId || receipt.calendarId !== current.calendarId : receipt.status !== 'sent' || !receipt.messageId)) throw fail('消息或日程邀请回执未精确匹配本场接收人和机器人应用，请人工核验。', 'unknown_delivery');
      await updateReceipt(id, claim.deliveryKey, target => Object.assign(target, receipt, { status: kind === 'calendar_invitation' ? 'invited' : 'sent', sentAt: stamp(clock()), error: null }));
    } catch (error) {
      await updateReceipt(id, claim.deliveryKey, target => Object.assign(target, { status: error.definitelyNotSent === true ? 'failed' : 'unknown_delivery', error: safeError(error) }));
    }
    return publicReceipt(interviewOf(store.read(), id).notifications.deliveries.find(row => row.deliveryKey === claim.deliveryKey));
  }
  async function executeDelivery(id, kind, options) {
    await recover();
    const snapshot = store.read(), row = interviewOf(snapshot, id);
    const reason = eligible(snapshot, row, kind, options, clock());
    if (reason) return aggregate([], null, reason);
    const connection = connectionOf(snapshot, row), roster = recipientRosterKey(snapshot, row, kind), recipients = resolveInterviewRecipients(snapshot, row, kind), receipts = [];
    for (const recipient of recipients) {
      if (kind === 'invitation' && row.calendarBinding?.source !== 'existing_event' && (typeof services.inviteCalendarRecipient === 'function' || row.calendarInviteeIds?.includes(recipient.openId))) {
        const native = await oneRecipient(id, 'calendar_invitation', recipient, options, roster, connection);
        if (native.status !== 'invited') { receipts.push(native); continue; }
      }
      receipts.push(await oneRecipient(id, kind, recipient, options, roster, connection));
    }
    return aggregate(receipts, connection);
  }
  function deliver(id, kind, options = {}) {
    if (!phases.has(kind)) return Promise.reject(fail('未识别的面试消息阶段。', 'invalid_notification_kind'));
    const row = interviewOf(store.read(), id), key = JSON.stringify([id, kind, contentKey(row || {}, kind, options), options.test === true]);
    if (inflight.has(key)) return inflight.get(key);
    const task = executeDelivery(id, kind, options).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }
  async function execute() {
    await recover();
    if (!started || store.read().settings?.interviewAutomation?.enabled !== true) return status();
    for (const row of store.read().interviews || []) {
      if (!started) break;
      if (row.notifications?.enabled !== true || !timestamp(row.notifications.enabledAt)) continue;
      for (const kind of ['invitation', 'joined', 'summary']) {
        if (!started) break;
        try { await deliver(row.id, kind); } catch {}
      }
    }
    return status();
  }
  function run() {
    if (running) return running;
    if (!started) return Promise.resolve(status());
    running = execute().finally(() => { running = null; });
    return running;
  }
  async function start() {
    await recover();
    if (started) return status();
    started = true;
    timer = setInterval(() => { void run().catch(() => {}); }, Math.max(1000, tickMs)); timer.unref?.();
    void run().catch(() => {});
    return status();
  }
  function stop() { started = false; if (timer) clearInterval(timer); timer = null; }
  return { start, stop, run, status, deliver };
}
