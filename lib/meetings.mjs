import fs from 'node:fs/promises';
import path from 'node:path';
import { runLark } from './lark-cli.mjs';
import { larkArguments, normalizeLarkConnection, withLarkErrorContext } from './lark-context.mjs';
import { ROOT, digest, now, uid } from './store.mjs';

const failure = (message, code = 'meeting_unavailable') => Object.assign(new Error(message), { code, statusCode: 422 });
const dataOf = value => value?.data ?? value;
const text = value => typeof value === 'string' ? value : '';
async function invoke(args, runner = runLark, connection) {
  const prepared = larkArguments([...args, '--format', 'json'], connection);
  try { return dataOf(await runner(prepared, { timeoutMs: 60000 })); }
  catch (error) { throw withLarkErrorContext(error, connection); }
}
const connectionSource = connection => { const context = normalizeLarkConnection(connection); return { identity: context.identity, ...(context.profile ? { profile: context.profile, appId: context.appId } : {}), ...(context.tenantKey ? { tenantKey: context.tenantKey } : {}) }; };
function listOf(value, keys) { if (Array.isArray(value)) return value; for (const key of keys) if (Array.isArray(value?.[key])) return value[key]; return null; }
function idOf(row) { return String(row?.meeting_id ?? row?.id ?? ''); }
export async function listActiveMeetings({ runner = runLark, connection } = {}) {
  const context = normalizeLarkConnection(connection);
  if (context.identity === 'bot') return { status: 'meeting_id_required', meetings: [], message: '应用身份需要明确的会议 ID；请先在飞书让机器人入会并取得会议 ID，再读取会中内容。', sourceIdentity: context.identity, sourceProfile: context.profile, feishuConnection: context };
  const data = await invoke(['vc', '+meeting-list-active'], runner, connection);
  const rows = listOf(data, ['meetings', 'items', 'meeting_list']);
  if (!rows) throw failure('飞书当前会议列表结构发生变化，未当作没有会议。', 'shape_changed');
  return { meetings: rows.map(row => ({ id: idOf(row), meetingId: idOf(row), meetingNo: String(row.meeting_no ?? row.meeting_number ?? ''), title: row.topic || row.title || row.summary || '飞书会议', status: row.status, startAt: row.start_time })).filter(row => row.id), message: rows.length ? `发现 ${rows.length} 场当前可见会议。` : '当前用户没有可读取的进行中会议。', sourceIdentity: context.identity, ...(context.profile ? { sourceProfile: context.profile } : {}), feishuConnection: context };
}

