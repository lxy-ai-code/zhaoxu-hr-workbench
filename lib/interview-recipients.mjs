import { digest } from './store.mjs';
import { normalizeLarkConnection, sameLarkConnection } from './lark-context.mjs';

export const NOTIFICATION_KINDS = Object.freeze(['invitation', 'preparation', 'joined', 'copilot', 'summarizing', 'summary']);
export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze(Object.fromEntries(NOTIFICATION_KINDS.map(kind => [kind, true])));
const owns = (value, key) => value && Object.hasOwn(value, key);
const fail = message => Object.assign(new Error(message), { code: 'invalid_interview_recipients', statusCode: 400 });
const configOf = settings => settings?.interviewAutomation || settings || {};
const validOpenId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{1,200}$/.test(value);

export function normalizeRecipientList(value) {
  if (!Array.isArray(value) || value.length > 20) throw fail('请选择不超过20位本场面试消息接收人。');
  const result = new Map();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['openId', 'name'].includes(key)) || !validOpenId(row.openId)) throw fail('消息接收人应包含当前应用识别的飞书 open_id。');
    const name = row.name === undefined ? '' : row.name;
    if (typeof name !== 'string' || name.length > 100 || /[<>\p{Cc}]/u.test(name)) throw fail('接收人名称应为100字以内的普通文字。');
    const previous = result.get(row.openId);
    if (!previous || !previous.name && name.trim()) result.set(row.openId, { openId: row.openId, name: name.trim() });
  }
  return [...result.values()];
}
export const validateRecipientList = normalizeRecipientList;

export function validateNotificationSettings(input = {}, previous = DEFAULT_NOTIFICATION_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !NOTIFICATION_KINDS.includes(key))) throw fail('面试消息阶段设置无效。');
  const result = { ...DEFAULT_NOTIFICATION_SETTINGS, ...previous };
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'boolean') throw fail('各阶段消息开关必须为布尔值。');
    result[key] = value;
  }
  return result;
}

function defaultRecipients(config) {
  if (owns(config, 'defaultNotificationRecipients')) return normalizeRecipientList(config.defaultNotificationRecipients);
  return validOpenId(config.reminderRecipientOpenId) ? [{ openId: config.reminderRecipientOpenId, name: '' }] : [];
}

/** Used for a newly scheduled interview; explicit [] always means no recipients. */
export function validateInterviewNotificationInput(input = {}, config = {}) {
  const recipients = owns(input, 'notificationRecipients') ? normalizeRecipientList(input.notificationRecipients) : defaultRecipients(config);
  const notificationSettings = validateNotificationSettings(input.notificationSettings || {}, validateNotificationSettings(config.defaultNotificationSettings || {}));
  const meetingOwnerOpenId = owns(input, 'meetingOwnerOpenId') ? input.meetingOwnerOpenId : recipients[0]?.openId || config.meetingOwnerOpenId || '';
  if (typeof meetingOwnerOpenId !== 'string' || meetingOwnerOpenId && !validOpenId(meetingOwnerOpenId)) throw fail('会议发起人应使用当前应用识别的飞书 open_id。');
  return { notificationRecipients: recipients, notificationSettings, meetingOwnerOpenId };
}

/** Only explicit new schedules/opt-ins call this. Reading old data never opts it in. */
export function initializeInterviewNotifications(row, settings = {}, { now = Date.now() } = {}) {
  const config = configOf(settings);
  if (!owns(row, 'notificationRecipients') && config.defaultNotificationRecipientsConnection && !sameLarkConnection(config.defaultNotificationRecipientsConnection, settings.feishuConnection)) throw fail('默认接收人属于另一飞书应用，请先在当前应用重新选择接收人。');
  const validated = validateInterviewNotificationInput(row, config);
  Object.assign(row, validated);
  let connection;
  if (settings.feishuConnection) connection = normalizeLarkConnection(settings.feishuConnection);
  const at = new Date(now).toISOString();
  row.notifications = {
    enabled: true, enabledAt: at, ...(connection ? { connection } : {}),
    recipientAddedAt: Object.fromEntries(validated.notificationRecipients.map(person => [person.openId, at])),
    stageEnabledAt: Object.fromEntries(NOTIFICATION_KINDS.map(kind => [kind, at])),
    baseline: { eventId: row.eventId || null, joinedAt: row.autoJoin?.joinedAt || null, reportId: row.interviewReport?.id || null },
    deliveries: [],
  };
  return row;
}

export function resolveInterviewRecipients(state, row, kind) {
  if (!NOTIFICATION_KINDS.includes(kind)) return [];
  if (owns(row, 'notificationRecipients')) return normalizeRecipientList(row.notificationRecipients);
  // Compatibility is intentionally limited to the two pre-existing flows.
  if (!['preparation', 'copilot'].includes(kind)) return [];
  const config = configOf(state?.settings);
  const legacy = owns(row, 'reminderRecipientOpenId') ? row.reminderRecipientOpenId : config.reminderRecipientOpenId;
  return validOpenId(legacy) ? [{ openId: legacy, name: '' }] : [];
}

export function notificationEnabled(state, row, kind) {
  if (!NOTIFICATION_KINDS.includes(kind) || row?.notifications?.enabled === false) return false;
  if (row?.notifications?.legacyOnly === true && !['preparation', 'copilot'].includes(kind)) return false;
  if (!row?.notifications && !['preparation', 'copilot'].includes(kind)) return false;
  if (row?.notifications && row.notifications.enabled !== true) return false;
  const settings = validateNotificationSettings(row?.notificationSettings || {});
  return settings[kind] === true && resolveInterviewRecipients(state, row, kind).length > 0;
}

export function recipientRosterKey(state, row, kind) {
  let connection = null;
  try { connection = normalizeLarkConnection(state?.settings?.feishuConnection); } catch {}
  return digest(JSON.stringify({ connection, enabled: notificationEnabled(state, row, kind), recipients: resolveInterviewRecipients(state, row, kind).map(person => person.openId).sort() }));
}
