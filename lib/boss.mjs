/**
 * BOSS adapter: observes an existing, operator-owned Chrome search session.
 *
 * Contract: one currently loaded page, no pagination, no outgoing contact,
 * no credential export, no anti-abuse bypass. The page owns its transport.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SEARCH_PATHS = new Set(['/web/chat/search', '/web/chat/search/', '/web/frame/search', '/web/frame/search/']);
const BUSY_PORTS = new Set();
const CAPTURE_TIMEOUT_MS = 18000;

function validPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CDP 端口必须是 1–65535 的整数。');
  return port;
}
function safePageUrl(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return ''; }
}
function isBossPage(target) {
  try { return target.type === 'page' && new URL(target.url).hostname === 'www.zhipin.com'; } catch { return false; }
}
function isSearchPage(target) { return isBossPage(target) && SEARCH_PATHS.has(new URL(target.url).pathname); }
function isChallengePage(target) { return isBossPage(target) && /\/(?:403|verify|security-check|captcha)(?:[/.]|$)/i.test(new URL(target.url).pathname); }
function scalar(value) { return typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''; }
function text(value) { return typeof value === 'string' ? value : ''; }
function emptyMeta(extra = {}) {
  return { capturedAt: new Date().toISOString(), page: null, pageSize: null, hasMore: null, reportedTotal: null, capturedCount: 0, endpoint: null, accountKey: null, coverage: 'current_loaded_page_only', ...extra };
}
function outcome(status, message, extra = {}) { return { status, message, candidates: [], meta: emptyMeta(), ...extra }; }
function requestFailure(error) {
  if (error?.code === 'BOSS_BUSY') return outcome('error', 'BOSS 页面正在执行另一个导入任务，请稍后重试。', { code: 'busy' });
  if (error?.name === 'TimeoutError' || /timeout|超时/i.test(error?.message ?? '')) return outcome('error', '读取 BOSS 页面超时，请检查浏览器后重试。', { code: 'timeout' });
  return outcome('error', '无法读取 BOSS 浏览器。请确认 Chrome 已启用本机 CDP 端口，且搜索页面已打开。', { code: error?.code ?? 'cdp_error' });
}

/** Preserve bare 16+ digit integers before JSON.parse can round an identifier. */
export function parseBossJson(body) {
  if (typeof body !== 'string') return body;
  return JSON.parse(body.replace(/"(?:[^"\\]|\\.)*"|([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, (match, prefix, integer) => integer ? `${prefix}"${integer}"` : match));
}

