import { digest, uid } from './store.mjs';

export const DEFAULT_INBOX_AUTOMATION = Object.freeze({ enabled: true, intervalMinutes: 60, autoAnalyze: true, batchSize: 20 });
const MAX_BATCH = 20;
const globalStops = new Set(['need_auth', 'requires_review', 'rate_limited', 'throttled', 'captcha', 'verification_required', 'session_expired', 'challenge_required', 'cdp_unavailable', 'busy']);
const validDate = value => Number.isFinite(Date.parse(value));
const invalid = message => Object.assign(new Error(message), { code: 'invalid_inbox_settings', statusCode: 400 });
const stamp = clock => new Date(clock()).toISOString();
const message = value => String(value || '').replace(/https?:\/\/\S+/g, '[链接已省略]').replace(/(?:Bearer\s+|(?:token|cookie|api[_-]?key|securityId)\s*[:=]\s*)[^\s,;]+/gi, '[凭据已省略]').slice(0, 500);

export function validateInboxAutomationSettings(input = {}, previous = DEFAULT_INBOX_AUTOMATION) {
  const result = { ...DEFAULT_INBOX_AUTOMATION, ...previous };
  for (const key of ['enabled', 'autoAnalyze']) if (Object.hasOwn(input, key)) { if (typeof input[key] !== 'boolean') throw invalid('自动同步与自动分析开关必须为布尔值。'); result[key] = input[key]; }
  if (Object.hasOwn(input, 'intervalMinutes')) {
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 5 || input.intervalMinutes > 1440) throw invalid('同步间隔应为 5–1440 的整数分钟。');
    result.intervalMinutes = input.intervalMinutes;
  }
  if (Object.hasOwn(input, 'batchSize')) {
    if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > MAX_BATCH) throw invalid('每轮候选人数量应为 1–20。');
    result.batchSize = input.batchSize;
  }
  return result;
}

export function ensureInboxAutomationState(state, { now = Date.now() } = {}) {
  let changed = false;
  state.settings ??= {};
  const previous = state.settings.inboxAutomation;
  const defaults = { ...DEFAULT_INBOX_AUTOMATION, ...previous };
  if (!previous || Object.keys(DEFAULT_INBOX_AUTOMATION).some(key => previous[key] === undefined)) { state.settings.inboxAutomation = defaults; changed = true; }
  if (defaults.enabled && !validDate(state.settings.inboxAutomation.nextRunAt)) { state.settings.inboxAutomation.nextRunAt = new Date(now + defaults.intervalMinutes * 60000).toISOString(); changed = true; }
  if (!defaults.enabled && state.settings.inboxAutomation.nextRunAt !== null) { state.settings.inboxAutomation.nextRunAt = null; changed = true; }
  for (const key of ['inboxQueue', 'inboxRuns']) if (!Array.isArray(state[key])) { state[key] = []; changed = true; }
  return changed;
}

// Identity and message facts only. Profile read timestamps and derived summaries
// deliberately do not make an unchanged inbox appear new on every collection.
export function inboxConversationFingerprint(row) {
  return digest(JSON.stringify({ account: row.sourceAccountKey || '', externalId: row.externalId || '', candidateExternalId: row.candidateExternalId || '', lastMessage: row.lastMessage || '', lastMessageAt: row.lastMessageAt || '', messageCount: Number(row.messageCount) || 0, communicatedJobExternalId: row.communicatedJobExternalId || '', communicatedJobNumericId: row.communicatedJobNumericId || '', communicatedPosition: row.communicatedPosition || '', requirementId: row.requirementId || null, jobMappingStatus: row.jobMappingStatus || '' }));
}

