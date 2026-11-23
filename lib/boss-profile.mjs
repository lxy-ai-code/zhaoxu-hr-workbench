import { createHash } from 'node:crypto';
import { getBossConversationProfileSnapshot, queryBossConversationProfileSnapshot } from './boss-messages.mjs';

const text = value => typeof value === 'string' ? value : '';
const id = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
export function normalizeBossConversationProfile(snapshot, { conversationId, peerId, sourceAccountKey, capturedAt = new Date().toISOString() } = {}) {
  const accountId = id(snapshot?.accountId);
  const accountKey = /^[1-9][0-9]*$/.test(accountId) ? createHash('sha256').update(accountId).digest('hex').slice(0, 16) : null;
  const meta = { accountKey, source: 'BOSS 当前已打开会话的原生资料缓存', coverage: 'current_open_conversation_profile_summary', capturedAt, readOnly: true, currentConversationId: id(snapshot?.currentConversationId) || null, currentPeerId: id(snapshot?.currentPeerId) || null, notes: '仅读取平台已加载资料卡摘要。未打开在线简历、未请求附件、未消耗道具，未获取联系方式。' };
  if (!accountKey) return { status: 'shape_changed', message: '无法确认 BOSS 账号归属，未读取候选资料。', profile: null, meta };
  if (sourceAccountKey && sourceAccountKey !== accountKey) return { status: 'permission_denied', message: 'BOSS 账号与沟通资料来源不一致，未合并跨账号岗位。', profile: null, meta };
  const requestedId = id(conversationId), requestedPeer = id(peerId);
  if (!requestedId || requestedId !== id(snapshot.currentConversationId) || requestedId !== id(snapshot.profileConversationId) || (requestedPeer && (requestedPeer !== id(snapshot.currentPeerId) || requestedPeer !== id(snapshot.profilePeerId)))) return { status: 'read_only_unavailable', message: '该会话的完整职业资料尚未在当前 BOSS 页面加载。请自行在 BOSS 中打开此会话，再回工作台读取；工作台不会自动打开或标记已读。', profile: null, meta };
  const source = snapshot.profile;
  if (!source || !text(source.name)) return { status: 'read_only_unavailable', message: 'BOSS 当前资料卡仍在加载，暂未取得可核对的职业信息。', profile: null, meta };
  const profile = {
    name: source.name, activeDesc: text(source.activeTimeDesc), workYear: text(source.year), degree: text(source.edu),
    age: text(source.ageDesc),
    city: text(source.city), position: text(source.position), salary: text(source.price), introduction: '',
    workHistory: Array.isArray(source.workExpList) ? source.workExpList.map(row => ({ company: text(row.company), position: text(row.positionName), ...(text(row.timeDesc) ? { dateRange: row.timeDesc } : {}) })).filter(row => row.company || row.position) : [],
    education: Array.isArray(source.eduExpList) ? source.eduExpList.map(row => ({ school: text(row.school), major: text(row.major), degree: text(row.degree), ...(text(row.timeDesc) ? { dateRange: row.timeDesc } : {}) })).filter(row => row.school || row.major || row.degree) : [],
    sourceAccountKey: accountKey,
    communicatedJobExternalId: text(source.toPositionId) || null,
    communicatedJobNumericId: /^[0-9]+$/.test(id(source.jobId)) && !/^0+$/.test(id(source.jobId)) ? id(source.jobId) : null,
    communicatedPosition: text(source.toPosition),
    communicatedSalary: text(source.salaryDesc),
    expectedPosition: text(source.position), expectedCity: text(source.city), expectedSalary: text(source.price),
    resumeAvailable: null, attachmentAvailable: null, sourceCapturedAt: capturedAt,
  };
  // Display-only facts. Never derive an age from dates, education or tenure;
  // model inputs and the analysis cache use separate professional allowlists.
  profile.displayMeta = Object.fromEntries([
    ['age','ageDesc'],['degree','edu'],['workYear','year'],['expectedSalary','price'],['expectedPosition','position'],['expectedCity','city'],['communicatedSalary','salaryDesc'],
  ].map(([field,sourceField])=>[field,{source:'boss_profile_summary',sourceField,capturedAt,status:profile[field]?'returned':'not_returned',...(field==='age'?{displayOnly:true}:{})}]));
  // Neither the absence of attachments nor a complete resume can be established
  // from this card's summary. Unknown fields remain empty/unknown, never invented.
  return { status: 'partial', message: '已读取当前会话的职业资料卡：活跃状态、年限学历、经历、教育及期望；在线简历和附件权限仍需在 BOSS 中确认。', profile, meta };
}

/**
 * Repairs the old chat-summary mapping, which treated the communication job's
 * salaryDesc as the candidate's expected pay. The page displays price for the
 * candidate's expectation. Search-card salaries have a different source and
 * are deliberately retained. This mutates only the supplied state, never I/O.
 */
