import { digest, now } from './store.mjs';
import { reconcileConversationJob } from './job-mappings.mjs';

const short = (text, n = 180) => String(text || '').trim().slice(0, n);
const iso = value => value && Number.isFinite(new Date(value).valueOf()) ? new Date(value).toISOString() : null;

export function analyzeConversation(conversation, messages, requirement) {
  const relevant = messages.filter(row => row.conversationId === conversation.id && ['candidate', 'hr'].includes(row.sender)).sort((a, b) => (new Date(a.sentAt).valueOf() || 0) - (new Date(b.sentAt).valueOf() || 0));
  const runs = relevant.filter((row, i) => i === 0 || row.sender !== relevant[i - 1].sender);
  const candidateRuns = runs.filter(row => row.sender === 'candidate').length;
  const hrRuns = runs.filter(row => row.sender === 'hr').length;
  const last = relevant.at(-1);
  const listIsNewer = conversation.lastMessageAt && (!last?.sentAt || new Date(conversation.lastMessageAt) > new Date(last.sentAt));
  const lastSpeaker = listIsNewer ? conversation.lastSender || 'unknown' : last?.sender || conversation.lastSender || 'unknown';
  const latestText = listIsNewer ? conversation.lastMessage || '' : last?.text || conversation.lastMessage || '';
  const previewOnly = relevant.length > 0 && relevant.every(row => row.type === 'preview');
  const candidateMessages = relevant.filter(row => row.sender === 'candidate' && row.text);
  const lastCandidate = candidateMessages.at(-1);
  const evidence = lastCandidate ? [{ messageId: lastCandidate.id, quote: lastCandidate.text, sentAt: lastCandidate.sentAt, finding: '候选人原话，待人工核对' }] : latestText && lastSpeaker === 'candidate' ? [{ messageId: null, quote: latestText, sentAt: conversation.lastMessageAt, finding: '会话列表中的最后消息预览，尚未读取历史' }] : [];
  return {
    messageCount: relevant.length,
    roundCount: relevant.length && !previewOnly ? Math.min(candidateRuns, hrRuns) : null,
    summary: {
      generator: 'facts', overview: previewOnly ? `已保存 ${relevant.length} 条实际加载的最后消息预览；尚未读取双方完整历史，交流轮次待确认。` : relevant.length ? `已读取 ${relevant.length} 条双方消息、${Math.min(candidateRuns, hrRuns)} 轮往返；${conversation.historyComplete ? '来源标记该段历史完整' : '仅代表已采集片段'}。` : '目前仅有会话列表和最后消息预览，完整沟通轮次尚未确认。',
      lastSpeaker, nextAction: '', suggestion: '', reasons: [], questions: [], replyDraft: '', evidence,
      latestMessage: { sender: lastSpeaker, text: latestText, sentAt: listIsNewer ? conversation.lastMessageAt : last?.sentAt || conversation.lastMessageAt || null, isPreview: Boolean(listIsNewer || previewOnly || !relevant.length) },
      sourceScope: { loadedMessageCount: relevant.length, previewOnly, historyComplete: conversation.historyComplete === true, requirementId: requirement?.id || null, requirementVersion: requirement?.version || null, communicatedPosition: conversation.communicatedPosition || conversation.profile?.communicatedPosition || '' },
      note: '这里只记录已采集消息与来源范围；业务分析和回复草稿由提示词模板生成，需人工复核。',
    },
  };
}