export function parseMeetingReference(input) {
  const value = String(input || '').trim();
  if (!value || value.length > 2000) throw failure('请填写飞书会议、妙记或会议结果文档链接。', 'invalid_reference');
  if (/^https:\/\//.test(value)) {
    let url; try { url = new URL(value); } catch { throw failure('链接格式不正确。', 'invalid_reference'); }
    if (url.username || url.password || !/(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(url.hostname)) throw failure('请使用可信的飞书会议、妙记或文档链接。', 'invalid_reference');
    const match = url.pathname.match(/^\/(minutes|docx|wiki)\/([A-Za-z0-9_-]+)/);
    if (match) return { kind: match[1] === 'minutes' ? 'minutes' : 'document', id: match[2], url: `${url.origin}${url.pathname}` };
    const meeting = url.pathname.match(/^\/j\/([0-9]{9})\/?$/);
    if (meeting) return { kind: 'meeting_number', id: meeting[1] };
    throw failure('无法从此链接确定会议产物，请提供妙记/云文档链接，或 meeting:长会议ID、note:纪要ID。', 'invalid_reference');
  }
  if (/^[0-9]{9}$/.test(value)) return { kind: 'meeting_number', id: value };
  if (/^[0-9]{10,25}$/.test(value)) return { kind: 'meeting', id: value };
  const explicit = value.match(/^(meeting|note|minutes):([A-Za-z0-9_-]{3,120})$/);
  if (explicit) return { kind: explicit[1], id: explicit[2] };
  throw failure('裸标识类型不明确，请使用会议/妙记/云文档链接，或 note:、meeting: 前缀。', 'invalid_reference');
}
async function readDocument(reference, runner, connection) {
  const data = await invoke(['docs', '+fetch', '--doc', reference, '--doc-format', 'markdown'], runner, connection);
  const doc = data?.document ?? data;
  if (typeof doc?.content !== 'string' || !doc.content.trim()) throw failure('会议结果文档没有返回可读取正文，未生成空核验结果。', 'no_data');
  return { transcript: doc.content.slice(0, 200000), source: { kind: 'document', artifactType: 'document_content', reference, documentId: doc.document_id, revisionId: doc.revision_id, scope: '云文档正文；不默认视为逐字稿' }, status: 'ok', truncated: doc.content.length > 200000 };
}
async function readAllowedFile(file, directory) {
  const resolved = path.resolve(file), allowed = path.resolve(directory);
  if (!resolved.startsWith(allowed + path.sep)) throw failure('飞书返回的产物路径不在本次受控导入目录。', 'invalid_artifact_path');
  const stat = await fs.stat(resolved); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw failure('会议文字产物过大或不是可读文本文件。', 'invalid_artifact');
  const content = await fs.readFile(resolved, 'utf8'); if (!content.trim()) throw failure('会议文字产物为空。', 'no_data'); return content.slice(0, 200000);
}
async function readMinutes(id, runner, directory, connection) {
  const relative = './' + path.relative(ROOT, directory).split(path.sep).join('/');
  const data = await invoke(['minutes', '+detail', '--minute-tokens', id, '--transcript', '--output-dir', relative], runner, connection);
  const rows = listOf(data, ['minutes', 'items']); const item = rows?.find(row => row.minute_token === id);
  if (!item) throw failure('飞书妙记没有返回匹配的产物。', 'no_data');
  const file = item.artifacts?.transcript_file;
  if (!file) throw failure('该妙记尚未提供逐字稿，或当前用户没有读取权限。', 'transcript_unavailable');
  const transcript = await readAllowedFile(path.isAbsolute(file) ? file : path.resolve(ROOT, file), directory);
  return { transcript, status: 'ok', source: { kind: 'minutes', artifactType: 'transcript', minuteToken: id, title: item.title, scope: '该妙记返回的逐字稿' } };
}
async function readNote(id, runner, directory, connection) {
  const data = await invoke(['note', '+detail', '--note-id', id], runner, connection);
  const note = data?.note ?? data;
  const kind = note.note_display_type;
  if (kind === 'unified') {
    const output = path.join(directory, 'transcript.txt'); const relative = './' + path.relative(ROOT, output).split(path.sep).join('/');
    await invoke(['note', '+transcript', '--note-id', id, '--transcript-format', 'plain_text', '--output', relative], runner, connection);
    return { transcript: await readAllowedFile(output, directory), status: 'ok', source: { kind: 'note', noteId: id, artifactType: 'transcript', scope: '智能纪要 unified 完整分页逐字稿' } };
  }
  if (['normal', 'unknown'].includes(kind) && note.verbatim_doc_token) {
    const result = await readDocument(note.verbatim_doc_token, runner, connection);
    return { ...result, source: { ...result.source, kind: 'note', noteId: id, artifactType: 'transcript', scope: '智能纪要关联的文字记录文档' } };
  }
  throw failure('该智能纪要未提供可确定的逐字稿入口，请提供实际会议结果文档。', 'transcript_unavailable');
}
export async function importMeetingMaterial(urlOrId, { runner = runLark, connection, artifactRoot = path.join(ROOT, 'data/runtime/meeting-imports') } = {}) {
  const context = normalizeLarkConnection(connection);
  const finish = result => ({ ...result, source: { ...result.source, ...connectionSource(connection) }, feishuConnection: context, importedAt: now() });
  let reference = parseMeetingReference(urlOrId);
  if (reference.kind === 'document') return finish(await readDocument(reference.url, runner, connection));
  const directory = path.join(artifactRoot, uid('material')); await fs.mkdir(directory, { recursive: true });
  if (reference.kind === 'minutes') return finish(await readMinutes(reference.id, runner, directory, connection));
  if (reference.kind === 'note') return finish(await readNote(reference.id, runner, directory, connection));
  if (reference.kind === 'meeting_number') {
    const data = await invoke(['vc', '+search', '--query', reference.id], runner, connection);
    const matches = (listOf(data, ['meetings', 'items']) ?? []).filter(row => String(row.meeting_no ?? row.meeting_number ?? '') === reference.id);
    if (matches.length !== 1) throw failure('会议号没有唯一匹配，请提供明确的会议ID或会议结果链接。', 'ambiguous_meeting');
    reference = { kind: 'meeting', id: idOf(matches[0]) };
  }
  const detail = await invoke(['vc', '+detail', '--meeting-ids', reference.id], runner, connection);
  const rows = listOf(detail, ['meetings', 'items']) ?? (detail.meeting_id ? [detail] : []);
  const meeting = rows.find(row => String(row.meeting_id ?? row.id) === reference.id);
  if (!meeting) throw failure('未返回匹配的会议详情，未读取其他会议。', 'no_data');
  if (meeting.note_id) return finish({ ...await readNote(String(meeting.note_id), runner, directory, connection), meetingId: reference.id });
  if (meeting.minute_token) return finish({ ...await readMinutes(meeting.minute_token, runner, directory, connection), meetingId: reference.id });
  throw failure('该会议尚未生成当前用户可见的文字结果，请稍后重试或导入实际纪要文档。', 'transcript_unavailable');
}

export function normalizeMeetingEvents(data) {
  // CLI emits events:null, has_more:false when a saved cursor has no new events.
  const events = data?.events === null && data?.has_more === false ? [] : data?.events;
  if (!Array.isArray(events)) throw failure('飞书会中事件结构发生变化。', 'shape_changed');
  const segments = [];
  for (const event of events) {
    if (!['transcript_received', 'chat_received'].includes(event.event_type)) continue;
    const items = event.event_type === 'transcript_received' ? event.payload?.transcript_received_items : event.payload?.chat_received_items;
    if (!Array.isArray(items)) continue;
    for (let index = 0; index < items.length; index++) {
      const item = items[index]; if (event.event_type === 'chat_received' && Number(item.message_type) === 3) continue;
      const content = text(item.text) || text(item.content) || text(item.transcript?.text) || text(item.content?.text);
      if (!content.trim()) continue;
      const speaker = text(item.speaker?.name) || text(item.actor?.name) || text(event.actors?.[0]?.label) || '发言人未标注';
      const time = item.timestamp ?? item.time ?? event.event_time;
      // Sentence IDs identify a caption across repeated and corrected events.
      // Keep opaque IDs as strings; coercing a numeric ID can lose precision.
      const sentenceIdOf = value => typeof value === 'string' && /^[^\s\p{Cc}]{1,160}$/u.test(value) ? value : '';
      const sentenceId = event.event_type === 'transcript_received' ? sentenceIdOf(item.sentence_id) || sentenceIdOf(item.transcript?.sentence_id) : '';
      segments.push({ id: sentenceId ? `sentence:${sentenceId}` : `${event.event_id || digest(JSON.stringify(event)).slice(0, 20)}:${index}`, ...(sentenceId ? { sentenceId } : {}), eventId: event.event_id, kind: event.event_type, speaker, text: content, timestamp: time == null ? null : String(time) });
    }
  }
  return { segments, hasMore: data.has_more === true, pageToken: typeof data.page_token === 'string' ? data.page_token : '', warnings: data.warnings ?? [], scope: '当前身份可见的发言与会中聊天，不含未读取的共享文档内容' };
}
export async function readLiveMeeting({ meetingId, pageToken = '', runner = runLark, connection } = {}) {
  const context = normalizeLarkConnection(connection);
  let selected;
  if (context.identity === 'bot') {
    if (!meetingId) return { ...await listActiveMeetings({ runner, connection }), segments: [], source: { kind: 'live_meeting', ...connectionSource(connection) } };
    if (typeof meetingId !== 'string' || !/^[0-9]{10,25}$/.test(meetingId)) throw failure('应用身份读取会中内容需要明确的长会议 ID；九位会议号不能代替会议 ID。', 'invalid_reference');
    selected = { id: meetingId, title: '飞书面试会议' };
  } else {
    const active = await listActiveMeetings({ runner, connection });
    if (meetingId) selected = active.meetings.find(row => row.id === meetingId || row.meetingNo === meetingId);
    else if (active.meetings.length === 1) selected = active.meetings[0];
    if (!selected) return { status: active.meetings.length > 1 ? 'select_meeting' : 'no_active_meeting', message: active.meetings.length ? '请先选择一场当前可见的面试会议。' : active.message, meetings: active.meetings, segments: [], source: { kind: 'live_meeting', ...connectionSource(connection) }, feishuConnection: context };
  }
  const args = ['vc', '+meeting-events', '--meeting-id', selected.id, '--page-all']; if (pageToken) args.push('--page-token', pageToken);
  const normalized = normalizeMeetingEvents(await invoke(args, runner, connection));
  return { ...normalized, status: normalized.segments.length ? 'ok' : 'no_speech', message: normalized.segments.length ? `读取 ${normalized.segments.length} 段新增发言/聊天。` : '当前没有可解析的新增发言；可能尚未发言或未开放转写。', meetingId: selected.id, title: selected.title, source: { kind: 'live_meeting', ...connectionSource(connection), scope: normalized.scope }, feishuConnection: context, lastSyncAt: now() };
}
