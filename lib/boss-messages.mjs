/**
 * Read-only access to BOSS's already-loaded conversation cache.
 * No openChat, history query, sendRead or sendMessage occurs. Optional refresh
 * follows the page's native list-only refresh while retaining the current chat.
 * Closure names are derived from the live wrapper sources, not hard-coded.
 */
import { createHash, randomUUID } from 'node:crypto';

const s = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
const txt = value => typeof value === 'string' ? value : '';
const baseMeta = extra => ({ capturedAt: new Date().toISOString(), coverage: 'loaded_conversations_only', mechanism: 'in_page_readonly_cache', hasMore: null, ...extra });
function when(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
function accountKey(accountId) {
  const id = s(accountId);
  return /^[1-9][0-9]*$/.test(id) ? createHash('sha256').update(id).digest('hex').slice(0, 16) : null;
}

export function normalizeBossConversations(snapshot) {
  const scope = accountKey(snapshot?.accountId);
  const meta = baseMeta({ accountKey: scope, indexedCount: snapshot?.indexedCount ?? null, loadedCount: Array.isArray(snapshot?.rows) ? snapshot.rows.length : null, endpoint: 'page-memory:friend-list', initiationEvidence: 'native_relation_labels_8_candidate_9_hr', notes: '只读取页面已加载的会话缓存。未加载索引不计为零；按平台原生发起标签判断，缺失或冲突为未知。' });
  if (!scope) return { status: 'shape_changed', message: '缺少可验证的 BOSS 账号标识，未导入消息以避免跨账号混合。', conversations: [], meta };
  if (!Array.isArray(snapshot.rows)) return { status: 'shape_changed', message: 'BOSS 会话缓存结构不可用，未将未知列表当作零会话。', conversations: [], meta };
  const unique = new Map(); let rejectedCount = 0;
  for (const row of snapshot.rows) {
    const externalId = s(row.uniqueId), peerId = s(row.friendId);
    if (!externalId || !peerId || !txt(row.name)) { rejectedCount++; continue; }
    const direction = row.lastIsSelf === true ? 'hr' : row.lastIsSelf === false ? 'candidate' : 'unknown';
    // Verified against the native L3 label catalog: 8=牛人发起, 9=我发起.
    // Last sender, relationship code, and unread count do not identify initiator.
    const labels = Array.isArray(row.relationLabelList) ? row.relationLabelList : [];
    const candidateInitiated = labels.includes(8), hrInitiated = labels.includes(9);
    const initiator = candidateInitiated === hrInitiated ? 'unknown' : candidateInitiated ? 'candidate' : 'hr';
    unique.set(externalId, {
      externalId, source: 'boss', sourceAccountKey: scope,
      peerId, peerName: row.name,
      ...(txt(row.encryptUid) ? { candidateExternalId: row.encryptUid } : {}),
      communicatedJobExternalId: txt(row.encryptJobId) || null,
      communicatedJobNumericId: /^[0-9]+$/.test(s(row.jobId)) && !/^0+$/.test(s(row.jobId)) ? s(row.jobId) : null,
      communicatedPosition: txt(row.jobName),
      unreadCount: Number.isSafeInteger(row.newMsgCount) && row.newMsgCount >= 0 ? row.newMsgCount : null,
      lastMessage: txt(row.lastText), lastMessageAt: when(row.lastTS),
      lastMessageId: s(row.lastMsgId) || null, lastSender: direction, lastMessageType: 'preview',
      initiator, hasMore: null, sourceLabel: 'BOSS 已加载会话缓存',
    });
  }
  const conversations = [...unique.values()];
  Object.assign(meta, { capturedCount: conversations.length, rejectedCount, hasMore: Number.isInteger(meta.indexedCount) && meta.indexedCount > snapshot.rows.length ? true : null });
  return { status: 'partial', message: `已读取 ${conversations.length} 个已加载会话的最后消息；发起方按平台标签记录，缺失或冲突显示未知，未遍历全部历史。`, conversations, meta };
}

export function normalizeBossCachedMessages(snapshot, { conversationId, peerId } = {}) {
  const scope = accountKey(snapshot?.accountId);
  const meta = baseMeta({ coverage: 'current_open_conversation_loaded_messages_only', accountKey: scope, endpoint: 'page-memory:current-conversation', readOnly: true });
  if (!scope) return { status: 'shape_changed', message: '缺少 BOSS 账号标识，无法确认消息归属。', messages: [], meta };
  const selected = s(snapshot?.currentConversationId);
  if (!conversationId || !selected || selected !== s(conversationId) || (peerId && s(snapshot.currentPeerId) !== s(peerId))) return { status: 'read_only_unavailable', message: '此会话历史未在 BOSS 当前页面加载。为保留未读状态，工作台不会自动打开会话；请自行在 BOSS 中打开后重试。', messages: [], meta };
  if (!Array.isArray(snapshot.messages) || !snapshot.messages.length) return { status: 'read_only_unavailable', message: '当前会话尚无可读取的已加载消息；未将缺失历史当作零轮沟通。', messages: [], meta };
  const messages = [], seen = new Set(); let rejectedCount = 0;
  for (const row of snapshot.messages) {
    const id = s(row.serverMid) || s(row.mid);
    if (!id) { rejectedCount++; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const sender = row.isSelf === true ? 'hr' : row.isSelf === false ? 'candidate' : 'unknown';
    const type = txt(row.type) || 'unknown';
    const message = { externalId: id, conversationExternalId: selected, sender, senderName: txt(row.fromName), text: type === 'text' ? txt(row.text) : `[${type === 'image' ? '图片' : type === 'sound' ? '语音' : type === 'sticker' ? '表情' : '非文本消息'}]`, sentAt: when(row.time), type };
    messages.push(message);
  }
  Object.assign(meta, { capturedCount: messages.length, rejectedCount, hasMore: null });
  return { status: messages.length ? 'partial' : 'shape_changed', message: messages.length ? `已读取当前会话中已加载的 ${messages.length} 条消息；更早历史与已读状态不作推断。` : '消息缺少稳定 ID，未生成虚构消息记录。', messages, meta };
}

class Connection {
  constructor(ws) {
    this.ws = ws; this.pending = new Map(); this.serial = 0; this.handlers = new Map();
    ws.addEventListener('message', event => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg.id) { for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params); return; }
      const job = this.pending.get(msg.id); if (!job) return;
      clearTimeout(job.timer); this.pending.delete(msg.id);
      msg.error ? job.reject(Object.assign(new Error('CDP 只读调用失败。'), { code: 'cdp_error' })) : job.resolve(msg.result);
    });
    ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP disconnected')); } this.pending.clear(); });
  }
  on(event, handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); }
  static async open(target, port) {
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== String(port)) throw new Error('Only loopback CDP is supported');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 4000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP unavailable')); }, { once: true });
    });
    return new Connection(ws);
  }
  send(method, params = {}) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout')); }, 7000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function properties(connection, objectId, ownProperties = true) { return connection.send('Runtime.getProperties', { objectId, ownProperties, generatePreview: false }); }