export function migrateLegacyBossProfileSalary(state) {
  const report = { changed: false, profilesCleared: 0, candidateSalariesCleared: 0 };
  for (const conversation of state.conversations ?? []) {
    const profile = conversation.profile, meta = conversation.profileMeta;
    if (conversation.source !== 'boss' || !conversation.sourceAccountKey || !conversation.externalId || !conversation.peerId || !profile || !meta) continue;
    // The metadata must still belong to this exact account and native peer.
    if (meta.accountKey !== conversation.sourceAccountKey || profile.sourceAccountKey !== conversation.sourceAccountKey || id(meta.currentConversationId) !== id(conversation.externalId) || id(meta.currentPeerId) !== id(conversation.peerId)) continue;
    const salaryMeta = profile.displayMeta?.expectedSalary;
    if (salaryMeta?.sourceField === 'price') continue;
    const legacyField = salaryMeta?.source === 'boss_profile_summary' && salaryMeta.sourceField === 'salaryDesc';
    const nativeMechanism = ['page_native_profile_query', 'current_conversation_cache'].includes(meta.mechanism);
    if (!legacyField && !nativeMechanism) continue;
    const oldValues = new Set([text(profile.salary), text(profile.expectedSalary)].filter(Boolean));
    if (!oldValues.size) continue;
    const oldSalary = text(profile.salary) || text(profile.expectedSalary);
    profile.communicatedSalary ||= oldSalary;
    profile.salary = ''; profile.expectedSalary = '';
    profile.displayMeta ??= {};
    profile.displayMeta.communicatedSalary = { source: 'boss_profile_summary', sourceField: 'salaryDesc', capturedAt: salaryMeta?.capturedAt || meta.capturedAt || profile.sourceCapturedAt || null, status: 'returned' };
    profile.displayMeta.expectedSalary = { source: 'boss_profile_summary', sourceField: 'price', capturedAt: null, status: 'not_returned', reason: 'legacy_salaryDesc_removed' };
    report.profilesCleared++; report.changed = true;
    const candidate = (state.candidates ?? []).find(row => row.id === conversation.candidateId && row.source === 'boss' && row.sourceAccountKey === conversation.sourceAccountKey && row.externalId === conversation.candidateExternalId);
    if (!candidate || !oldValues.has(text(candidate.salary))) continue;
    const candidateSalaryMeta = candidate.displayMeta?.expectedSalary;
    if (candidateSalaryMeta?.sourceField === 'price') continue;
    // A reliable search/recommend snapshot is independent of the chat summary.
    const knownSearch = /搜索|推荐|已采集快照/.test(text(candidate.sourceLabel)) || /\/(?:geeks|searchRecommend)\.json(?:[?]|$)/.test(text(candidate.sourceEndpoint));
    if (knownSearch && candidateSalaryMeta?.sourceField !== 'salaryDesc') continue;
    candidate.communicatedSalary ||= candidate.salary;
    candidate.salary = '';
    if (oldValues.has(text(candidate.expectedSalary))) candidate.expectedSalary = '';
    candidate.displayMeta ??= {};
    candidate.displayMeta.expectedSalary = structuredClone(profile.displayMeta.expectedSalary);
    report.candidateSalariesCleared++;
  }
  return report;
}

export async function getBossConversationProfile({ port = 19222, conversationId, peerId, sourceAccountKey, refresh = false } = {}) {
  if (!id(conversationId)) return { status: 'error', code: 'invalid_conversation', message: '请先选择具体沟通人。', profile: null, meta: { accountKey: null, source: 'BOSS', coverage: 'none' } };
  let result = await getBossConversationProfileSnapshot({ port });
  if (result.status !== 'ok') return { ...result, profile: null, meta: { accountKey: null, source: 'BOSS', coverage: 'unavailable' } };
  let normalized = normalizeBossConversationProfile(result.snapshot, { conversationId, peerId, sourceAccountKey });
  normalized.meta.mechanism = 'current_conversation_cache';
  if (normalized.status === 'permission_denied') return normalized;
  if (normalized.status === 'read_only_unavailable' || refresh === true) {
    result = await queryBossConversationProfileSnapshot({ port, conversationId, peerId, sourceAccountKey });
    if (!['ok', 'partial'].includes(result.status) || !result.snapshot) return { status: result.status, message: result.message, profile: null, meta: { accountKey: normalized.meta.accountKey, source: 'BOSS 页面原生资料 GET 客户端', coverage: 'unavailable', mechanism: 'page_native_profile_query' } };
    normalized = normalizeBossConversationProfile(result.snapshot, { conversationId, peerId, sourceAccountKey });
    Object.assign(normalized.meta, { mechanism: 'page_native_profile_query', source: 'BOSS 页面原生资料 GET 客户端', coverage: 'one_conversation_profile_summary', endpoint: 'https://www.zhipin.com/wapi/zpjob/chat/geek/info', wire: result.wire, unreadStateUnchanged: result.snapshot.beforeUnread === result.snapshot.afterUnread });
  }
  normalized.meta.pageUrl = result.pageUrl;
  return normalized;
}