export function upsertConversationBatch(state, rows) {
  state.conversations ??= []; state.messages ??= [];
  let imported = 0, updated = 0;
  for (const source of rows) {
    if (!source.externalId || !source.sourceAccountKey) throw new Error('会话缺少稳定标识或账号范围，未按人名合并。');
    const identity = `boss:${source.sourceAccountKey}:${source.externalId}`;
    let row = state.conversations.find(item => item.source === 'boss' && item.sourceAccountKey === source.sourceAccountKey && item.externalId === source.externalId);
    const fields = {
      externalId: String(source.externalId), source: 'boss', sourceAccountKey: source.sourceAccountKey,
      candidateExternalId: source.candidateExternalId || row?.candidateExternalId || '',
      communicatedJobExternalId:source.communicatedJobExternalId||row?.communicatedJobExternalId||'',communicatedJobNumericId:source.communicatedJobNumericId||row?.communicatedJobNumericId||'',communicatedPosition:source.communicatedPosition||row?.communicatedPosition||'',
      communicatedJobCapturedAt:source.communicatedJobExternalId?now():row?.communicatedJobCapturedAt||null,
      peerId: source.peerId ? String(source.peerId) : '', peerName: source.peerName || '姓名未提供', peerPosition: source.peerPosition || '', peerCompany: source.peerCompany || '',
      unreadCount: Number.isInteger(source.unreadCount) && source.unreadCount >= 0 ? source.unreadCount : null,
      lastMessage: String(source.lastMessage || ''), lastMessageAt: iso(source.lastMessageAt), lastSender: ['candidate', 'hr', 'system'].includes(source.lastSender) ? source.lastSender : 'unknown',
      initiator: ['candidate', 'hr'].includes(source.initiator) ? source.initiator : row?.initiator || 'unknown',
      sourceLabel: source.sourceLabel || 'BOSS 已加载会话', importedAt: now(), updatedAt: now(),
    };
    if (row) { Object.assign(row, fields); updated++; }
    else { row = { ...fields, id: `conv_${digest(identity).slice(0, 24)}`, createdAt: now(), communicationStatus: 'new', notes: '', historyComplete: false, candidateId: null, requirementId: null }; state.conversations.push(row); imported++; }
    if (!row.candidateId && source.candidateExternalId) {
      const match = state.candidates.find(item => item.source === 'boss' && item.sourceAccountKey === source.sourceAccountKey && item.externalId === source.candidateExternalId);
      if (match) row.candidateId = match.id;
    }
    if (source.lastMessageId && source.lastMessage && ['candidate', 'hr'].includes(source.lastSender)) {
      importMessageBatch(state, row.id, { status: 'partial', message: '已保存本次实际加载的最后消息，历史范围未确认。', meta: { accountKey: row.sourceAccountKey, historyComplete: false, coverage: 'observed_message_previews' }, messages: [{ externalId: String(source.lastMessageId), sender: source.lastSender, senderName: source.lastSender === 'candidate' ? row.peerName : '我方', text: source.lastMessage, sentAt: source.lastMessageAt, type: source.lastMessageType || 'preview' }] });
    }
    reconcileConversationJob(state,row);
    const analyzed = analyzeConversation(row, state.messages, state.requirements.find(item => item.id === row.requirementId));
    Object.assign(row, analyzed);
    if (!['closed', 'interview_ready'].includes(row.communicationStatus)) row.communicationStatus = analyzed.summary.lastSpeaker === 'candidate' ? 'needs_reply' : analyzed.summary.lastSpeaker === 'hr' ? 'waiting' : 'new';
  }
  ensureCandidateMaster(state);
  return { imported, updated };
}

export function importMessageBatch(state, conversationId, result) {
  state.messages ??= [];
  const conversation = state.conversations.find(row => row.id === conversationId);
  if (!conversation) throw new Error('会话不存在。');
  if (!result.meta?.accountKey || result.meta.accountKey !== conversation.sourceAccountKey) throw Object.assign(new Error('BOSS 登录账号与这条会话的来源账号不同，未混入其他账号消息。'), { statusCode: 409 });
  let imported = 0;
  for (const source of result.messages) {
    if (!source.externalId) throw new Error('消息缺少稳定标识，未保存不明确的消息。');
    const id = `msg_${digest(`${conversationId}:${source.externalId}`).slice(0, 24)}`;
    const fields = { id, externalId: String(source.externalId), conversationId, sender: ['candidate', 'hr', 'system'].includes(source.sender) ? source.sender : 'unknown', senderName: short(source.senderName, 100), text: String(source.text || ''), sentAt: iso(source.sentAt), type: source.type || 'text' };
    const existing = state.messages.find(row => row.id === id);
    if (existing) {
      if (fields.type !== 'preview' || existing.type === 'preview') Object.assign(existing, fields, { text: fields.text || existing.text, sentAt: fields.sentAt || existing.sentAt, sender: fields.sender === 'unknown' ? existing.sender : fields.sender, senderName: fields.senderName || existing.senderName });
    } else { state.messages.push({ ...fields, createdAt: now() }); imported++; }
  }
  conversation.historyComplete = result.meta?.historyComplete === true;
  const ordered = state.messages.filter(row => row.conversationId === conversationId).sort((a, b) => (new Date(a.sentAt).valueOf() || 0) - (new Date(b.sentAt).valueOf() || 0));
  const last = ordered.at(-1);
  if (last && (!conversation.lastMessageAt || new Date(last.sentAt) >= new Date(conversation.lastMessageAt))) { conversation.lastMessage = last.text; conversation.lastMessageAt = last.sentAt; conversation.lastSender = last.sender; }
  if (conversation.historyComplete && ordered[0] && ['candidate', 'hr'].includes(ordered[0].sender)) conversation.initiator = ordered[0].sender;
  Object.assign(conversation, analyzeConversation(conversation, state.messages, state.requirements.find(row => row.id === conversation.requirementId)), { updatedAt: now(), historyMeta: result.meta });
  if (!['closed', 'interview_ready'].includes(conversation.communicationStatus)) conversation.communicationStatus = conversation.summary.lastSpeaker === 'candidate' ? 'needs_reply' : conversation.summary.lastSpeaker === 'hr' ? 'waiting' : 'new';
  return { conversation, imported, messageCount: conversation.messageCount, roundCount: conversation.roundCount, status: result.status, message: result.message };
}
import { ensureCandidateMaster } from './candidate-master.mjs';