async function scopeVariable(connection, functionId, name) {
  const info = await properties(connection, functionId);
  const scopeId = info.internalProperties?.find(row => row.name === '[[Scopes]]')?.value?.objectId;
  if (!scopeId) return null;
  const scopes = await properties(connection, scopeId);
  // Exclude the Global scope: only inspect the function's own loaded closures.
  for (const scope of scopes.result.filter(row => row.value?.objectId && row.value.description !== 'Global')) {
    const vars = await properties(connection, scope.value.objectId);
    const variable = vars.result.find(row => row.name === name && row.value?.objectId);
    if (variable) return variable.value;
  }
  return null;
}
function referencedName(fn, method) { return fn?.description?.match(new RegExp(`([A-Za-z_$][0-9A-Za-z_$]*)[.]${method}\\s*[(]`))?.[1]; }
async function readFunction(connection, expression, group) {
  const r = await connection.send('Runtime.evaluate', { expression, objectGroup: group, returnByValue: false });
  return r.result?.type === 'function' ? r.result : null;
}
async function friendStore(connection, group) {
  const bridgeFunction = await readFunction(connection, 'window.iBossRoot?.chat?.updateChatList', group);
  const bridgeName = referencedName(bridgeFunction, 'updateChatList');
  if (!bridgeName) return null;
  const bridge = await scopeVariable(connection, bridgeFunction.objectId, bridgeName);
  if (!bridge) return null;
  const bridgeProps = await properties(connection, bridge.objectId, false);
  const getter = bridgeProps.result.find(row => row.name === 'getFriendByUniqueId')?.value;
  const storeName = referencedName(getter, 'getFriendByUniqueId');
  if (!storeName) return null;
  const store = await scopeVariable(connection, getter.objectId, storeName);
  if (!store) return null;
  const storeProps = await properties(connection, store.objectId, false);
  const unreadGetter = storeProps.result.find(row => row.name === 'getUnreadGeek')?.value;
  const indexName = unreadGetter?.description?.match(/return\s+([A-Za-z_$][0-9A-Za-z_$]*)[.]map\s*[(]/)?.[1];
  if (!indexName) return null;
  const index = await scopeVariable(connection, unreadGetter.objectId, indexName);
  if (!index || index.subtype !== 'array') return null;
  return { store, index, bridge };
}
async function currentConversationStore(connection, group) {
  const fn = await readFunction(connection, 'window.iBossRoot?.chat?.updateConversation', group);
  const name = referencedName(fn, 'updateConversation');
  if (!name) return null;
  return scopeVariable(connection, fn.objectId, name);
}

function readFriends(index) {
  // getFriendByUniqueId's observed implementation is a pure in-memory lookup.
  const before = this.getUnreadCount();
  const rows = index.slice(0, 1000).map(id => this.getFriendByUniqueId(id)).filter(Boolean);
  const after = this.getUnreadCount();
  return JSON.stringify({ accountId: window._PAGE?.uid, indexedCount: index.length, beforeUnread: before, afterUnread: after,
    rows: rows.map(row => ({ uniqueId: row.uniqueId, friendId: row.friendId, encryptUid: row.encryptUid,
      name: row.name, lastTS: row.lastTS, lastText: row.lastText, lastMsgId: row.lastMsgId,
      lastIsSelf: row.lastIsSelf, newMsgCount: row.newMsgCount,
      relationLabelList: Array.isArray(row.relationLabelList) ? row.relationLabelList.filter(id => [8, 9].includes(id)) : null,
      encryptJobId: row.encryptJobId, jobName: row.jobName, jobId: row.jobId })) });
}
function readCurrentMessages() {
  const current = this.currentData$?.value ?? {};
  const list = this.historyMessage;
  return JSON.stringify({ accountId: window._PAGE?.uid, currentConversationId: current.uniqueId, currentPeerId: current.friendId,
    messages: Array.isArray(list) ? list.slice(-500).map(row => ({ mid: row.mid, serverMid: row.serverMid, isSelf: row.isSelf, fromName: row.fromName, text: row.type === 'text' ? row.text : '', time: row.time, type: row.type })) : null });
}
function readCurrentProfile() {
  const current = this.currentData$?.value ?? {};
  const detail = this.conversation ?? {};
  return JSON.stringify({ accountId: window._PAGE?.uid, currentConversationId: current.uniqueId, currentPeerId: current.friendId,
    profileConversationId: detail.uniqueId, profilePeerId: detail.uid ?? detail.friendId,
    profile: {
      name: detail.name, activeTimeDesc: detail.activeTimeDesc, year: detail.year, edu: detail.edu, ageDesc: detail.ageDesc,
      city: detail.city, position: detail.position, positionName: detail.positionName, toPosition: detail.toPosition,
      toPositionId: detail.toPositionId, jobId: detail.jobId,
      price: detail.price, salaryDesc: detail.salaryDesc, school: detail.school, major: detail.major,
      workExpList: Array.isArray(detail.workExpList) ? detail.workExpList.map(row => ({ timeDesc: row.timeDesc, company: row.company, positionName: row.positionName })) : null,
      eduExpList: Array.isArray(detail.eduExpList) ? detail.eduExpList.map(row => ({ timeDesc: row.timeDesc, school: row.school, major: row.major, degree: row.degree })) : null,
    } });
}
async function context(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CDP port is invalid');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3500) });
  if (!response.ok) throw new Error('CDP unavailable');
  const targets = (await response.json()).filter(row => { try { return row.type === 'page' && new URL(row.url).hostname === 'www.zhipin.com'; } catch { return false; } });
  const chat = targets.filter(row => /^\/web\/chat\/(?:index)?\/?$/.test(new URL(row.url).pathname));
  const search = targets.filter(row => /^\/web\/chat\/search\/?$/.test(new URL(row.url).pathname));
  const choices = chat.length ? chat : search;
  if (choices.length !== 1) throw Object.assign(new Error(choices.length ? '请只保留一个 BOSS 沟通页或搜索页，以确认读取来源。' : '请先在同一 Chrome 中打开已登录的 BOSS 搜索页或沟通页。'), { code: 'page_not_ready' });
  const connection = await Connection.open(choices[0], port);
  const group = `hr-messages-${randomUUID()}`;
  try {
    const state = await connection.send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.origin+location.pathname,ready:!!window.iBossRoot?.chat,accountId:window._PAGE?.uid})', returnByValue: true });
    const page = JSON.parse(state.result.value);
    if (!page.ready || !accountKey(page.accountId)) throw Object.assign(new Error('BOSS 聊天页面尚未加载或需要人工登录。'), { code: 'page_not_ready' });
    return { connection, group, page, targetId: choices[0].id };
  } catch (error) { connection.close(); throw error; }
}
async function cleanup(ctx) { if (ctx) { await ctx.connection.send('Runtime.releaseObjectGroup', { objectGroup: ctx.group }).catch(() => {}); ctx.connection.close(); } }

