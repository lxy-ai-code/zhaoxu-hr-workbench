import { uid } from './store.mjs';
import { normalizeLarkConnection, sameLarkConnection } from './lark-context.mjs';
import { normalizeRecipientList, validateNotificationSettings, resolveInterviewRecipients, notificationEnabled } from './interview-recipients.mjs';

export const DEFAULT_INTERVIEW_AUTOMATION = Object.freeze({ enabled: false, defaultReminderMinutes: 30, reminderRecipientOpenId: '', meetingOwnerOpenId: '', pollSeconds: 20 });
const terminal = new Set(['sent', 'joined', 'unknown_delivery', 'failed', 'cancelled', 'expired', 'ended']);
const localPreconditionErrors = new Set(['not_configured', 'invalid_connection', 'bot_connection_required', 'calendar_context_mismatch', 'calendar_not_synced', 'recipient_not_configured', 'context_changed']);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const invalid = message => Object.assign(new Error(message), { code: 'invalid_interview_automation', statusCode: 400 });
const clean = value => String(value || '').replace(/https?:\/\/\S+/g, '[链接已省略]').replace(/(?:Bearer\s+|(?:token|cookie|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '[凭据已省略]').slice(0, 500);
const errorInfo = error => ({ code: error?.code || error?.status || 'operation_failed', message: clean(error?.message || '本次操作未完成。') });
const configOf = state => ({ ...DEFAULT_INTERVIEW_AUTOMATION, ...state.settings?.interviewAutomation });
const cancelled = row => ['cancelled', 'canceled', 'deleted'].includes(row.status) || ['cancelled', 'canceled', 'deleted'].includes(row.calendarStatus);
const finished = row => ['completed', 'finished', 'ended'].includes(row.status);
const iso = value => new Date(value).toISOString();
const receiptOf = (row, key) => key === 'testReceipt' ? row.reminder?.testReceipt : row[key];
function setReceipt(row, key, receipt) { if (key === 'testReceipt') row.reminder.testReceipt = receipt; else row[key] = receipt; }

export function validateInterviewAutomationSettings(input = {}, previous = DEFAULT_INTERVIEW_AUTOMATION) {
  const result = { ...DEFAULT_INTERVIEW_AUTOMATION, ...previous };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('面试自动化配置无效。');
  if (Object.hasOwn(input, 'enabled')) { if (typeof input.enabled !== 'boolean') throw invalid('面试自动化开关必须为布尔值。'); result.enabled = input.enabled; }
  if (Object.hasOwn(input, 'defaultReminderMinutes')) {
    if (!Number.isInteger(input.defaultReminderMinutes) || input.defaultReminderMinutes < 0 || input.defaultReminderMinutes > 10080) throw invalid('提前提醒时间应为 0–10080 的整数分钟。');
    result.defaultReminderMinutes = input.defaultReminderMinutes;
  }
  if (Object.hasOwn(input, 'pollSeconds')) {
    if (!Number.isInteger(input.pollSeconds) || input.pollSeconds < 5 || input.pollSeconds > 20) throw invalid('会议检测间隔应为 5–20 的整数秒。');
    result.pollSeconds = input.pollSeconds;
  }
  for (const key of ['reminderRecipientOpenId', 'meetingOwnerOpenId']) if (Object.hasOwn(input, key)) {
    const value = input[key];
    if (typeof value !== 'string' || (value && !/^ou_[A-Za-z0-9_-]{1,200}$/.test(value))) throw invalid('提醒接收人和会议发起人应使用当前应用的 open_id。');
    result[key] = value;
  }
  for (const key of ['recipientDirectory','defaultNotificationRecipients']) if(Object.hasOwn(input,key))result[key]=normalizeRecipientList(input[key]);
  if(Object.hasOwn(input,'defaultNotificationSettings'))result.defaultNotificationSettings=validateNotificationSettings(input.defaultNotificationSettings,previous.defaultNotificationSettings);
  return result;
}

export function validateInterviewAutomationInput(input = {}, config = DEFAULT_INTERVIEW_AUTOMATION) {
  const result = { reminderEnabled: config.defaultNotificationSettings?.preparation!==false, reminderMinutes: config.defaultReminderMinutes ?? 30, autoJoinEnabled: false };
  for (const key of ['reminderEnabled', 'autoJoinEnabled']) if (Object.hasOwn(input, key)) {
    if (typeof input[key] !== 'boolean') throw invalid('本场提醒和自动入会开关必须为布尔值。');
    result[key] = input[key];
  }
  if (Object.hasOwn(input, 'reminderMinutes')) result.reminderMinutes = input.reminderMinutes;
  if (!Number.isInteger(result.reminderMinutes) || result.reminderMinutes < 0 || result.reminderMinutes > 10080) throw invalid('提前提醒时间应为 0–10080 的整数分钟。');
  if(Object.hasOwn(input,'notificationRecipients'))result.notificationRecipients=normalizeRecipientList(input.notificationRecipients);
  if(Object.hasOwn(input,'notificationSettings')){
    result.notificationSettings=validateNotificationSettings(input.notificationSettings,config.defaultNotificationSettings);
    result.reminderEnabled=result.notificationSettings.preparation;
  }
  if(Object.hasOwn(input,'meetingOwnerOpenId')){
    if(typeof input.meetingOwnerOpenId!=='string'||input.meetingOwnerOpenId&&!/^ou_[A-Za-z0-9_-]{1,200}$/.test(input.meetingOwnerOpenId))throw invalid('本场会议发起人应使用当前应用的open_id。');
    result.meetingOwnerOpenId=input.meetingOwnerOpenId;
  }
  return result;
}

/** Call only for a newly and explicitly scheduled interview, never as a migration. */
export function initializeInterviewAutomation(interview, config = DEFAULT_INTERVIEW_AUTOMATION, { now = Date.now() } = {}) {
  Object.assign(interview, validateInterviewAutomationInput(interview, config));
  const due = date(interview.startAt) - interview.reminderMinutes * 60000;
  interview.reminder = { dueAt: Number.isFinite(due) ? iso(due) : null, status: interview.reminderEnabled ? 'scheduled' : 'disabled', createdAt: iso(now) };
  interview.autoJoin = { status: interview.autoJoinEnabled ? 'waiting' : 'disabled', createdAt: iso(now) };
  return interview;
}

/** Existing rows are not implicitly opted into sending or joining on upgrade. */
export function ensureInterviewAutomationState(state, { now = Date.now() } = {}) {
  const before = JSON.stringify({ settings: state.settings?.interviewAutomation, rows: state.interviews?.map(row => [row.reminderEnabled, row.reminderMinutes, row.autoJoinEnabled, row.reminder, row.autoJoin]) });
  state.settings ??= {};
  state.settings.interviewAutomation = configOf(state);
  for (const row of state.interviews || []) {
    row.reminderEnabled ??= false;
    row.autoJoinEnabled ??= false;
    row.reminderMinutes ??= state.settings.interviewAutomation.defaultReminderMinutes;
    const due = date(row.startAt) - row.reminderMinutes * 60000;
    row.reminder ??= { status: row.reminderEnabled ? 'scheduled' : 'disabled', createdAt: iso(now) };
    if (!terminal.has(row.reminder.status) && row.reminder.status !== 'sending') row.reminder.dueAt = Number.isFinite(due) ? iso(due) : null;
    row.autoJoin ??= { status: row.autoJoinEnabled ? 'waiting' : 'disabled', createdAt: iso(now) };
  }
  const after = JSON.stringify({ settings: state.settings.interviewAutomation, rows: state.interviews?.map(row => [row.reminderEnabled, row.reminderMinutes, row.autoJoinEnabled, row.reminder, row.autoJoin]) });
  return before !== after;
}

function currentConnection(state, row) {
  const value = state.settings?.feishuConnection;
  if (!value) throw Object.assign(new Error('请先配置当前 HR 飞书机器人应用。'), { code: 'not_configured' });
  const connection = normalizeLarkConnection(value);
  if (connection.identity !== 'bot' || !connection.profile || !connection.appId) throw Object.assign(new Error('自动提醒和入会仅使用当前 HR 应用的机器人身份。'), { code: 'bot_connection_required' });
  if (!row.feishuConnection || !sameLarkConnection(connection, row.feishuConnection)) throw Object.assign(new Error('本场日程不属于当前 HR 飞书应用，请先核对日程。'), { code: 'calendar_context_mismatch' });
  if (row.calendarStatus !== 'synced' || !row.eventId) throw Object.assign(new Error('本场飞书日程尚未确认创建成功。'), { code: 'calendar_not_synced' });
  return connection;
}

function blocked(state, row, kind, time, { test = false } = {}) {
  if (!state.settings.interviewAutomation.enabled && !test) return { status: 'disabled' };
  if (cancelled(row)) return { status: 'cancelled' };
  const reminderDeadline = date(row.startAt) + (row.reminderMinutes === 0 ? configOf(state).pollSeconds * 1000 : 0);
  if (finished(row) || !Number.isFinite(date(row.startAt)) || !Number.isFinite(date(row.endAt)) || date(row.endAt) <= date(row.startAt) || time >= date(row.endAt) || (!test && kind === 'reminder' && time >= reminderDeadline)) return { status: 'expired' };
  if (!test && !row[kind === 'reminder' ? 'reminderEnabled' : 'autoJoinEnabled']) return { status: 'disabled' };
  try { currentConnection(state, row); } catch (error) { return { status: 'blocked', error: errorInfo(error) }; }
  const config = configOf(state);
  if(kind==='reminder'&&!notificationEnabled(state,row,'preparation'))return {status:'disabled'};
  if (!(kind==='reminder'?resolveInterviewRecipients(state,row,'preparation').length:row.meetingOwnerOpenId||config.meetingOwnerOpenId)) return { status: 'blocked', error: { code: 'recipient_not_configured', message: kind === 'reminder' ? '请先选择本场接收面试消息的面试官。' : '请先选择本场会议发起人。' } };
  return null;
}

/**
 * Persistent, serial scheduler. A durable operation marker precedes each
 * external side effect; interruption or an ambiguous receipt is never retried.
 * Calendar reads may repeat, but only for this explicitly opted-in event.
 */
export function createInterviewAutomation({ store, services, clock = Date.now, tickMs = 20000 } = {}) {
  if (!store?.read || !store?.mutate) throw new Error('Interview automation requires a persistent Store.');
  if (!services?.sendReminder || !services?.getCalendarMeeting || !services?.joinMeeting) throw new Error('Interview automation requires reminder, calendar meeting and join services.');
  let tail = Promise.resolve(), pending = 0, running = null, started = false, desiredStarted = false, timer = null, recovered = false, startPromise = null;
  const at = () => iso(clock());
  const write = fn => store.mutate(state => { ensureInterviewAutomationState(state, { now: clock() }); return fn(state); });
  function serial(fn) {
    pending++;
    const task = tail.then(fn).finally(() => { pending--; });
    tail = task.catch(() => {});
    return task;
  }
  async function recover() {
    if (recovered) return;
    const snapshot = store.read();
    const needsMigration = ensureInterviewAutomationState(snapshot, { now: clock() });
    const needsRecovery = (snapshot.interviews || []).some(row => ['reminder', 'autoJoin', 'testReceipt'].some(key => ['sending', 'joining'].includes(receiptOf(row, key)?.status)));
    if (!needsMigration && !needsRecovery) { recovered = true; return; }
    await write(state => {
      for (const row of state.interviews || []) for (const key of ['reminder', 'autoJoin', 'testReceipt']) {
        const receipt = receiptOf(row, key);
        if (['sending', 'joining'].includes(receipt?.status)) Object.assign(receipt, { status: 'unknown_delivery', updatedAt: at(), error: { code: 'interrupted', message: '服务在回执确认前停止；请到飞书人工核实，本次不会自动重试。' } });
      }
    });
    recovered = true;
  }
  function status() {
    const state = store.read(), settings = configOf(state);
    const counts = { remindersPending: 0, meetingsWaiting: 0, unknown: 0, blocked: 0 };
    for (const row of state.interviews || []) {
      if (row.reminderEnabled && !terminal.has(row.reminder?.status)) counts.remindersPending++;
      if (row.autoJoinEnabled && !terminal.has(row.autoJoin?.status)) counts.meetingsWaiting++;
      for (const key of ['reminder', 'autoJoin', 'testReceipt']) { if (receiptOf(row, key)?.status === 'unknown_delivery') counts.unknown++; if (receiptOf(row, key)?.status === 'blocked') counts.blocked++; }
    }
    return { settings, enabled: settings.enabled, running: pending > 0, started, status: pending ? 'running' : settings.enabled ? 'scheduled' : 'disabled', queue: counts, runtime: 'while_workbench_server_running' };
  }
  async function configure(input = {}) {
    await write(state => {
      const next=validateInterviewAutomationSettings(input, configOf(state));
      if(state.settings.feishuConnection){
        const connection=normalizeLarkConnection(state.settings.feishuConnection);
        if(Object.hasOwn(input,'recipientDirectory'))next.recipientDirectoryConnection=connection;
        if(Object.hasOwn(input,'defaultNotificationRecipients'))next.defaultNotificationRecipientsConnection=connection;
      }
      state.settings.interviewAutomation=next;
    });
    if (started) scheduleTimer();
    return status();
  }
  function scheduleTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { tick().catch(() => {}); }, Math.max(1000, Math.min(20000, tickMs, configOf(store.read()).pollSeconds * 1000))); timer.unref?.();
  }
  async function updateReceipt(id, key, operationId, values) {
    await write(state => {
      const row = state.interviews?.find(item => item.id === id);
      if (!row || receiptOf(row, key)?.operationId !== operationId) return;
      Object.assign(receiptOf(row, key), values, { updatedAt: at() });
    });
  }
  async function reminder(id, { test = false } = {}) {
    const key = test ? 'testReceipt' : 'reminder';
    const claim = await write(state => {
      const row = state.interviews?.find(item => item.id === id);
      if (!row) { if (test) throw Object.assign(new Error('面试场次不存在。'), { statusCode: 404 }); return null; }
      if (receiptOf(row, key)?.operationId || terminal.has(receiptOf(row, key)?.status)) return { reused: true, receipt: structuredClone(receiptOf(row, key)) };
      if (!test && date(row.reminder.dueAt) > clock()) {
        if (row.reminder.status === 'blocked' && localPreconditionErrors.has(row.reminder.error?.code) && !blocked(state, row, 'reminder', clock())) Object.assign(row.reminder, { status: 'scheduled', error: null, updatedAt: at() });
        return null;
      }
      const stop = blocked(state, row, 'reminder', clock(), { test });
      if (stop) { setReceipt(row, key, { ...receiptOf(row, key), ...stop, updatedAt: at() }); return { skipped: true, receipt: structuredClone(receiptOf(row, key)) }; }
      if (!test && !(date(row.reminder.dueAt) <= clock())) return null;
      const operationId = uid(test ? 'interview_test' : 'interview_reminder'), connection = currentConnection(state, row);
      setReceipt(row, key, { ...receiptOf(row, key), operationId, status: 'sending', attemptedAt: at(), feishuConnection: connection, error: null });
      return { interview: structuredClone(row), state: structuredClone(state), connection, operationId, recipientOpenId: resolveInterviewRecipients(state,row,'preparation')[0]?.openId };
    });
    if (!claim || claim.skipped || claim.reused) return claim;
    let values;
    try {
      const receipt = await services.sendReminder(claim.interview, claim.state, { connection: claim.connection, recipientOpenId: claim.recipientOpenId, operationId: claim.operationId, test });
      const messageId = receipt?.messageId || receipt?.message_id;
      if (!messageId || (receipt.feishuConnection && !sameLarkConnection(receipt.feishuConnection, claim.connection))) throw Object.assign(new Error('飞书未返回可确认且属于当前应用的消息回执，请人工核实。'), { code: 'unknown_delivery' });
      values = { status: 'sent', messageId, sentAt: at(), error: null, ...(receipt.attachmentStatus?{attachmentStatus:receipt.attachmentStatus,attachmentReceipts:receipt.attachmentReceipts||[]}: {}) };
    } catch (error) {
      values = { status: error?.definitelyNotSent === true ? 'failed' : 'unknown_delivery', error: errorInfo(error) };
    }
    await updateReceipt(id, key, claim.operationId, values);
    return { receipt: { operationId: claim.operationId, ...values } };
  }
  async function pollMeeting(id, { scheduled = false } = {}) {
    if (scheduled && !started) return null;
    const selected = await write(state => {
      const row = state.interviews?.find(item => item.id === id);
      if (!row || terminal.has(row.autoJoin?.status) || row.autoJoin?.operationId) return null;
      const windowAt = date(row.startAt) - 30 * 60000;
      if (clock() < windowAt) {
        if (row.autoJoin.status === 'blocked' && localPreconditionErrors.has(row.autoJoin.error?.code) && !blocked(state, row, 'autoJoin', clock())) Object.assign(row.autoJoin, { status: 'waiting', error: null, updatedAt: at() });
        return null;
      }
      const stop = blocked(state, row, 'autoJoin', clock());
      if (stop) { Object.assign(row.autoJoin, stop, { updatedAt: at() }); return null; }
      if (row.autoJoin.status === 'blocked' && localPreconditionErrors.has(row.autoJoin.error?.code)) Object.assign(row.autoJoin, { status: 'waiting', error: null, updatedAt: at() });
      if (date(row.autoJoin.nextCheckAt) > clock()) return null;
      row.autoJoin.lastCheckedAt = at();
      row.autoJoin.nextCheckAt = iso(clock() + configOf(state).pollSeconds * 1000);
      return { interview: structuredClone(row), state: structuredClone(state), connection: currentConnection(state, row), ownerOpenId: row.meetingOwnerOpenId||configOf(state).meetingOwnerOpenId };
    });
    if (!selected) return null;
    let meeting;
    try {
      meeting = await services.getCalendarMeeting(selected.interview, selected.state, { connection: selected.connection, ownerOpenId: selected.ownerOpenId });
      if (meeting?.feishuConnection && !sameLarkConnection(meeting.feishuConnection, selected.connection)) throw Object.assign(new Error('会议查询回执不属于当前 HR 应用。'), { code: 'calendar_context_mismatch' });
    } catch (error) {
      await write(state => { const row = state.interviews?.find(item => item.id === id); if (row && !terminal.has(row.autoJoin.status) && !row.autoJoin.operationId) Object.assign(row.autoJoin, { status: 'blocked', error: errorInfo(error), updatedAt: at() }); });
      return { status: 'blocked' };
    }
    const stateValue = meeting?.status;
    if (['cancelled', 'ended'].includes(stateValue)) {
      await write(state => { const row = state.interviews?.find(item => item.id === id); if (row && !terminal.has(row.autoJoin.status) && !row.autoJoin.operationId) Object.assign(row.autoJoin, { status: stateValue, updatedAt: at(), error: null }); });
      return { status: stateValue };
    }
    // The bot calendar API can expose only this event's meeting number. A
    // joinable result is allowed only through an adapter whose join action
    // cannot start a meeting; an explicit not_started receipt is safe to poll.
    if (!['started', 'active', 'joinable'].includes(stateValue) || (!meeting.meetingId && stateValue !== 'joinable') || !meeting.meetingNo) {
      await write(state => { const row = state.interviews?.find(item => item.id === id); if (row && !terminal.has(row.autoJoin.status) && !row.autoJoin.operationId) Object.assign(row.autoJoin, { status: 'waiting', updatedAt: at(), error: null }); });
      return { status: 'waiting' };
    }
    const claim = await write(state => {
      if (scheduled && !started) return null;
      const row = state.interviews?.find(item => item.id === id);
      if (!row || terminal.has(row.autoJoin.status) || row.autoJoin.operationId) return null;
      const stop = blocked(state, row, 'autoJoin', clock());
      if (stop || row.eventId !== selected.interview.eventId || !sameLarkConnection(state.settings.feishuConnection, selected.connection) || (row.meetingOwnerOpenId||configOf(state).meetingOwnerOpenId) !== selected.ownerOpenId) { Object.assign(row.autoJoin, stop || { status: 'blocked', error: { code: 'context_changed', message: '查询期间本场日程或飞书配置发生变化，请重新核对。' } }, { updatedAt: at() }); return null; }
      const operationId = uid('interview_join');
      Object.assign(row.autoJoin, { operationId, status: 'joining', attemptedAt: at(), meetingId: meeting.meetingId, meetingNo: meeting.meetingNo, feishuConnection: selected.connection, error: null });
      return { interview: structuredClone(row), state: structuredClone(state), operationId };
    });
    if (!claim) return null;
    let values;
    try {
      const receipt = await services.joinMeeting(claim.interview, claim.state, { connection: selected.connection, meetingId: meeting.meetingId, meetingNo: meeting.meetingNo, operationId: claim.operationId });
      if (receipt?.feishuConnection && !sameLarkConnection(receipt.feishuConnection, selected.connection)) throw Object.assign(new Error('飞书入会回执不属于当前 HR 应用，请人工核实。'), { code: 'unknown_delivery' });
      if (receipt?.status === 'not_started') values = { status: 'waiting', operationId: null, error: null };
      else if (receipt?.status === 'awaiting_approval') values = { status: 'awaiting_approval', error: null };
      else {
        if (!(receipt?.status === 'joined' && receipt?.joined === true && /^\d{15,25}$/.test(receipt?.meetingId || '')) || (meeting.meetingId && receipt.meetingId !== meeting.meetingId) || (receipt.meetingNo && receipt.meetingNo !== meeting.meetingNo)) throw Object.assign(new Error('飞书未返回可确认的本场入会回执，请人工核实。'), { code: 'unknown_delivery' });
        values = { status: 'joined', meetingId: receipt.meetingId, joinedAt: at(), error: null };
      }
    } catch (error) { values = { status: error?.definitelyNotJoined === true ? 'failed' : 'unknown_delivery', error: errorInfo(error) }; }
    await updateReceipt(id, 'autoJoin', claim.operationId, values);
    return { status: values.status };
  }
  async function execute({ scheduled = false } = {}) {
    await recover();
    if (!configOf(store.read()).enabled || (scheduled && !started)) return { status: 'disabled', reminders: [], meetings: [] };
    const result = { status: 'completed', reminders: [], meetings: [] };
    for (const row of store.read().interviews || []) {
      if (scheduled && !started) break;
      if (row.reminderEnabled) { const receipt = await reminder(row.id); if (receipt) result.reminders.push({ interviewId: row.id, ...receipt }); }
      if (row.autoJoinEnabled) { const receipt = await pollMeeting(row.id, { scheduled }); if (receipt) result.meetings.push({ interviewId: row.id, ...receipt }); }
    }
    return result;
  }
  function run({ trigger = 'manual' } = {}) {
    if (running) return running;
    running = serial(() => execute({ scheduled: trigger === 'scheduled' })).finally(() => { running = null; });
    return running;
  }
  async function tick() { if (started && !pending) return run({ trigger: 'scheduled' }); }
  function start() {
    desiredStarted = true;
    if (startPromise) return startPromise;
    if (started) return Promise.resolve(status());
    startPromise = serial(recover).then(() => {
      if (!desiredStarted) return status();
      started = true;
      scheduleTimer();
      tick().catch(() => {});
      return status();
    }).finally(() => { startPromise = null; });
    return startPromise;
  }
  function stop() { desiredStarted = false; started = false; if (timer) clearInterval(timer); timer = null; }
  function sendTestReminder(interviewId, options = {}) {
    if (options.action !== 'send_test_reminder') return Promise.reject(invalid('立即发送测试提醒需要明确的 send_test_reminder 操作。'));
    return serial(async () => { await recover(); const result = await reminder(interviewId, { test: true }); return { interviewId, test: true, ...result }; });
  }
  return { start, stop, tick, run, configure, status, sendTestReminder };
}