function analysisSignature(state, id, resolver) {
  if (!resolver) return null;
  const value = resolver(state, id);
  if (value && typeof value.then === 'function') throw new Error('analysisFingerprint 必须为同步纯函数。');
  if (typeof value !== 'string' || !value) throw new Error('分析输入基准必须为非空字符串。');
  return value;
}
function refreshQueue(state, at, resolver) {
  const known = new Map(state.inboxQueue.map(row => [row.conversationId, row]));
  for (const conversation of state.conversations || []) {
    if (conversation.source !== 'boss' || !conversation.id || !conversation.sourceAccountKey || !conversation.externalId) continue;
    const fingerprint = inboxConversationFingerprint(conversation), sourceFingerprint = analysisSignature(state, conversation.id, resolver);
    let item = known.get(conversation.id);
    if (!item) { item = { conversationId: conversation.id, sourceAccountKey: conversation.sourceAccountKey, fingerprint, status: 'queued', firstQueuedAt: at, updatedAt: at, attempts: 0 }; state.inboxQueue.push(item); known.set(conversation.id, item); }
    else if (item.fingerprint !== fingerprint) Object.assign(item, { fingerprint, status: 'queued', updatedAt: at, lastError: null });
    if (sourceFingerprint && item.analysisFingerprint !== sourceFingerprint) {
      item.analysisFingerprint = sourceFingerprint;
      if (item.baselineFingerprint !== fingerprint && item.collectedFingerprint === fingerprint && item.analyzedSourceFingerprint !== sourceFingerprint) item.status = 'pending_analysis';
      item.updatedAt = at;
    }
    item.lastMessageAt = conversation.lastMessageAt || conversation.importedAt || conversation.createdAt || at;
  }
}
const analysisPending = item => item.analyzedFingerprint !== item.fingerprint || Boolean(item.analysisFingerprint && item.analyzedSourceFingerprint !== item.analysisFingerprint);
const needsWork = (item, settings) => item.baselineFingerprint !== item.fingerprint && (item.collectedFingerprint !== item.fingerprint || (settings.autoAnalyze && analysisPending(item)));
function outcome(value, stage) {
  const code = value?.code || value?.status;
  if (globalStops.has(code) || globalStops.has(value?.status)) throw Object.assign(new Error(value.message || 'BOSS 需要人工处理后继续。'), { code, status: value.status, globalStop: true });
  if (['error', 'failed', 'permission_denied', 'shape_changed'].includes(value?.status)) throw Object.assign(new Error(value.message || `${stage}未完成。`), { code: code || 'operation_failed', status: value.status });
  return value;
}
const errorInfo = error => ({ code: error?.code || error?.status || (error?.statusCode === 409 ? 'busy' : 'operation_failed'), message: message(error?.message || '本次操作未完成。') });

/**
 * One serial scheduler per workbench HTTP service. Store writes are awaited;
 * browser and model services never run inside a Store mutation.
 *
 * Services may mutate that same Store and return their ordinary result. A
 * collection result can be partial (for example no authorized attachment);
 * the analyzer must then report the available evidence and its gaps.
 * Optional analysisFingerprint(state,id) is a synchronous pure input/template
 * hash; findReusableAnalysis(id,state) returns a local Codex/model record or
 * null. Reuse happens before requiring a configured provider or spending tokens.
 */