async function refreshNativeConversationList(ctx,cache) {
  const props=await properties(ctx.connection,cache.bridge.objectId,false);
  const refresh=props.result.find(row=>row.name==='refresh')?.value;
  if(refresh?.type!=='function'||!refresh.description.includes('getFriendsByLabel')||!refresh.description.includes(',null,!0)'))return {status:'shape_changed',message:'未识别出保留当前会话的原生刷新流程，未猜测同步接口。'};
  const paths=new Set(['/wapi/zprelation/friend/filterByLabel','/wapi/zprelation/friend/getBossFriendListV2.json']);
  const wire=[],requests=new Map();let wake;
  const completed=new Promise(resolve=>{wake=resolve});
  ctx.connection.on('Network.requestWillBeSent',event=>{try{const url=new URL(event.request.url);if(url.hostname==='www.zhipin.com'&&paths.has(url.pathname)){const row={path:url.pathname,method:event.request.method};wire.push(row);requests.set(event.requestId,row);}}catch{}});
  ctx.connection.on('Network.responseReceived',event=>{const row=requests.get(event.requestId);if(row)row.httpStatus=event.response.status;});
  ctx.connection.on('Network.loadingFinished',event=>{const row=requests.get(event.requestId);if(!row)return;ctx.connection.send('Network.getResponseBody',{requestId:event.requestId}).then(response=>{try{const data=JSON.parse(response.body);row.businessCode=data.code;if(Array.isArray(data.zpData?.result))row.resultCount=data.zpData.result.length;}catch{}row.finished=true;if(row.path.endsWith('filterByLabel'))wake();}).catch(()=>{row.finished=true;wake();});});
  await ctx.connection.send('Network.enable');
  const result=await ctx.connection.send('Runtime.callFunctionOn',{objectId:cache.bridge.objectId,functionDeclaration:'function(){this.refresh(true);return true}',returnByValue:true});
  if(result.exceptionDetails)return {status:'error',message:'BOSS原生会话列表刷新未完成。'};
  let timer;await Promise.race([completed,new Promise(resolve=>{timer=setTimeout(resolve,8000)})]);clearTimeout(timer);
  // A response event precedes the native Rx subscription's cache update.
  await new Promise(resolve=>setTimeout(resolve,250));
  for(let i=0;i<25&&wire.some(row=>!row.finished);i++)await new Promise(resolve=>setTimeout(resolve,100));
  const filter=wire.find(row=>row.path.endsWith('filterByLabel')),list=wire.find(row=>row.path.endsWith('getBossFriendListV2.json'));
  if(!filter||filter.method!=='POST'||filter.httpStatus!==200||filter.businessCode!==0||!Number.isInteger(filter.resultCount)||(list&&(list.method!=='POST'||list.httpStatus!==200||list.businessCode!==0||!list.finished)))return {status:'shape_changed',message:'原生刷新实际请求或状态与已验证契约不一致，未把旧缓存称为刷新成功。',wire};
  return {status:'ok',wire,mechanism:'native_preserve_current_chat_list_refresh',scope:'current_boss_list_filter'};
}