/** Tested independently using synthetic fixtures. No raw response is retained. */
export function normalizeBossResponse(input, { endpoint = null, capturedAt = new Date().toISOString(), httpStatus = 200, mechanism = 'page_native_client' } = {}) {
  const meta = emptyMeta({ capturedAt, endpoint, mechanism });
  let response;
  try { response = parseBossJson(input); }
  catch { return outcome('shape_changed', 'BOSS 返回了无法解析的数据，请保留页面并检查登录或安全验证状态。', { meta }); }
  const message = text(response?.message ?? response?.msg);
  if (httpStatus === 429 || Number(response?.code) === 5003 || /操作过于频繁|请求过于频繁|稍后再试.*频繁|rate.?limit|too many requests/i.test(message)) return outcome('rate_limited', 'BOSS 提示操作频繁，已停止读取，请稍后在页面中重试。', { meta });
  if (httpStatus === 401 || /请(?:先|重新)?登录|登录.{0,5}(?:失效|过期)|未登录|not logged|login required|session expired/i.test(message)) return outcome('need_auth', 'BOSS 登录状态不可用，请在 Chrome 中手动完成登录后重试。', { meta });
  if (/验证码|滑块|安全验证|人机验证|访问受限|账号.{0,5}限制|captcha|security.?check/i.test(message) || [5002, 5004].includes(Number(response?.code))) return outcome('need_auth', 'BOSS 需要人工处理安全验证或账号限制，已停止读取。', { meta, code: 'security_challenge' });
  if (!response || typeof response !== 'object' || !Object.hasOwn(response, 'code')) return outcome('shape_changed', 'BOSS 返回结构缺少业务状态，未导入数据。', { meta });
  if (httpStatus < 200 || httpStatus >= 300 || Number(response.code) !== 0) return outcome('error', `BOSS 查询失败${response.code !== undefined ? `（业务状态 ${String(response.code).slice(0, 24)}）` : ''}，请先在原页面检查。`, { meta });
  const data = response.zpData;
  if (!data || !Array.isArray(data.geeks)) return outcome('shape_changed', 'BOSS 候选列表结构发生变化，未把缺失列表当作零条。', { meta });
  const accountId = scalar(data.bossId);
  if (!/^[1-9][0-9]*$/.test(accountId)) return outcome('shape_changed', 'BOSS 返回缺少可验证的招聘账号标识，已停止导入以避免不同账号的数据混合。', { meta, code: 'account_scope_unknown' });
  meta.accountKey = createHash('sha256').update(accountId).digest('hex').slice(0, 16);
  meta.page = Number.isInteger(data.page) && data.page > 0 ? data.page : null;
  meta.pageSize = Number.isInteger(data.pageSize) && data.pageSize >= 0 ? data.pageSize : null;
  meta.hasMore = typeof data.hasMore === 'boolean' ? data.hasMore : null;
  meta.reportedTotal = Number.isSafeInteger(data.totalCount) && data.totalCount >= 0 ? data.totalCount : null;
  meta.responseCount = data.geeks.length;
  meta.capped = meta.hasMore === true;
  meta.capReason = meta.hasMore === true ? 'current_page_only' : null;
  const candidates = [];
  const ids = new Set();
  let rejectedCount = 0, duplicateCount = 0;
  for (const entry of data.geeks) {
    const card = entry?.geekCard;
    const externalId = typeof card?.encryptGeekId === 'string' ? card.encryptGeekId : '';
    if (!externalId.trim() || !text(card?.name).trim()) { rejectedCount++; continue; }
    if (ids.has(externalId)) { duplicateCount++; continue; }
    ids.add(externalId);
    candidates.push({
      externalId, name: card.name, source: 'boss', sourceAccountKey: meta.accountKey,
      city: text(card.city), workYear: text(card.workYear), degree: text(card.highestDegreeName),
      salary: text(card.salary), position: text(card.expect?.name).replace(/^期望职位\s*/, ''),
      company: text(entry.works?.[0]?.company?.value), school: text(card.eduSchool), major: text(card.eduMajor),
      introduction: text(card.geekDesc?.name),
      workHistory: Array.isArray(entry.works) ? entry.works.map(work => ({ company: text(work?.company?.value), position: text(work?.position?.value) })).filter(work => work.company || work.position) : [],
      capturedAt, sourceLabel: endpoint?.endsWith('/searchRecommend.json') ? 'BOSS 推荐当前页' : endpoint?.endsWith('/geeks.json') ? 'BOSS 搜索当前页' : 'BOSS 当前页',
    });
  }
  Object.assign(meta, { capturedCount: candidates.length, rejectedCount, duplicateCount });
  if (rejectedCount && !candidates.length) return outcome('shape_changed', `本页 ${data.geeks.length} 条记录均缺少有效候选人标识，未导入。`, { meta });
  if (rejectedCount || duplicateCount) return { status: 'partial', message: `已读取当前页 ${candidates.length} 人；${rejectedCount} 条结构异常、${duplicateCount} 条重复，未将结果计为完整。`, candidates, meta };
  if (!candidates.length) {
    if (meta.reportedTotal === 0 && meta.hasMore === false) return outcome('no_data', 'BOSS 当前查询明确返回零条候选人。', { meta });
    return outcome('partial', '当前页为空，但返回信息不足以证明查询结果为零，请在 BOSS 页面检查。', { meta });
  }
  if (meta.page === null || meta.pageSize === null || meta.hasMore === null || meta.reportedTotal === null) return { status: 'partial', message: `已读取当前页 ${candidates.length} 人；部分分页字段缺失，仅保留实际收到的记录。`, candidates, meta };
  return { status: meta.hasMore ? 'partial' : 'ok', message: `已读取 BOSS 当前已加载的第 ${meta.page} 页，共 ${candidates.length} 人${meta.hasMore ? '；仍有更多结果，本次未翻页' : ''}。`, candidates, meta };
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map(); this.handlers = new Map(); this.closed = false;
    ws.addEventListener('message', event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const job = this.pending.get(message.id); if (!job) return;
        clearTimeout(job.timer); this.pending.delete(message.id);
        if (message.error) job.reject(Object.assign(new Error('CDP 请求失败。'), { code: 'cdp_command_error' })); else job.resolve(message.result);
      } else for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
    });
    const rejectPending = () => {
      this.closed = true;
      for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(Object.assign(new Error('CDP 连接已断开。'), { code: 'cdp_disconnected' })); }
      this.pending.clear();
    };
    ws.addEventListener('close', rejectPending); ws.addEventListener('error', rejectPending);
  }
  static async connect(target, port) {
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== String(port)) throw new Error('CDP 必须使用本机地址。');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connect timeout')); }, 4000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    return new CdpConnection(ws);
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 已断开。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, CAPTURE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) { this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]); }
  close() { this.ws.close(); }
}

