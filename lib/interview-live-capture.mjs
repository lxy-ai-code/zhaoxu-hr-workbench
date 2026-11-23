import { normalizeLarkConnection, sameLarkConnection } from './lark-context.mjs';
import { digest } from './store.mjs';

export const DEFAULT_INTERVIEW_LIVE_CAPTURE = Object.freeze({ liveCaptureEnabled: false, liveCapturePollSeconds: 15 });
const invalid = message => Object.assign(new Error(message), { code: 'invalid_live_capture_settings', statusCode: 400 });
const stamp = time => new Date(time).toISOString();
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const longId = value => typeof value === 'string' && /^\d{10,25}$/.test(value);
const configOf = state => ({ ...DEFAULT_INTERVIEW_LIVE_CAPTURE, ...state.settings?.interviewAutomation });
const activeConfig = state => state.settings?.interviewAutomation?.enabled === true && configOf(state).liveCaptureEnabled === true;
const clean = value => String(value || '').replace(/(?:Bearer\s+|(?:token|cookie|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '[凭据已省略]').slice(0, 500);
const errorInfo = error => ({ code: String(error?.code || error?.status || 'live_capture_failed'), message: clean(error?.message || '会中内容读取未完成。') });
function blockedError(error) {
  const code = `${error?.code || ''} ${error?.status || ''}`;
  return /scope|permission|forbidden|identity|not_configured|invalid_reference|context_mismatch|bot_not_in_meeting/i.test(code) || error?.missingScopes?.length > 0 || [401, 403].includes(Number(error?.statusCode)) || [99991679, 10005].includes(Number(error?.upstreamCode));
}
function endedError(error) { return Number(error?.upstreamCode) === 20001 || /meeting_status_MEETING_END|meeting_ended/i.test(String(error?.code || error?.message || '')); }

export function validateInterviewLiveCaptureSettings(input = {}, previous = DEFAULT_INTERVIEW_LIVE_CAPTURE) {
  const result = { ...DEFAULT_INTERVIEW_LIVE_CAPTURE, ...previous };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('会中读取配置无效。');
  if (Object.hasOwn(input, 'liveCaptureEnabled')) { if (typeof input.liveCaptureEnabled !== 'boolean') throw invalid('会中持续读取开关必须为布尔值。'); result.liveCaptureEnabled = input.liveCaptureEnabled; }
  if (Object.hasOwn(input, 'liveCapturePollSeconds')) { if (!Number.isInteger(input.liveCapturePollSeconds) || input.liveCapturePollSeconds < 5 || input.liveCapturePollSeconds > 60) throw invalid('会中读取间隔应为 5–60 的整数秒。'); result.liveCapturePollSeconds = input.liveCapturePollSeconds; }
  return result;
}
export const validateLiveCaptureSettings = validateInterviewLiveCaptureSettings;

const cancelled = row => ['cancelled', 'canceled', 'deleted'].includes(row?.status) || ['cancelled', 'canceled', 'deleted'].includes(row?.calendarStatus);
const finished = row => ['completed', 'finished', 'ended'].includes(row?.status);
const terminalCapture = capture => ['blocked', 'completed', 'cancelled'].includes(capture?.status);

function contextOf(state, row) {
  let connection;
  try { connection = normalizeLarkConnection(state.settings?.feishuConnection); } catch { return null; }
  if (connection.identity !== 'bot' || !connection.profile || !connection.appId || row?.autoJoinEnabled !== true || row.autoJoin?.status !== 'joined' || !longId(row.autoJoin.meetingId) || row.calendarStatus !== 'synced' || !row.eventId || !row.feishuConnection || !row.autoJoin.feishuConnection || !sameLarkConnection(row.feishuConnection, connection) || !sameLarkConnection(row.autoJoin.feishuConnection, connection)) return null;
  const start = date(row.startAt), end = date(row.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { connection, meetingId: row.autoJoin.meetingId, start, end, key: digest(JSON.stringify([connection, row.id, row.eventId, row.autoJoin.meetingId])) };
}

/** App-owned reader. Its one shared poll service persists cursors and performs
 * evidence deduplication; this scheduler never joins or sends any message. */
export function createInterviewLiveCapture({ store, services, clock = Date.now, tickMs = 15000 } = {}) {
  if (!store?.read || !store?.mutate || typeof services?.poll !== 'function') throw new Error('Live capture requires a persistent store and one shared poll service.');
  let started = false, epoch = 0, timer = null, running = null;
  function status() {
    const state = store.read(), settings = configOf(state), rows = state.interviews || [];
    const counts = { collecting: 0, blocked: 0, retrying: 0, completed: 0 };
    for (const row of rows) if (Object.hasOwn(counts, row.liveCapture?.status)) counts[row.liveCapture.status]++;
    return { enabled: activeConfig(state), started, running: Boolean(running), settings: { liveCaptureEnabled: settings.liveCaptureEnabled, liveCapturePollSeconds: settings.liveCapturePollSeconds }, status: !activeConfig(state) ? 'disabled' : running ? 'reading' : started ? 'scheduled' : 'stopped', queue: counts, runtime: 'while_workbench_server_running' };
  }
  function scheduleTimer() {
    if (timer) clearInterval(timer);
    const seconds = configOf(store.read()).liveCapturePollSeconds;
    timer = setInterval(() => { tick().catch(() => {}); }, Math.max(1000, Math.min(tickMs, seconds * 1000)));
    timer.unref?.();
  }
  async function configure(input = {}) {
    await store.mutate(state => {
      const next = validateInterviewLiveCaptureSettings(input, configOf(state));
      state.settings ??= {};
      state.settings.interviewAutomation = { ...state.settings.interviewAutomation, liveCaptureEnabled: next.liveCaptureEnabled, liveCapturePollSeconds: next.liveCapturePollSeconds };
    });
    if (started) { scheduleTimer(); await run(); }
    return status();
  }
  async function terminalState(id, value) {
    const snapshot = store.read(), row = snapshot.interviews?.find(item => item.id === id);
    if (!row?.liveCapture || row.liveCapture.status === value) return;
    await store.mutate(state => { const current = state.interviews?.find(item => item.id === id); if (current?.liveCapture && current.liveCapture.status !== value) Object.assign(current.liveCapture, { status: value, updatedAt: stamp(clock()) }); });
  }
  async function collect(id, runEpoch) {
    if (!started || runEpoch !== epoch || !activeConfig(store.read())) return;
    let selected = null;
    const snapshot = store.read(), row = snapshot.interviews?.find(item => item.id === id);
    if (!row) return;
    if (cancelled(row)) return terminalState(id, 'cancelled');
    if (finished(row)) return terminalState(id, 'completed');
    const context = contextOf(snapshot, row), time = clock();
    if (!context) return;
    if (time >= context.end) return terminalState(id, 'completed');
    if (time < context.start - 30 * 60000 || (row.liveCapture?.contextKey === context.key && (terminalCapture(row.liveCapture) || date(row.liveCapture.nextPollAt) > time))) return;
    await store.mutate(state => {
      const current = state.interviews?.find(item => item.id === id), fresh = contextOf(state, current);
      if (!started || runEpoch !== epoch || !activeConfig(state) || !fresh || cancelled(current) || finished(current) || fresh.key !== context.key || clock() < fresh.start - 30 * 60000 || clock() >= fresh.end) return;
      if (current.liveCapture?.contextKey === fresh.key && (terminalCapture(current.liveCapture) || date(current.liveCapture.nextPollAt) > clock())) return;
      const previous = current.liveCapture?.contextKey === fresh.key ? current.liveCapture : {};
      current.liveCapture = { ...previous, status: 'reading', contextKey: fresh.key, meetingId: fresh.meetingId, feishuConnection: fresh.connection, lastCheckedAt: stamp(clock()), nextPollAt: stamp(clock() + configOf(state).liveCapturePollSeconds * 1000), error: null };
      selected = { contextKey: fresh.key, meetingId: fresh.meetingId };
    });
    if (!selected || !started || runEpoch !== epoch) return;
    const beforeRead = store.read(), beforeRow = beforeRead.interviews?.find(item => item.id === id), beforeContext = contextOf(beforeRead, beforeRow);
    if (!activeConfig(beforeRead) || !beforeContext || beforeContext.key !== selected.contextKey || cancelled(beforeRow) || finished(beforeRow) || clock() >= beforeContext.end) return;
    let values;
    try {
      const result = await services.poll(id);
      if (!['ok', 'no_speech', 'quiet'].includes(result?.status)) throw Object.assign(new Error(result?.message || '会中读取没有返回可确认结果。'), { code: result?.status || 'invalid_live_receipt' });
      const current = store.read().interviews?.find(item => item.id === id), session = current?.liveSession;
      values = { status: 'collecting', lastResultStatus: result.status, lastSuccessAt: stamp(clock()), lastSyncAt: result.lastSyncAt || session?.lastSyncAt || stamp(clock()), segmentCount: Number.isInteger(result.totalSegments) ? result.totalSegments : Array.isArray(session?.segments) ? session.segments.length : 0, newSegments: Number.isInteger(result.newSegments) ? result.newSegments : 0, unchanged: result.unchanged === true, nextPollAt: stamp(clock() + configOf(store.read()).liveCapturePollSeconds * 1000), error: null };
    } catch (error) {
      values = { status: endedError(error) ? 'completed' : blockedError(error) ? 'blocked' : 'retrying', nextPollAt: stamp(clock() + 60000), error: errorInfo(error) };
    }
    await store.mutate(state => {
      const current = state.interviews?.find(item => item.id === id);
      if (current?.liveCapture?.contextKey !== selected.contextKey) return;
      if (cancelled(current)) { Object.assign(current.liveCapture, { status: 'cancelled', updatedAt: stamp(clock()) }); return; }
      if (finished(current) || clock() >= date(current.endAt)) { Object.assign(current.liveCapture, { status: 'completed', updatedAt: stamp(clock()) }); return; }
      const fresh = contextOf(state, current);
      if (!fresh || fresh.key !== selected.contextKey) { Object.assign(current.liveCapture, { status: 'blocked', error: { code: 'context_changed', message: '读取期间会议或应用关联已变化，未沿用原读取上下文。' }, updatedAt: stamp(clock()) }); return; }
      Object.assign(current.liveCapture, values, { updatedAt: stamp(clock()) });
    });
  }
  async function execute(runEpoch) {
    if (!started || runEpoch !== epoch || !activeConfig(store.read())) return status();
    for (const row of store.read().interviews || []) { if (!started || runEpoch !== epoch || !activeConfig(store.read())) break; await collect(row.id, runEpoch); }
    return status();
  }
  function run() {
    if (running) return running;
    if (!started) return Promise.resolve(status());
    running = execute(epoch).finally(() => { running = null; });
    return running;
  }
  function tick() { return started && !running ? run() : Promise.resolve(status()); }
  async function start() { if (started) return status(); started = true; epoch++; scheduleTimer(); await run(); return status(); }
  function stop() { started = false; epoch++; if (timer) clearInterval(timer); timer = null; }
  return { start, stop, tick, run, status, configure };
}