export async function getBossConversations({ port = 19222, refresh = false } = {}) {
  let ctx;
  try {
    ctx = await context(port);
    let cache = await friendStore(ctx.connection, ctx.group);
    if (!cache) return { status: 'shape_changed', message: '当前 BOSS 会话缓存实现已变化，无法只读识别列表；未将结果当作零会话。', conversations: [], meta: baseMeta() };
    const refreshed=refresh?await refreshNativeConversationList(ctx,cache):null;
    if(refreshed&&refreshed.status!=='ok')return {...refreshed,conversations:[],meta:{...baseMeta(),freshness:'refresh_failed',wire:refreshed.wire}};
    if(refreshed){cache=await friendStore(ctx.connection,ctx.group);if(!cache)return {status:'shape_changed',message:'原生刷新后会话缓存未就绪。',conversations:[],meta:baseMeta()};}
    const result = await ctx.connection.send('Runtime.callFunctionOn', { objectId: cache.store.objectId, functionDeclaration: readFriends.toString(), arguments: [{ objectId: cache.index.objectId }], objectGroup: ctx.group, returnByValue: true });
    if (result.exceptionDetails || typeof result.result?.value !== 'string') throw new Error('Cannot read cached conversations');
    const snapshot = JSON.parse(result.result.value);
    const normalized = normalizeBossConversations(snapshot);
    normalized.meta.unreadStateUnchanged = snapshot.beforeUnread === snapshot.afterUnread;
    normalized.meta.pageUrl = ctx.page.url;
    if(refreshed)Object.assign(normalized.meta,{freshness:'native_refreshed',refreshScope:refreshed.scope,refreshMechanism:refreshed.mechanism,wire:refreshed.wire});
    const currentStore = await currentConversationStore(ctx.connection, ctx.group);
    if (currentStore) {
      const ref = await ctx.connection.send('Runtime.callFunctionOn', { objectId: currentStore.objectId, functionDeclaration: 'function(){const c=this.currentData$?.value??{};return JSON.stringify({id:c.uniqueId,peerId:c.friendId})}', objectGroup: ctx.group, returnByValue: true });
      if (typeof ref.result?.value === 'string') { const selected = JSON.parse(ref.result.value); normalized.meta.currentConversationId = s(selected.id) || null; normalized.meta.currentPeerId = s(selected.peerId) || null; }
    }
    return normalized;
  } catch (error) { return { status: 'error', code: error.code ?? 'cdp_unavailable', message: error.code === 'page_not_ready' ? error.message : '无法只读读取 BOSS 消息，请检查 Chrome CDP 连接和页面状态。', conversations: [], meta: baseMeta() }; }
  finally { await cleanup(ctx); }
}