async function listTargets(port) {
  validPort(port);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3500) });
  if (!response.ok) throw new Error('CDP target list unavailable');
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('CDP target list is invalid');
  return targets;
}

// Runs only in the existing page. It neither handles credentials nor invokes
// platform actions. Vue remains the source of current query/result semantics.
function readNativePage() {
  const pages = [window];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentWindow && new URL(frame.src).hostname === 'www.zhipin.com') pages.push(frame.contentWindow); } catch {}
  }
  const page = pages.find(win => {
    try { return win.location.hostname === 'www.zhipin.com' && /^\/web\/frame\/search\/?$/.test(win.location.pathname); } catch { return false; }
  }) ?? window;
  const doc = page.document;
  const url = new URL(page.location.href);
  const state = { url: `${url.origin}${url.pathname}`, ready: doc.readyState, hasClient: false };
  const bodyText = (doc.body?.innerText ?? '').slice(0, 2500);
  if (/\/web\/(?:user|passport)(?:\/|$)/.test(url.pathname) || /扫码登录|验证码登录|账号密码登录/.test(bodyText)) return { ...state, needAuth: true };
  if (/\/(?:403|verify|security-check|captcha)(?:[/.]|$)/i.test(url.pathname) || /请完成安全验证|请完成验证|拖动滑块|点击完成验证|账号.*访问受限/.test(bodyText)) return { ...state, challenge: true };
  const vue = page.searchVue;
  if (!vue || !vue.lastPageData$) return state;
  state.hasClient = true;
  state.loading = Boolean(vue.loadding$);
  const last = vue.lastPageData$;
  const tip = vue.tips$;
  const dataError = tip?.action === 'error' && tip?.source === 'geek-list' && tip?.data && Number(tip.data.code) !== 0 ? { code: tip.data.code, message: tip.errorMessage || tip.data.message } : null;
  const resources = page.performance.getEntriesByType('resource');
  const request = resources.filter(entry => {
    try { return new URL(entry.name).hostname === 'www.zhipin.com' && ['/wapi/zpitem/web/boss/search/searchRecommend.json', '/wapi/zpitem/web/boss/search/geeks.json'].includes(new URL(entry.name).pathname); } catch { return false; }
  }).at(-1);
  const endpoint = request ? `${new URL(request.name).origin}${new URL(request.name).pathname}` : null;
  const visibleIds = Array.isArray(vue.dataList) ? vue.dataList.map(entry => entry?.geekCard?.encryptGeekId).filter(value => typeof value === 'string') : [];
  const safeData = { bossId: last.bossId, page: last.page, pageSize: last.pageSize, hasMore: last.hasMore, totalCount: last.totalCount,
    geeks: Array.isArray(last.geeks) ? last.geeks.map(entry => ({ geekCard: entry?.geekCard ? {
      encryptGeekId: entry.geekCard.encryptGeekId, name: entry.geekCard.name, city: entry.geekCard.city,
      workYear: entry.geekCard.workYear, highestDegreeName: entry.geekCard.highestDegreeName, salary: entry.geekCard.salary,
      expect: { name: entry.geekCard.expect?.name }, eduSchool: entry.geekCard.eduSchool, eduMajor: entry.geekCard.eduMajor,
      geekDesc: { name: entry.geekCard.geekDesc?.name },
    } : null, works: Array.isArray(entry?.works) ? entry.works.map(work => ({ company: { value: work?.company?.value }, position: { value: work?.position?.value } })) : [] })) : undefined };
  const query = vue.params$ ?? {};
  const filters = Object.fromEntries(['jobId', 'keywords', 'city', 'cityName', 'degree', 'experience', 'salary', 'applyStatus', 'activeness'].filter(key => Object.hasOwn(query, key)).map(key => [key, query[key]]));
  return { ...state, response: dataError ?? { code: 0, message: 'Success', zpData: safeData }, endpoint, visibleIds, filters, resultObservedAt: request ? new Date(page.performance.timeOrigin + request.startTime).toISOString() : null };
}