export function createInboxAutomation({ store, services, clock = Date.now, batchSize = MAX_BATCH, tickMs = 30000 } = {}) {
  if (!store?.read || !store?.mutate) throw new Error('Inbox scheduler requires a persistent Store.');
  if (!services?.syncConversations || !services?.collectCandidate || !services?.analyzeConversationPriority || !services?.modelReady) throw new Error('Inbox scheduler requires sync, collection, analysis and model readiness services.');
  let current = null, timer = null, started = false;
  const at = () => stamp(clock);
  const settings = state => ({ ...DEFAULT_INBOX_AUTOMATION, ...state.settings?.inboxAutomation });
  const write = fn => store.mutate(state => { ensureInboxAutomationState(state, { now: clock() }); return fn(state); });
  function status() {
    const state = store.read(), config = settings(state), lastRun = state.inboxRuns?.[0] || null;
    const items = state.inboxQueue || [];
    const counts = { pending: items.filter(item => needsWork(item, config) && !['awaiting_model', 'failed'].includes(item.status)).length, pendingCollection: items.filter(item => item.baselineFingerprint !== item.fingerprint && item.collectedFingerprint !== item.fingerprint).length, pendingAnalysis: config.autoAnalyze ? items.filter(item => item.baselineFingerprint !== item.fingerprint && item.collectedFingerprint === item.fingerprint && analysisPending(item)).length : 0, failed: items.filter(item => item.status === 'failed').length, awaitingModel: config.autoAnalyze ? items.filter(item => item.status === 'awaiting_model').length : 0, baseline: items.filter(item => item.baselineFingerprint === item.fingerprint).length };
    const running = Boolean(current);
    return { settings: config, enabled: config.enabled, intervalMinutes: config.intervalMinutes, autoAnalyze: config.autoAnalyze, running, nextRunAt: config.enabled ? config.nextRunAt || null : null, lastRun, queue: counts, status: running ? 'running' : !config.enabled ? 'disabled' : counts.awaitingModel ? 'waiting_model' : lastRun?.status || 'scheduled', runtime: 'while_workbench_server_running' };
  }
  async function configure(input = {}) {
    await write(state => {
      const previous = settings(state), updated = validateInboxAutomationSettings(input, previous);
      const scheduleChanged = previous.enabled !== updated.enabled || previous.intervalMinutes !== updated.intervalMinutes;
      updated.nextRunAt = !updated.enabled ? null : scheduleChanged || !validDate(previous.nextRunAt) ? new Date(clock() + updated.intervalMinutes * 60000).toISOString() : previous.nextRunAt;
      state.settings.inboxAutomation = updated;
    });
    return status();
  }
  async function execute({ trigger = 'manual', limit } = {}) {
    const initial = store.read(), config = settings(initial);
    const maxItems = Math.min(MAX_BATCH, Number.isInteger(limit) && limit > 0 ? limit : config.batchSize || batchSize);
    const id = uid('inbox'), startedAt = at();
    let result = { id, trigger, status: 'running', startedAt, processed: 0, collected: 0, analyzed: 0, reused: 0, failed: 0, deferred: 0, items: [], modelConfigured: false };
    await write(state => { state.inboxRuns.unshift(result); state.inboxRuns = state.inboxRuns.slice(0, 50); });
    try {
      const sync = outcome(await services.syncConversations(), '消息同步');
      result.sync = { status: sync?.status || 'ok', imported: sync?.imported || 0, updated: sync?.updated || 0, capturedAt: sync?.meta?.capturedAt || at() };
      await write(state => { refreshQueue(state, at(), services.analysisFingerprint); });
      const state = store.read(), runSettings = settings(state);
      result.modelConfigured = runSettings.autoAnalyze ? Boolean(await services.modelReady(state)) : false;
      const work = (state.inboxQueue || []).filter(item => item.baselineFingerprint !== item.fingerprint && (item.collectedFingerprint !== item.fingerprint || (runSettings.autoAnalyze && (result.modelConfigured || services.findReusableAnalysis) && analysisPending(item)))).sort((a, b) => Number(b.collectedFingerprint !== b.fingerprint) - Number(a.collectedFingerprint !== a.fingerprint) || (Date.parse(b.lastMessageAt) || 0) - (Date.parse(a.lastMessageAt) || 0)).slice(0, maxItems);
      for (const pending of work) {
        if (trigger === 'scheduled' && (!started || !settings(store.read()).enabled)) { result.status = 'partial'; result.stopReason = { code: 'disabled', message: '自动同步已停止，剩余队列保留。' }; break; }
        let stage = 'collection', completed = false, collectedFingerprint, analyzedSourceFingerprint;
        const row = { conversationId: pending.conversationId, status: 'processing', startedAt: at() };
        await write(draft => { const item = draft.inboxQueue.find(value => value.conversationId === pending.conversationId); if (item) { item.status = 'processing'; item.attempts = (Number(item.attempts) || 0) + 1; item.updatedAt = at(); } });
        try {
          let fresh = store.read(), queued = fresh.inboxQueue.find(item => item.conversationId === pending.conversationId);
          if (queued.collectedFingerprint !== queued.fingerprint) {
            const collection = outcome(await services.collectCandidate(pending.conversationId), '资料采集');
            result.collected++;
            row.collectionStatus = collection?.status || 'ok';
            await write(draft => {
              const item = draft.inboxQueue.find(value => value.conversationId === pending.conversationId), conversation = draft.conversations?.find(value => value.id === pending.conversationId);
              if (!item || !conversation) throw new Error('采集后会话记录不存在。');
              item.fingerprint = inboxConversationFingerprint(conversation); item.collectedFingerprint = item.fingerprint; item.collectedAt = at(); item.lastCollectionStatus = row.collectionStatus;
              const signature = analysisSignature(draft, pending.conversationId, services.analysisFingerprint); if (signature) item.analysisFingerprint = signature;
            });
          }
          fresh = store.read(); queued = fresh.inboxQueue.find(item => item.conversationId === pending.conversationId); collectedFingerprint = queued.fingerprint;
          analyzedSourceFingerprint = analysisSignature(fresh, pending.conversationId, services.analysisFingerprint) || queued.analysisFingerprint || null;
          const latestSettings = settings(fresh);
          const cached = latestSettings.autoAnalyze && services.findReusableAnalysis ? await services.findReusableAnalysis(pending.conversationId, fresh) : null;
          const reusable = cached?.id && ['codex', 'model'].includes(cached.generator) && cached.stale !== true && (!analyzedSourceFingerprint || (cached.analysisKey || cached.sourceFingerprint) === analyzedSourceFingerprint);
          if (reusable) { completed = true; row.status = 'done'; row.reused = true; row.analysisId = cached.id; row.analysisGenerator = cached.generator; result.reused++; }
          else if (!latestSettings.autoAnalyze) row.status = 'analysis_disabled';
          else if (!await services.modelReady(fresh)) row.status = 'awaiting_model';
          else {
            stage = 'analysis';
            const analysis = outcome(await services.analyzeConversationPriority(pending.conversationId), '模型分析');
            if (analysis?.reused === true) { result.reused++; row.reused = true; } else result.analyzed++;
            completed = true; row.status = 'done'; row.analysisId = analysis?.id || analysis?.analysisId || null;
          }
          await write(draft => {
            const item = draft.inboxQueue.find(value => value.conversationId === pending.conversationId), conversation = draft.conversations?.find(value => value.id === pending.conversationId);
            if (completed) { item.analyzedFingerprint = collectedFingerprint; item.analyzedAt = at(); if (analyzedSourceFingerprint) item.analyzedSourceFingerprint = analyzedSourceFingerprint; }
            if (conversation) item.fingerprint = inboxConversationFingerprint(conversation);
            const currentSignature = analysisSignature(draft, pending.conversationId, services.analysisFingerprint); if (currentSignature) item.analysisFingerprint = currentSignature;
            item.status = item.fingerprint !== collectedFingerprint || Boolean(completed && currentSignature && currentSignature !== analyzedSourceFingerprint) ? 'queued' : row.status;
            item.updatedAt = at(); item.lastError = null;
          });
        } catch (error) {
          const info = errorInfo(error); row.status = 'failed'; row.stage = stage; row.errorCode = info.code; row.message = info.message; result.failed++;
          await write(draft => { const item = draft.inboxQueue.find(value => value.conversationId === pending.conversationId); if (item) Object.assign(item, { status: 'failed', lastError: info, updatedAt: at() }); });
          if (error.globalStop || globalStops.has(info.code)) { result.stopReason = info; result.status = 'blocked'; }
        }
        row.finishedAt = at(); result.items.push(row); result.processed++;
        await write(draft => { Object.assign(draft.inboxRuns.find(run => run.id === id), result); });
        if (result.status === 'blocked') break;
      }
      await write(draft => { refreshQueue(draft, at(), services.analysisFingerprint); });
      const remaining = store.read(), remainingSettings = settings(remaining);
      result.deferred = remaining.inboxQueue.filter(item => needsWork(item, remainingSettings)).length;
      const waiting = remainingSettings.autoAnalyze && remaining.inboxQueue.some(item => item.status === 'awaiting_model');
      if (!['blocked', 'partial'].includes(result.status)) result.status = result.failed || result.sync.status === 'partial' ? 'partial' : waiting ? 'waiting_model' : 'completed';
      result.message = `消息同步已返回，本轮处理 ${result.processed} 位，采集 ${result.collected} 位，模型分析 ${result.analyzed} 位${result.failed ? `，未完成 ${result.failed} 位` : ''}${result.reused ? `，复用已有分析 ${result.reused} 位` : ''}${waiting ? '；模型未配置的资料保留待分析' : ''}${result.deferred ? `；队列剩余 ${result.deferred} 位` : ''}。`;
    } catch (error) {
      const info = errorInfo(error); result.error = info; result.status = error.globalStop || globalStops.has(info.code) ? 'blocked' : 'error'; result.message = info.message;
    } finally {
      result.finishedAt = at();
      await write(state => {
        Object.assign(state.inboxRuns.find(run => run.id === id), result);
        const config = state.settings.inboxAutomation;
        config.lastRunAt = result.finishedAt; config.lastStatus = result.status;
        config.nextRunAt = config.enabled ? new Date(clock() + config.intervalMinutes * 60000).toISOString() : null;
      });
    }
    return result;
  }
  function run(options = {}) {
    if (current) return current;
    current = execute(options).finally(() => { current = null; });
    return current;
  }
  async function tick() {
    if (!started || current) return;
    const config = settings(store.read());
    if (config.enabled && validDate(config.nextRunAt) && Date.parse(config.nextRunAt) <= clock()) await run({ trigger: 'scheduled' });
  }
  async function start() {
    if (started) return status();
    await write(state => {
      for (const previous of state.inboxRuns.filter(run => run.status === 'running')) Object.assign(previous, { status: 'interrupted', finishedAt: at(), message: '上次服务在任务结束前停止；保留已完成采集和分析进度，后续从队列继续。' });
      for (const item of state.inboxQueue) if (item.status === 'processing') item.status = 'queued';
    });
    started = true;
    timer = setInterval(() => { tick().catch(() => {}); }, Math.max(1000, tickMs)); timer.unref?.();
    tick().catch(() => {});
    return status();
  }
  function stop() { started = false; if (timer) clearInterval(timer); timer = null; }
  return { start, stop, run, configure, status, tick };
}