export async function getBossConversationMessages({ port = 19222, conversationId, peerId, sourceAccountKey, candidateExternalId, readonlyNative = false } = {}) {
  if(readonlyNative)return getBossNativeRecentHistory({port,conversationId,peerId,sourceAccountKey,candidateExternalId});
  let ctx;
  try {
    if (!s(conversationId)) return { status: 'error', code: 'invalid_conversation', message: '请先选择一条具体会话。', messages: [], meta: baseMeta() };
    ctx = await context(port);
    const store = await currentConversationStore(ctx.connection, ctx.group);
    if (!store) return { status: 'read_only_unavailable', message: '未找到可只读的当前会话缓存；不会自动打开会话或发送已读回执。', messages: [], meta: baseMeta() };
    const result = await ctx.connection.send('Runtime.callFunctionOn', { objectId: store.objectId, functionDeclaration: readCurrentMessages.toString(), objectGroup: ctx.group, returnByValue: true });
    if (result.exceptionDetails || typeof result.result?.value !== 'string') throw new Error('Cannot read cached messages');
    return normalizeBossCachedMessages(JSON.parse(result.result.value), { conversationId, peerId });
  } catch (error) { return { status: 'error', code: error.code ?? 'cdp_unavailable', message: error.code === 'page_not_ready' ? error.message : '当前会话历史无法只读读取；未自动打开会话或更改已读状态。', messages: [], meta: baseMeta() }; }
  finally { await cleanup(ctx); }
}