async function nativeSnapshot(connection) {
  const result = await connection.send('Runtime.evaluate', { expression: `JSON.stringify((${readNativePage.toString()})())`, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails || typeof result.result?.value !== 'string') throw Object.assign(new Error('页面客户端无法读取。'), { code: 'page_client_error' });
  return parseBossJson(result.result.value);
}

async function acquirePort(port) {
  if (BUSY_PORTS.has(port)) throw Object.assign(new Error('BOSS busy'), { code: 'BOSS_BUSY' });
  BUSY_PORTS.add(port);
  const filename = path.join(tmpdir(), `hr-workbench-boss-cdp-${port}.lock`);
  const nonce = randomUUID();
  let file;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { file = await open(filename, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let lock;
        try { lock = JSON.parse(await readFile(filename, 'utf8')); } catch { throw Object.assign(new Error('BOSS busy'), { code: 'BOSS_BUSY' }); }
        if (!Number.isInteger(lock.pid) || lock.pid < 1) throw Object.assign(new Error('BOSS busy'), { code: 'BOSS_BUSY' });
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (probeError) { if (probeError.code === 'ESRCH') alive = false; }
        if (alive || attempt > 0) throw Object.assign(new Error('BOSS busy'), { code: 'BOSS_BUSY' });
        await unlink(filename);
      }
    }
    if (!file) throw Object.assign(new Error('BOSS busy'), { code: 'BOSS_BUSY' });
    await file.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() }));
    await file.close(); file = null;
    return async () => {
      try { const lock = JSON.parse(await readFile(filename, 'utf8')); if (lock.nonce === nonce) await unlink(filename); } catch {}
      BUSY_PORTS.delete(port);
    };
  } catch (error) { if (file) await file.close().catch(() => {}); BUSY_PORTS.delete(port); throw error; }
}

export async function getBossStatus({ port = 19222 } = {}) {
  let connection;
  try {
    const targets = await listTargets(port);
    const matches = targets.filter(isSearchPage);
    if (matches.length > 1) return { status: 'error', code: 'ambiguous_search_page', message: '发现多个 BOSS 搜索标签，请保留一个搜索标签后再导入。' };
    if (!matches.length) {
      const boss = targets.find(isBossPage);
      const challenge = targets.find(isChallengePage);
      if (challenge) return { status: 'need_auth', code: 'security_challenge', message: 'BOSS 页面需要人工处理安全验证或账号限制。', pageUrl: safePageUrl(challenge.url) };
      if (boss && /\/web\/(?:user|passport)(?:\/|$)/.test(new URL(boss.url).pathname)) return { status: 'need_auth', message: '请先在 BOSS 浏览器中手动登录。', pageUrl: safePageUrl(boss.url) };
      return { status: boss ? 'connected' : 'disconnected', code: 'page_not_ready', message: 'Chrome 已连接，请先在同一浏览器中打开 BOSS 搜索页。', ...(boss ? { pageUrl: safePageUrl(boss.url) } : {}) };
    }
    connection = await CdpConnection.connect(matches[0], port);
    const snapshot = await nativeSnapshot(connection);
    if (snapshot.needAuth || snapshot.challenge) return { status: 'need_auth', message: snapshot.challenge ? 'BOSS 页面需要人工完成安全验证。' : 'BOSS 需要手动登录。', pageUrl: snapshot.url };
    const id = scalar(snapshot.response?.zpData?.bossId);
    return { status: 'connected', message: snapshot.hasClient ? '已连接 BOSS 原生搜索页面，可读取当前已加载的一页。' : '已连接搜索页，等待页面加载完成。', pageUrl: snapshot.url, ...(/^[1-9][0-9]*$/.test(id) ? { accountKey: createHash('sha256').update(id).digest('hex').slice(0, 16) } : {}) };
  } catch (error) { return { status: 'disconnected', message: '无法连接 Chrome CDP，请确认配置的本机端口已开启。', code: error?.code ?? 'cdp_unavailable' }; }
  finally { connection?.close(); }
}