const HISTORY_PATH='/wapi/zpchat/boss/historyMsg';
const historyBusy=new Set(),historyPageSizes=new Map();
async function scopedHistoryClient(ctx,port) {
  const wrapper=await readFunction(ctx.connection,'window.iBossRoot?.chat?.updateChatList',ctx.group);
  if(!wrapper)return null;
  const info=await properties(ctx.connection,wrapper.objectId),scopeId=info.internalProperties?.find(row=>row.name==='[[Scopes]]')?.value?.objectId;
  if(!scopeId)return null;
  let query;
  for(const entry of (await properties(ctx.connection,scopeId)).result.filter(row=>row.value?.objectId&&row.value.description!=='Global')){
    query=(await properties(ctx.connection,entry.value.objectId)).result.find(row=>row.value?.type==='function'&&row.value.description?.includes(`"${HISTORY_PATH}"`))?.value;
    if(query)break;
  }
  if(!query)return null;
  const transportName=query.description.match(/return\s+([A-Za-z_$][0-9A-Za-z_$]*)\s*[(]/)?.[1],transport=transportName?await scopeVariable(ctx.connection,query.objectId,transportName):null;
  if(!transport?.description?.includes('.get('))return null;
  const location=info.internalProperties?.find(row=>row.name==='[[FunctionLocation]]')?.value?.value;
  if(!location?.scriptId)return null;
  const key=`${port}:${ctx.targetId}:${location.scriptId}`;let pageSize=historyPageSizes.get(key);
  if(!pageSize){
    await ctx.connection.send('Debugger.enable');
    const source=(await ctx.connection.send('Debugger.getScriptSource',{scriptId:location.scriptId})).scriptSource;
    const at=source.indexOf('getHistoryMessage:function'),start=source.lastIndexOf('data:function',at),snippet=source.slice(start,at);
    if(!snippet.includes('msgMinId:0')||!snippet.includes('page:1'))return null;
    pageSize=Number(snippet.match(/pageSize:([0-9]+)/)?.[1]);
    const handler=source.slice(at,at+1700);
    if(!/src:[\w$]+\.geek\.friendSource,gid:[\w$]+\.geek\.friendId,maxMsgId:[\w$]+\.msgMinId,c:[\w$]+\.pageSize,page:[\w$]+\.page/.test(handler)||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)return null;
    if(historyPageSizes.size>8)historyPageSizes.clear();historyPageSizes.set(key,pageSize);
  }
  return {query,pageSize};
}
async function queryRecentHistory(nativeQuery,conversationId,peerId,candidateExternalId,pageSize) {
  const id=value=>typeof value==='string'&&/^[0-9]+$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='bigint'&&value>=0n?String(value):value&&typeof value==='object'&&/^[0-9]+$/.test(String(value))?String(value):null;
  const row=this.getFriendByUniqueId(conversationId);
  if(!row||String(row.uniqueId)!==conversationId||id(row.friendId)!==peerId||(candidateExternalId&&row.encryptUid!==candidateExternalId))return JSON.stringify({scopeMismatch:true});
  const beforeUnread=this.getUnreadCount(),beforePeerUnread=row.newMsgCount;
  const response=await nativeQuery({src:row.friendSource,gid:row.friendId,maxMsgId:0,c:pageSize,page:1});
  const z=response?.zpData||{},accountId=id(window._PAGE?.uid);
  return JSON.stringify({accountId,conversationId,peerId,pageSize,businessCode:response?.code,businessMessage:response?.message,beforeUnread,afterUnread:this.getUnreadCount(),beforePeerUnread,afterPeerUnread:this.getFriendByUniqueId(conversationId)?.newMsgCount,hasMore:typeof z.hasMore==='boolean'?z.hasMore:null,minMsgId:id(z.minMsgId),messages:Array.isArray(z.messages)?z.messages.map(m=>({mid:id(m.mid),fromId:id(m.from?.uid),toId:id(m.to?.uid),time:m.time,bodyType:m.body?.type,text:m.body?.type===1&&typeof m.body?.text==='string'?m.body.text:'',nativeType:m.type})):null});
}

export function normalizeBossNativeRecentHistory(snapshot,{conversationId,peerId,sourceAccountKey}={}) {
  const scope=accountKey(snapshot?.accountId),meta=baseMeta({accountKey:scope,endpoint:HISTORY_PATH,mechanism:'page_native_history_query_only',coverage:'recent_history_page',conversationId,peerId,historyComplete:false,hasMore:typeof snapshot?.hasMore==='boolean'?snapshot.hasMore:null,page:1,pageSize:snapshot?.pageSize,noReadAckMethodCalled:true,unreadStateUnchanged:Number.isInteger(snapshot?.beforeUnread)&&snapshot?.beforeUnread===snapshot?.afterUnread,peerUnreadStateUnchanged:Number.isInteger(snapshot?.beforePeerUnread)&&snapshot?.beforePeerUnread===snapshot?.afterPeerUnread});
  const failure=(status,message)=>({status,message,messages:[],meta});
  if(!scope||snapshot?.scopeMismatch||snapshot?.conversationId!==conversationId||snapshot?.peerId!==peerId||(sourceAccountKey&&sourceAccountKey!==scope))return failure('permission_denied','历史消息账号、候选人或会话归属不一致，未导入。');
  if(Number(snapshot.businessCode)!==0){const message=String(snapshot.businessMessage||'');return failure(/登录|login/i.test(message)?'need_auth':/频繁|限流/.test(message)?'rate_limited':/验证|风控/.test(message)?'requires_review':'permission_denied','平台未返回本会话可读取的历史消息，未猜测或重试其他会话。');}
  if(!Array.isArray(snapshot.messages))return failure('shape_changed','原生历史接口未返回消息数组，未当作没有聊天记录。');
  const messages=[],seen=new Set();let rejectedCount=0;
  for(const row of snapshot.messages){
    if(typeof row.mid!=='string'||!/^\d+$/.test(row.mid)){rejectedCount++;continue;}if(seen.has(row.mid))continue;seen.add(row.mid);
    const textMessage=row.bodyType===1&&typeof row.text==='string';
    const fromOwn=row.fromId===String(snapshot.accountId),fromPeer=row.fromId===peerId,toOwn=row.toId===String(snapshot.accountId),toPeer=row.toId===peerId;
    if(textMessage&&!((fromOwn&&toPeer)||(fromPeer&&toOwn))){rejectedCount++;continue;}
    const sender=fromOwn?'hr':fromPeer?'candidate':'system';
    messages.push({externalId:row.mid,conversationExternalId:conversationId,sender,senderName:'',text:textMessage?row.text:row.bodyType===9?'[职业资料卡]':'[平台非文本消息]',sentAt:when(row.time),type:textMessage?'text':row.bodyType===9?'profile_card':'platform_event'});
  }
  Object.assign(meta,{capturedCount:messages.length,rejectedCount});
  if(rejectedCount)return {status:'partial',message:'已取得一页近期历史，部分消息身份或精确ID不符合契约，已排除。',messages,meta};
  return {status:messages.length?'partial':'no_data',message:messages.length?`已只读取得近期 ${messages.length} 条记录；仅一页，不代表完整历史，未调用已读或发送方法。`:'原生接口明确返回本页没有历史消息，未推断完整对话为空。',messages,meta};
}

export async function getBossNativeRecentHistory({port=19222,conversationId,peerId,sourceAccountKey,candidateExternalId}={}) {
  if(!s(conversationId)||!s(peerId))return {status:'error',code:'invalid_conversation',message:'历史查询需要明确的会话和沟通人ID。',messages:[],meta:baseMeta()};
  if(historyBusy.has(port))return {status:'error',code:'busy',message:'另一段历史正在读取，请稍后重试。',messages:[],meta:baseMeta()};
  historyBusy.add(port);let ctx;const wire={requestCount:0};
  try{
    ctx=await context(port);if(sourceAccountKey&&sourceAccountKey!==accountKey(ctx.page.accountId))return {status:'permission_denied',message:'当前BOSS账号与消息来源不一致，未发历史查询。',messages:[],meta:baseMeta()};
    const cache=await friendStore(ctx.connection,ctx.group),client=await scopedHistoryClient(ctx,port);
    if(!cache||!client)return {status:'read_only_unavailable',message:'未识别到已验证的原生只读历史客户端；未打开会话或发送已读。',messages:[],meta:baseMeta()};
    const requestIds=new Set();
    ctx.connection.on('Network.requestWillBeSent',event=>{try{const u=new URL(event.request.url);if(u.hostname==='www.zhipin.com'&&u.pathname===HISTORY_PATH){wire.requestCount++;wire.method=event.request.method;wire.parameterKeys=[...u.searchParams.keys()];requestIds.add(event.requestId);}}catch{}});
    ctx.connection.on('Network.responseReceived',event=>{if(requestIds.has(event.requestId))wire.httpStatus=event.response.status;});await ctx.connection.send('Network.enable');
    const result=await ctx.connection.send('Runtime.callFunctionOn',{objectId:cache.store.objectId,functionDeclaration:queryRecentHistory.toString(),arguments:[{objectId:client.query.objectId},{value:s(conversationId)},{value:s(peerId)},{value:s(candidateExternalId)},{value:client.pageSize}],objectGroup:ctx.group,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails||typeof result.result?.value!=='string')throw new Error('Native history query failed');
    const snapshot=JSON.parse(result.result.value);if(snapshot.scopeMismatch)return {status:'permission_denied',message:'该会话不在当前账号已加载缓存中，未发送历史请求。',messages:[],meta:baseMeta()};
    if(wire.requestCount!==1||wire.method!=='GET'||wire.httpStatus!==200)return {status:'shape_changed',message:'原生历史的请求数量、方式或状态与已验证契约不同，未导入。',messages:[],meta:{...baseMeta(),wire}};
    const normalized=normalizeBossNativeRecentHistory(snapshot,{conversationId:s(conversationId),peerId:s(peerId),sourceAccountKey});normalized.meta.wire=wire;return normalized;
  }catch(error){return {status:wire.httpStatus===429?'rate_limited':wire.httpStatus===401?'need_auth':'error',code:wire.httpStatus===429?'rate_limited':wire.httpStatus===401?'need_auth':error.code||'cdp_unavailable',message:wire.httpStatus===429?'BOSS历史查询提示限流，本轮应停止。':wire.httpStatus===401?'BOSS历史查询需要有效登录，本轮应停止。':'原生近期历史查询未完成；未打开会话、标为已读或发送消息。',messages:[],meta:{...baseMeta(),wire}};}
  finally{await cleanup(ctx);historyBusy.delete(port);}
}

/** Internal projection for the separate profile adapter; no raw profile leaves the page. */
export async function getBossConversationProfileSnapshot({ port = 19222 } = {}) {
  let ctx;
  try {
    ctx = await context(port);
    const store = await currentConversationStore(ctx.connection, ctx.group);
    if (!store) return { status: 'read_only_unavailable', message: '未找到当前会话的只读资料缓存。' };
    const result = await ctx.connection.send('Runtime.callFunctionOn', { objectId: store.objectId, functionDeclaration: readCurrentProfile.toString(), objectGroup: ctx.group, returnByValue: true });
    if (result.exceptionDetails || typeof result.result?.value !== 'string') throw new Error('Cannot read cached conversation profile');
    return { status: 'ok', snapshot: JSON.parse(result.result.value), pageUrl: ctx.page.url };
  } catch (error) { return { status: 'error', code: error.code ?? 'cdp_unavailable', message: error.code === 'page_not_ready' ? error.message : '无法只读读取当前会话资料，请检查 BOSS 页面。' }; }
  finally { await cleanup(ctx); }
}

const PROFILE_QUERY_PATH = '/wapi/zpjob/chat/geek/info';
const profileQueryBusy = new Set();
async function scopedProfileQuery(connection, group) {
  const wrapper = await readFunction(connection, 'window.iBossRoot?.chat?.updateChatList', group);
  if (!wrapper) return null;
  const info = await properties(connection, wrapper.objectId);
  const scopeId = info.internalProperties?.find(row => row.name === '[[Scopes]]')?.value?.objectId;
  if (!scopeId) return null;
  const scopes = await properties(connection, scopeId);
  for (const scope of scopes.result.filter(row => row.value?.objectId && row.value.description !== 'Global')) {
    const vars = await properties(connection, scope.value.objectId);
    const query = vars.result.find(row => row.value?.type === 'function' && row.value.description?.length < 800 && row.value.description.includes(`"${PROFILE_QUERY_PATH}"`) && /return\s+[A-Za-z_$][0-9A-Za-z_$]*\s*[(]/.test(row.value.description))?.value;
    if (!query) continue;
    const transportName = query.description.match(/return\s+([A-Za-z_$][0-9A-Za-z_$]*)\s*[(]/)?.[1];
    const transport = await scopeVariable(connection, query.objectId, transportName);
    // The observed native transport constructs params and calls Axios.get.
    if (!transport?.description?.includes('.get(')) return null;
    return query;
  }
  return null;
}
async function queryProfile(nativeClient, conversationId, peerId) {
  const row = this.getFriendByUniqueId(conversationId);
  if (!row || String(row.uniqueId) !== conversationId || String(row.friendId) !== peerId) return JSON.stringify({ scopeMismatch: true, accountId: window._PAGE?.uid });
  const beforeUnread = this.getUnreadCount();
  const response = await nativeClient({ uid: row.friendId, geekSource: row.friendSource, securityId: row.securityId });
  const data = response?.zpData?.data;
  const afterUnread = this.getUnreadCount();
  return JSON.stringify({ accountId: window._PAGE?.uid, currentConversationId: row.uniqueId, currentPeerId: row.friendId,
    profileConversationId: row.uniqueId, profilePeerId: data?.uid ?? data?.friendId,
    businessCode: response?.code, businessMessage: response?.message, profileStatus: response?.zpData?.status,
    beforeUnread, afterUnread,
    profile: data ? {
      name: data.name, activeTimeDesc: data.activeTimeDesc, year: data.year, edu: data.edu, ageDesc: data.ageDesc,
      city: data.city, position: data.position, positionName: data.positionName, toPosition: data.toPosition,
      toPositionId: data.toPositionId, jobId: data.jobId,
      price: data.price, salaryDesc: data.salaryDesc, school: data.school, major: data.major,
      workExpList: Array.isArray(data.workExpList) ? data.workExpList.map(work => ({ timeDesc: work.timeDesc, company: work.company, positionName: work.positionName })) : null,
      eduExpList: Array.isArray(data.eduExpList) ? data.eduExpList.map(edu => ({ timeDesc: edu.timeDesc, school: edu.school, major: edu.major, degree: edu.degree })) : null,
    } : null });
}

/** One native GET, only for a peer already present in this account's cache. */
export async function queryBossConversationProfileSnapshot({ port = 19222, conversationId, peerId, sourceAccountKey } = {}) {
  if (profileQueryBusy.has(port)) return { status: 'error', code: 'busy', message: '另一位沟通人的资料正在读取，请稍后重试。' };
  profileQueryBusy.add(port);
  let ctx;
  try {
    if (!s(conversationId) || !s(peerId)) return { status: 'error', code: 'invalid_conversation', message: '资料查询需要明确的会话与沟通人 ID。' };
    ctx = await context(port);
    if (sourceAccountKey && sourceAccountKey !== accountKey(ctx.page.accountId)) return { status: 'permission_denied', message: '当前 BOSS 账号与指定沟通资料来源不一致，未发送详情查询。' };
    const cache = await friendStore(ctx.connection, ctx.group);
    const query = await scopedProfileQuery(ctx.connection, ctx.group);
    if (!cache || !query) return { status: 'read_only_unavailable', message: '未识别出已验证的原生资料 GET 客户端；请先在 BOSS 中手动打开此会话加载资料。' };
    const wire = { requestCount: 0 };
    const requestIds = new Set();
    ctx.connection.on('Network.requestWillBeSent', event => {
      try { const url = new URL(event.request.url); if (url.hostname === 'www.zhipin.com' && url.pathname === PROFILE_QUERY_PATH) { wire.requestCount++; wire.method = event.request.method; wire.parameterKeys = [...url.searchParams.keys()]; requestIds.add(event.requestId); } } catch {}
    });
    ctx.connection.on('Network.responseReceived', event => { if (requestIds.has(event.requestId)) wire.httpStatus = event.response.status; });
    await ctx.connection.send('Network.enable');
    const result = await ctx.connection.send('Runtime.callFunctionOn', { objectId: cache.store.objectId, functionDeclaration: queryProfile.toString(), arguments: [{ objectId: query.objectId }, { value: s(conversationId) }, { value: s(peerId) }], objectGroup: ctx.group, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails || typeof result.result?.value !== 'string') throw new Error('Native profile query failed');
    const snapshot = JSON.parse(result.result.value);
    if (snapshot.scopeMismatch) return { status: 'error', code: 'scope_mismatch', message: '此沟通人不在当前账号的已加载会话中，未发送资料查询。' };
    if (Number(snapshot.businessCode) === 5003 || /操作过于频繁/.test(snapshot.businessMessage ?? '')) return { status: 'rate_limited', message: 'BOSS 提示查询频繁，已停止读取。' };
    if (Number(snapshot.businessCode) !== 0 || snapshot.profileStatus === -1) return { status: 'read_only_unavailable', message: 'BOSS 未返回可确认的资料，请在原页面检查会话权限或登录状态。' };
    if (wire.method !== 'GET' || wire.httpStatus !== 200 || wire.requestCount !== 1) return { status: 'shape_changed', message: '原生资料查询的实际请求方式或状态与已验证契约不一致，未交付资料。' };
    if (snapshot.beforeUnread !== snapshot.afterUnread) return { status: 'partial', message: '读取期间未读总数发生变化，可能有实时新消息；请核对 BOSS。', snapshot, wire, pageUrl: ctx.page.url };
    return { status: 'ok', snapshot, wire, pageUrl: ctx.page.url };
  } catch (error) { return { status: 'error', code: error.code ?? 'cdp_unavailable', message: '原生资料查询未完成；没有打开会话、发送消息或请求在线简历。' }; }
  finally { await cleanup(ctx); profileQueryBusy.delete(port); }
}