export async function importBossPage({ port = 19222, maxPages = 1 } = {}) {
  let connection, release;
  try {
    validPort(port);
    if (maxPages !== 1) return outcome('error', '第一版只支持导入当前已加载的一页；请将 maxPages 设为 1。', { code: 'unsupported_page_limit' });
    release = await acquirePort(port);
    const targets = await listTargets(port);
    const matches = targets.filter(isSearchPage);
    if (matches.length > 1) return outcome('error', '发现多个搜索标签，无法确定用户当前查询。请保留一个 BOSS 搜索标签。', { code: 'ambiguous_search_page' });
    if (!matches.length) {
      if (targets.some(isChallengePage)) return outcome('need_auth', 'BOSS 页面需要人工处理安全验证或账号限制，已停止读取。', { code: 'security_challenge' });
      const auth = targets.find(target => isBossPage(target) && /\/web\/(?:user|passport)(?:\/|$)/.test(new URL(target.url).pathname));
      return outcome(auth ? 'need_auth' : 'error', auth ? '请先在 Chrome 中手动登录 BOSS。' : '请先在同一 Chrome 中打开 BOSS 搜索页，再导入当前页。', { code: auth ? 'need_auth' : 'page_not_ready' });
    }
    connection = await CdpConnection.connect(matches[0], port);
    let snapshot = await nativeSnapshot(connection);
    // Bounded readiness polling does not send extra platform requests.
    const deadline = Date.now() + 7000;
    while (!snapshot.needAuth && !snapshot.challenge && (!snapshot.hasClient || snapshot.loading) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 350));
      snapshot = await nativeSnapshot(connection);
    }
    if (snapshot.needAuth || snapshot.challenge) return outcome('need_auth', snapshot.challenge ? 'BOSS 页面需要人工完成安全验证，已停止读取。' : '请先在 Chrome 中手动登录 BOSS。');
    if (!snapshot.hasClient || snapshot.loading) return outcome('error', '搜索页尚未完成查询，或页面客户端已更新；请等待结果显示后重试。', { code: 'page_not_ready' });
    const result = normalizeBossResponse(snapshot.response, { endpoint: snapshot.endpoint, mechanism: 'in_page_result_model' });
    result.meta.resultObservedAt = snapshot.resultObservedAt;
    result.meta.filters = snapshot.filters ?? {};
    result.meta.jobId = scalar(snapshot.filters?.jobId) || null;
    result.meta.coverage = 'current_loaded_page_only';
    result.meta.notes = '读取页面原生客户端最近成功返回的单页模型；保持现有筛选，不刷新、不自动翻页，不代表全部搜索结果。';
    if (result.candidates.length) {
      const modelIds = new Set(result.candidates.map(candidate => candidate.externalId));
      const visible = snapshot.visibleIds;
      const overlap = visible.filter(id => modelIds.has(id)).length;
      result.meta.pageModelMatchesList = visible.length > 0 && overlap === modelIds.size;
      if (!result.meta.pageModelMatchesList) {
        result.status = 'partial';
        result.message = `已读取 ${result.candidates.length} 人，但页面展示列表与当前页模型未能完全对应，请在 BOSS 页面确认。`;
      }
    }
    return result;
  } catch (error) { return requestFailure(error); }
  finally { connection?.close(); if (release) await release(); }
}

export const bossAdapterContract = Object.freeze({ mechanism: 'in_page_result_model', maxPages: 1, coverage: 'current_loaded_page_only', skillVersion: '1.0.1', supportedHost: 'www.zhipin.com' });
