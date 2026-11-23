import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { WORKSPACE_ROOT } from './runtime-config.mjs';
import { SCHEMA, toLarkField, validateSchema } from './schema.mjs';
import { runLark, locateLarkCli, LarkCliError, sanitize } from './lark-cli.mjs';
import { normalizeLarkConnection, sameLarkConnection, larkConnectionKey, larkArguments, larkErrorStatus, withLarkErrorContext } from './lark-context.mjs';
import { resolveInterviewRecipients, notificationEnabled } from './interview-recipients.mjs';

const operationDir = path.join(WORKSPACE_ROOT, 'data');
let writeQueue = Promise.resolve();
const locked = fn => { const task = writeQueue.then(fn, fn); writeQueue = task.catch(() => {}); return task; };
const dataOf = result => result?.data ?? result;
const runnerOf = options => options?.runner ?? runLark;
const idOf = value => typeof value === 'string' ? value : value?.id ?? value?.table_id;
const fail = (message, code = 'schema_changed', extra = {}) => new LarkCliError(message, { code, ...extra });
const fieldRef = (fieldMaps, table, field) => fieldMaps?.[table.key]?.[field.key] ?? { name: field.name };

function scalar(root, keys) {
  if (!root || typeof root !== 'object') return undefined;
  for (const key of keys) if (typeof root[key] === 'string' && root[key]) return root[key];
  for (const key of ['base', 'table', 'event', 'result', 'calendar', 'vchat', 'meeting']) { const found = scalar(root[key], keys); if (found) return found; }
}
function list(root, keys) {
  if (Array.isArray(root)) return root;
  for (const key of keys) if (Array.isArray(root?.[key])) return root[key];
  for (const key of keys) if (root?.[key] && typeof root[key] === 'object' && Object.values(root[key]).every(value => value && typeof value === 'object')) return Object.values(root[key]);
  if (root?.count === 0 || root?.total === 0) return [];
  throw fail('飞书返回的表或字段结构不符合当前 CLI 契约。');
}
function optionsFor(options, write = false) { return { timeoutMs: write ? 60000 : 45000, write, ...options?.commandOptions }; }
async function command(runner, args, options, write = false) {
  const prepared = larkArguments([...args, '--format', 'json'], options?.connection);
  try { return await runner(prepared, optionsFor(options, write)); }
  catch (error) { throw withLarkErrorContext(error, options?.connection); }
}
async function readJournal(options) {
  const directory = path.resolve(options?.journalDir ?? operationDir);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'feishu-operations.json');
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') state = {}; else throw fail('飞书操作回执文件不可读取；为避免重复创建，已停止外部写入。', 'journal_error'); }
  return { state, save: async () => { const temp = `${file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(state, null, 2)); await fs.rename(temp, file); } };
}

export function shanghaiISO(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string' || !value.trim()) throw fail('日期值必须是明确的 ISO 日期时间。', 'invalid_date');
  let text = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00+08:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)) text += '+08:00';
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) || !Number.isFinite(Date.parse(text))) throw fail('日期值无效，必须明确使用 Asia/Shanghai 或 ISO 时区偏移。', 'invalid_date');
  return text;
}

export async function getFeishuStatus(options = {}) {
  let connection;
  try {
    connection = normalizeLarkConnection(options.connection);
    const result = dataOf(await runnerOf(options)(larkArguments(['auth', 'status', '--json', '--verify'], options.connection, { identity: false }), optionsFor(options)));
    const actualAppId = result.appId ?? result.app_id ?? result.app?.appId ?? result.app?.app_id ?? result.profile?.appId ?? result.profile?.app_id;
    const actualTenant = result.tenantKey ?? result.tenant_key ?? result.tenant?.tenant_key;
    if ((connection.appId && actualAppId && connection.appId !== actualAppId) || (connection.tenantKey && actualTenant && connection.tenantKey !== actualTenant)) return { status: 'configuration_mismatch', message: '独立飞书 profile 的应用或租户与工作台保存的连接不一致，已停止使用。', feishuConnection: connection };
    const identity = result.identities?.[connection.identity];
    if (identity?.available === true && identity.verified !== false && !['missing', 'expired', 'revoked', 'failed', 'invalid'].includes(identity.tokenStatus) && !['missing', 'expired', 'revoked', 'failed', 'invalid', 'verify_failed'].includes(identity.status) && (identity.verified === true || result.verified !== false)) return { status: 'connected', message: connection.identity === 'bot' ? '飞书应用身份已验证；多维表、日历和会议仍需各自的应用权限与资源授权。' : '飞书用户身份已验证；具体资源访问权限需在使用时核验。', ...(connection.identity === 'user' ? { userName: identity.userName ?? identity.name } : {}), feishuConnection: connection, permissions: 'not_checked' };
    if (connection.identity === 'bot' && /11205|app do not have bot|bot.*not.*enabled|机器人.*(?:未开启|未启用)/i.test(identity?.message ?? '')) return { status: 'needs_bot', code: 'bot_not_enabled', upstreamCode: 11205, message: '独立飞书应用尚未启用机器人能力；请在应用后台添加机器人并发布生效。', upstreamMessage: sanitize(identity.message), feishuConnection: connection };
    const identityScopes = identity?.missingScopes ?? identity?.missing_scopes;
    const identityFailure = larkErrorStatus({ code: identity?.code ?? identity?.status, missingScopes: identityScopes });
    if (['permission_required', 'resource_forbidden', 'identity_unsupported'].includes(identityFailure)) return { status: identityFailure, code: identity?.code ?? identity?.status, message: sanitize(identity.message || '当前飞书身份缺少所需权限。'), ...(identityScopes ? { missingScopes: sanitize(identityScopes) } : {}), feishuConnection: connection };
    if (connection.identity === 'bot' && identity?.status === 'verify_failed') return { status: 'error', code: 'bot_verify_failed', message: sanitize(identity.message || '应用身份校验失败，请检查应用配置和连接状态。'), feishuConnection: connection };
    if (/codexsandbox/i.test(`${process.env.USERNAME ?? ''} ${os.userInfo().username}`)) return { status: 'error', message: '当前为隔离的 Windows 身份，无法据此判断桌面用户的凭据状态。请在用户 A 环境运行本地服务。', feishuConnection: connection };
    return { status: 'need_auth', message: `当前运行用户未取得可用的飞书${connection.identity === 'bot' ? '应用' : '用户'}凭据；请在该用户环境检查指定 profile 的 lark-cli auth status --json --verify。`, feishuConnection: connection, diagnostics: { actualAppId, effectiveIdentity: result.identity, identityStatus: identity?.status, available: identity?.available, identityMessage: sanitize(identity?.message), cliPath: options.runner ? undefined : await locateLarkCli(), user: os.userInfo().username, paths: Object.fromEntries(['USERPROFILE','APPDATA','LOCALAPPDATA','HOME','LARKSUITE_CLI_DATA_DIR','LARKSUITE_CLI_CONFIG_DIR'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])) } };
  } catch (error) {
    return { status: larkErrorStatus(error), code: error.code, message: sanitize(error.message), ...(error.missingScopes ? { missingScopes: sanitize(error.missingScopes) } : {}), ...(connection ? { feishuConnection: connection } : {}) };
  }
}

export async function resolveBase(url, options = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw fail('请填写完整飞书多维表链接。', 'invalid_url'); }
  if (parsed.protocol !== 'https:' || !/(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(parsed.hostname)) throw fail('多维表链接必须是 HTTPS 飞书或 Lark 链接。', 'invalid_url');
  const data = dataOf(await command(runnerOf(options), ['base', '+url-resolve', '--url', parsed.toString()], options));
  const baseToken = data.base_token ?? data.baseToken;
  if (!baseToken) throw fail('此链接未解析为数据 Base；BaseApp 或普通云文档不能直接作为数据容器。', 'invalid_base');
  return { baseToken, baseUrl: parsed.toString(), resourceType: data.resource_type, tableId: data.table_id, blockType: data.block_type };
}

async function tableList(baseToken, runner, options) {
  const result = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const data = dataOf(await command(runner, ['base', '+table-list', '--base-token', baseToken, '--limit', '100', '--offset', String(offset)], options));
    const items = list(data, ['tables', 'items', 'table_list']); result.push(...items);
    if (data.has_more !== true && data.hasMore !== true) return result;
    const next = data.next_offset ?? data.nextOffset;
    if (!Number.isInteger(next) || next <= offset) throw fail('飞书表分页未返回可继续的游标。');
    offset = next;
  }
  throw fail('表分页超出支持范围，未当作完整结果。', 'partial');
}
async function fieldsFor(baseToken, tableId, runner, options) {
  const result = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const data = dataOf(await command(runner, ['base', '+field-list', '--base-token', baseToken, '--table-id', tableId, '--limit', '200', '--offset', String(offset)], options));
    const items = list(data, ['fields', 'items', 'field_list']); result.push(...items);
    if (data.has_more !== true && data.hasMore !== true) return result;
    const next = data.next_offset ?? data.nextOffset;
    if (!Number.isInteger(next) || next <= offset) throw fail('飞书字段分页未返回可继续的游标。');
    offset = next;
  }
  throw fail('字段分页超出支持范围。', 'partial');
}
function findField(actual, previous, definition) {
  const previousId = typeof previous === 'string' ? previous : previous?.id;
  return (previousId && actual.find(item => (item.id ?? item.field_id) === previousId)) || actual.find(item => item.name === definition.name || item.field_name === definition.name);
}
function makeFieldMap(table, actual, oldMap = {}, requireAll = true) {
  const result = {};
  for (const f of table.fields) {
    const found = findField(actual, oldMap[f.key], f);
    if (!found) { if (requireAll) throw fail(`表“${table.name}”缺少字段“${f.name}”，请先初始化或修复表结构。`, 'missing_field'); else continue; }
    const expected = f.type === 'json' ? 'text' : f.type === 'date' ? 'datetime' : f.type;
    const actualType = found.type ?? found.field_type;
    if (actualType && actualType !== expected) throw fail(`字段“${table.name}.${f.name}”类型为 ${actualType}，预期 ${expected}；未自动覆盖。`, 'schema_mismatch');
    const id = found.id ?? found.field_id;
    if (!id) throw fail(`字段“${f.name}”缺少稳定字段 ID。`);
    result[f.key] = { id, name: found.name ?? found.field_name, type: expected };
  }
  return result;
}

export async function initializeBase(settings = {}, schema = SCHEMA, options = {}) {
  return locked(async () => {
    normalizeLarkConnection(options.connection);
    validateSchema(schema);
    const runner = runnerOf(options);
    const configured = { ...settings, tables: { ...settings.tables }, fieldMaps: structuredClone(settings.fieldMaps ?? {}) };
    const journal = await readJournal(options);
    const journalKey = `base:${options.connection ? larkConnectionKey(options.connection) + ':' : ''}${createHash('sha256').update(settings.baseName ?? '招序 HR · 招聘工作台').digest('hex')}`;
    try {
      if (configured.baseUrl) Object.assign(configured, await resolveBase(configured.baseUrl, options));
      if (!configured.baseToken) {
        const previous = journal.state[journalKey];
        if (previous?.baseToken) Object.assign(configured, { baseToken: previous.baseToken, baseUrl: previous.baseUrl ?? '' });
        else if (previous?.status === 'creating' || previous?.status === 'unknown_delivery') throw fail('上次创建 Base 的结果尚未确认；请先填写已创建的 Base 链接，避免重复创建。', 'unknown_delivery');
      }
      if (!configured.baseToken) {
        journal.state[journalKey] = { status: 'creating', at: new Date().toISOString() }; await journal.save();
        let created;
        try {
          const first = schema.tables[0];
          created = dataOf(await command(runner, ['base', '+base-create', '--name', settings.baseName || '招序 HR · 招聘工作台', '--time-zone', 'Asia/Shanghai', '--table-name', first.name, '--fields', JSON.stringify(first.fields.filter(f => f.type !== 'link').map(f => toLarkField(f)))], options, true));
        } catch (error) { journal.state[journalKey].status = error.code === 'unknown_delivery' ? 'unknown_delivery' : 'failed'; await journal.save(); throw error; }
        const token = scalar(created, ['base_token', 'baseToken']);
        if (!token) { journal.state[journalKey].status = 'unknown_delivery'; await journal.save(); throw fail('创建调用成功但未收到 Base 标识；请人工核验后填入链接。', 'unknown_delivery'); }
        configured.baseToken = token; configured.baseUrl = scalar(created, ['url', 'base_url', 'baseUrl']) ?? '';
        journal.state[journalKey] = { status: 'created', baseToken: token, baseUrl: configured.baseUrl, at: new Date().toISOString() }; await journal.save();
      } else await command(runner, ['base', '+base-get', '--base-token', configured.baseToken], options);
      const existing = await tableList(configured.baseToken, runner, options);
      for (const table of schema.tables) {
        const mapped = idOf(configured.tables[table.key]);
        let found = (mapped && existing.find(item => (item.id ?? item.table_id) === mapped)) || existing.find(item => item.name === table.name);
        if (!found) {
          const created = dataOf(await command(runner, ['base', '+table-create', '--base-token', configured.baseToken, '--name', table.name, '--fields', JSON.stringify(table.fields.filter(f => f.type !== 'link').map(f => toLarkField(f)))], options, true));
          const tableId = scalar(created, ['table_id', 'tableId', 'id']);
          if (!tableId || !/^tbl/.test(tableId)) throw fail(`表“${table.name}”已提交但未收到表 ID，请重新读取后恢复。`, 'unknown_delivery');
          found = { id: tableId, name: table.name }; existing.push(found);
        }
        configured.tables[table.key] = found.id ?? found.table_id;
      }
      for (const table of schema.tables) {
        const actual = await fieldsFor(configured.baseToken, configured.tables[table.key], runner, options);
        const missing = table.fields.filter(f => !findField(actual, configured.fieldMaps[table.key]?.[f.key], f));
        makeFieldMap(table, actual, configured.fieldMaps[table.key], false);
        if (missing.length) await command(runner, ['base', '+field-create', '--base-token', configured.baseToken, '--table-id', configured.tables[table.key], '--json', JSON.stringify(missing.map(f => toLarkField(f, configured.tables)))], options, true);
      }
      for (const table of schema.tables) {
        const actual = await fieldsFor(configured.baseToken, configured.tables[table.key], runner, options);
        configured.fieldMaps[table.key] = makeFieldMap(table, actual, configured.fieldMaps[table.key]);
      }
      return { baseUrl: configured.baseUrl ?? '', baseToken: configured.baseToken, tables: configured.tables, fieldMaps: configured.fieldMaps, settings: configured, status: 'ready' };
    } catch (error) { error.partialSettings = configured; throw error; }
  });
}

async function configuredSchema(settings, runner, options) {
  if (!settings?.baseToken && !settings?.baseUrl) throw fail('尚未配置飞书多维表，请先填写链接或初始化。', 'not_configured');
  const current = { ...settings, tables: { ...settings.tables }, fieldMaps: structuredClone(settings.fieldMaps ?? {}) };
  if (current.baseUrl) {
    const resolved = await resolveBase(current.baseUrl, options);
    if (current.baseToken && current.baseToken !== resolved.baseToken) throw fail('多维表链接与已保存的 Base 标识不一致，请先重新初始化映射。', 'configuration_mismatch');
    Object.assign(current, resolved);
  }
  if (SCHEMA.tables.some(table => !idOf(current.tables[table.key]))) {
    const tables = await tableList(current.baseToken, runner, options);
    for (const table of SCHEMA.tables) {
      const match = tables.find(item => item.name === table.name);
      if (!idOf(current.tables[table.key]) && match) current.tables[table.key] = match.id ?? match.table_id;
    }
  }
  for (const table of SCHEMA.tables) {
    const tableId = idOf(current.tables[table.key]);
    if (!tableId) throw fail(`未找到“${table.name}”表，请先初始化表结构。`, 'not_configured');
    current.tables[table.key] = tableId;
    current.fieldMaps[table.key] = makeFieldMap(table, await fieldsFor(current.baseToken, tableId, runner, options), current.fieldMaps[table.key]);
  }
  return current;
}
async function readRecords(settings, table, runner, options, projectionOnly = false) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hr-workbench-lark-'));
  const records = [];
  let offset = 0, revision;
  try {
    for (let page = 0; page < 1000; page++) {
      const basename = `page-${page}`;
      const args = ['base', '+record-list', '--base-token', settings.baseToken, '--table-id', settings.tables[table.key], '--limit', '2000', '--offset', String(offset), '--format', 'ndjson', '--output', `./${basename}.ndjson`];
      for (const f of projectionOnly ? table.fields.filter(f => f.key === 'id') : table.fields) args.push('--field-id', fieldRef(settings.fieldMaps, table, f).id ?? f.name);
      try { await runner(larkArguments(args, options?.connection), { ...optionsFor(options), cwd: tempRoot }); }
      catch (error) { throw withLarkErrorContext(error, options?.connection); }
      let manifest;
      for (const candidate of [`${basename}.manifest.json`, `${basename}.ndjson.manifest.json`]) { try { manifest = JSON.parse(await fs.readFile(path.join(tempRoot, candidate), 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (!manifest || typeof manifest.has_more !== 'boolean') throw fail(`表“${table.name}”缺少完整分页 manifest，未覆盖本地数据。`, 'partial');
      if (page === 0) revision = manifest.rev;
      else if (revision !== undefined && manifest.rev !== revision) throw fail(`读取“${table.name}”时版本变化，未把结果当作一致快照。`, 'partial');
      const text = await fs.readFile(path.join(tempRoot, `${basename}.ndjson`), 'utf8');
      const chunk = text.trim() ? text.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
      if (manifest.records_count !== undefined && chunk.length !== manifest.records_count) throw fail(`表“${table.name}”导出行数与声明不符。`, 'partial');
      records.push(...chunk);
      if (!manifest.has_more) return records;
      if (!Number.isInteger(manifest.next_offset) || manifest.next_offset <= offset || !chunk.length) throw fail(`表“${table.name}”分页游标无效。`, 'partial');
      offset = manifest.next_offset;
    }
    throw fail(`表“${table.name}”超出本地桥接分页上限。`, 'partial');
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('hr-workbench-lark-')) await fs.rm(resolved, { recursive: true, force: true });
  }
}
function idMap(records, settings, table) {
  const name = fieldRef(settings.fieldMaps, table, table.fields[0]).name;
  const result = {};
  for (const record of records) {
    const id = record[name];
    if (typeof id !== 'string' || !id.trim() || !record.record_id) throw fail(`“${table.name}”存在缺少工作台 ID 的行，未自动合并。`, 'invalid_record');
    if (result[id]) throw fail(`“${table.name}”存在重复工作台 ID：${id}，未进行模糊合并。`, 'duplicate_id');
    result[id] = record.record_id;
  }
  return result;
}

export function recordFields(row, table, settings, recordMaps) {
  if (!row?.id || typeof row.id !== 'string') throw fail(`“${table.name}”本地行缺少 ID。`, 'invalid_record');
  const result = {};
  for (const f of table.fields) {
    const ref = fieldRef(settings.fieldMaps, table, f);
    const key = ref.id ?? ref.name ?? f.name;
    let value = f.key === '_snapshot' ? sanitize(row) : row[f.key];
    if(table.key==='candidates'){
      if(f.key==='poolStatus')value=row.pool?'已入池':'待筛选';
      if(f.key==='poolJoinedAt')value=row.pool?.joinedAt??null;
      if(f.key==='poolPrimaryChannel')value=row.pool?.primaryChannel||'';
      if(f.key==='poolSources')value=row.pool?.sources||[];
    }
    if (value === undefined) continue;
    if (value === null) { result[key] = f.type === 'link' || f.type === 'select' ? [] : null; continue; }
    if (f.type === 'json') value = JSON.stringify(sanitize(value));
    else if (f.type === 'text') value = typeof value === 'string' ? value : JSON.stringify(value);
    else if (f.type === 'number') { if (value === '') value = null; else { value = Number(value); if (!Number.isFinite(value)) throw fail(`${f.name} 不是有效数字。`, 'invalid_record'); } }
    else if (f.type === 'date') value = value === '' ? null : shanghaiISO(value);
    else if (f.type === 'select') { value = Array.isArray(value) ? value : [String(value)]; if (value.length > 1 || value.some(item => !f.options.includes(item))) throw fail(`${f.name} 包含未定义选项。`, 'invalid_record'); }
    else if (f.type === 'link') {
      const ids = (Array.isArray(value) ? value : [value]).filter(Boolean);
      value = ids.map(id => { const recordId = recordMaps[f.relation]?.[typeof id === 'object' ? id.id : id]; if (!recordId) throw fail(`关联“${f.name}”尚未成功同步，已保留本地数据。`, 'missing_relation'); return { id: recordId }; });
    }
    result[key] = value;
  }
  return result;
}
function returnedRecordIds(data) {
  if (Array.isArray(data?.record_id_list)) return data.record_id_list;
  if (Array.isArray(data?.record_ids)) return data.record_ids;
  if (Array.isArray(data?.records)) return data.records.map(record => record.record_id ?? record.id);
  return [];
}

export async function syncWorkspace(workspace, options = {}) {
  return locked(async () => {
    const runner = runnerOf(options);
    const settings = await configuredSchema(workspace.settings, runner, options);
    const recordMaps = {};
    const results = [];
    let synced = 0, failed = 0;
    for (const table of SCHEMA.tables) {
      const rows = workspace[table.key] ?? [];
      try {
        recordMaps[table.key] = idMap(await readRecords(settings, table, runner, options, true), settings, table);
        const localIds = new Set();
        const create = [], update = [];
        for (const row of rows) {
          if (localIds.has(row.id)) throw fail(`本地“${table.name}”有重复 ID。`, 'duplicate_id');
          localIds.add(row.id);
          const fields = recordFields(row, table, settings, recordMaps);
          const recordId = recordMaps[table.key][row.id];
          (recordId ? update : create).push({ row, fields, recordId });
        }
        let completed = 0;
        try {
          for (let index = 0; index < create.length; index += 100) {
            const batch = create.slice(index, index + 100);
            const data = dataOf(await command(runner, ['base', '+record-batch-create', '--base-token', settings.baseToken, '--table-id', settings.tables[table.key], '--json', JSON.stringify({ create_records: batch.map(item => item.fields) })], options, true));
            const ids = returnedRecordIds(data);
            if (ids.length !== batch.length || ids.some(id => typeof id !== 'string' || !id)) throw fail('新增记录已提交，但回执数量不匹配；下次同步将先读取工作台 ID 核对，未自动重试。', 'unknown_delivery');
            batch.forEach((item, i) => { recordMaps[table.key][item.row.id] = ids[i]; }); completed += batch.length;
          }
          for (let index = 0; index < update.length; index += 100) {
            const batch = update.slice(index, index + 100);
            const data = dataOf(await command(runner, ['base', '+record-batch-update', '--base-token', settings.baseToken, '--table-id', settings.tables[table.key], '--json', JSON.stringify({ update_records: Object.fromEntries(batch.map(item => [item.recordId, item.fields])) })], options, true));
            if (data.ignored_fields && Object.keys(data.ignored_fields).length) throw fail('飞书忽略了部分字段，未将其标记为完整同步。', 'partial');
            completed += batch.length;
          }
          synced += completed;
          results.push({ table: table.key, name: table.name, status: 'synced', count: completed, created: create.length, updated: update.length });
        } catch (error) { synced += completed; failed += rows.length - completed; results.push({ table: table.key, name: table.name, status: error.status ?? error.code ?? 'error', code: error.code, count: completed, failed: rows.length - completed, message: sanitize(error.message), ...(error.missingScopes ? { missingScopes: sanitize(error.missingScopes) } : {}) }); }
      } catch (error) { failed += rows.length; results.push({ table: table.key, name: table.name, status: error.status ?? error.code ?? 'error', code: error.code, count: 0, failed: rows.length, message: sanitize(error.message), ...(error.missingScopes ? { missingScopes: sanitize(error.missingScopes) } : {}) }); }
    }
    settings.recordMaps = recordMaps;
    const failedTables = results.filter(result => result.status !== 'synced').length;
    return { settings, synced, failed, failedTables, results, recordMaps, status: failedTables ? 'partial' : 'synced' };
  });
}

function fromCell(value, f, reverseMaps) {
  if (value === null || value === undefined) return value;
  if (f.type === 'json') { if (value === '') return null; try { return JSON.parse(value); } catch { throw fail(`“${f.name}”不是有效 JSON，未覆盖本地数据。`, 'invalid_record'); } }
  if (f.type === 'select') return Array.isArray(value) ? value[0] ?? '' : value;
  if (f.type === 'link') {
    if (!Array.isArray(value)) throw fail(`“${f.name}”不是关联字段数组。`);
    const ids = value.map(item => { const id = reverseMaps[f.relation]?.[item.id]; if (!id) throw fail(`“${f.name}”关联到未读取的记录。`, 'missing_relation'); return id; });
    if (ids.length > 1) throw fail(`“${f.name}”出现多个关联，当前本地模型只支持一个。`, 'invalid_record');
    return ids[0] ?? null;
  }
  return value;
}

export async function readWorkspaceFromBase(settings, options = {}) {
  const runner = runnerOf(options);
  const current = await configuredSchema(settings, runner, options);
  const rows = {}, recordMaps = {}, reverseMaps = {};
  for (const table of SCHEMA.tables) {
    rows[table.key] = await readRecords(current, table, runner, options);
    recordMaps[table.key] = idMap(rows[table.key], current, table);
    reverseMaps[table.key] = Object.fromEntries(Object.entries(recordMaps[table.key]).map(([id, remoteId]) => [remoteId, id]));
  }
  const result = { results: [], recordMaps };
  for (const table of SCHEMA.tables) {
    result[table.key] = rows[table.key].map(record => {
      const snapshotName = fieldRef(current.fieldMaps, table, table.fields.find(f => f.key === '_snapshot')).name;
      let row = {};
      if (record[snapshotName]) { try { row = JSON.parse(record[snapshotName]); } catch { throw fail(`“${table.name}”结构化快照损坏，未覆盖本地数据。`, 'invalid_record'); } }
      if (!row || Array.isArray(row) || typeof row !== 'object') throw fail(`“${table.name}”结构化快照必须为对象。`, 'invalid_record');
      for (const f of table.fields) {
        if (f.key === '_snapshot') continue;
        const name = fieldRef(current.fieldMaps, table, f).name;
        if (Object.hasOwn(record, name)) row[f.key] = fromCell(record[name], f, reverseMaps);
      }
      if (typeof row.id !== 'string' || !row.id) throw fail(`“${table.name}”行缺少工作台 ID。`, 'invalid_record');
      return sanitize(row);
    });
    result.results.push({ table: table.key, name: table.name, status: 'complete', count: result[table.key].length });
  }
  return result;
}

function plain(text) { return String(text ?? '').replace(/[\\`*_{}\[\]()#+.!|<>]/g, '\\$&'); }
export function assertCalendarConnection(interview, connection) {
  const current = normalizeLarkConnection(connection);
  if (interview?.eventId && !sameLarkConnection(interview.feishuConnection, connection)) throw fail('该面试的已有日程来自另一飞书连接或历史用户身份；请先核对原日程，未复用或重复创建。', 'calendar_context_mismatch', { statusCode: 409, feishuConnection: current });
  return current;
}

export async function hydrateInterviewCalendar(interview, options = {}) {
  if (!interview?.eventId || typeof interview.eventId !== 'string') throw fail('读取日程链接需要本场已创建的日程 ID。', 'calendar_event_required');
  const connection = assertCalendarConnection(interview, options.connection);
  const calendarId = interview.calendarId || options.settings?.calendarId || (connection.identity === 'user' ? 'primary' : '');
  if (!calendarId) throw fail('读取日程链接需要本场日程的明确日历 ID。', 'not_configured');
  const data = dataOf(await command(runnerOf(options), ['calendar', '+get', '--calendar-id', calendarId, '--event-id', interview.eventId], options));
  const event = data?.event ?? data;
  if (!event || (event.event_id ?? event.eventId) !== interview.eventId) throw fail('飞书返回的日程与本场 ID 不一致，未补入其他日程的链接。', 'calendar_event_mismatch');
  const calendarUrl = scalar(event, ['app_link', 'appLink', 'calendar_url', 'calendarUrl']) || interview.calendarUrl || '';
  const meetingUrl = scalar(event.vchat, ['meeting_url', 'meetingUrl']) || scalar(event, ['meeting_url', 'meetingUrl']) || interview.meetingUrl;
  const complete = Boolean(calendarUrl && meetingUrl);
  return { eventId: interview.eventId, calendarId, calendarUrl, meetingUrl, feishuConnection: connection, metadataStatus: complete ? 'complete' : 'partial', metadataFetchedAt: new Date().toISOString(), metadataNotice: complete ? '' : '日程已存在，部分链接尚未返回，可稍后刷新。' };
}

// Adds only the explicitly selected business interviewers to one known event.
// The caller owns its durable per-recipient delivery ledger; an uncertain native
// receipt is never retried here and never causes a second calendar to be made.
export async function inviteInterviewCalendarRecipients(interview, recipients, options = {}) {
  const connection = assertCalendarConnection(interview, options.connection);
  if (connection.identity !== 'bot' || !interview?.eventId || !interview.calendarId || ['cancelled','canceled','deleted'].includes(interview.status)) throw fail('邀请面试官需要当前应用已创建且未取消的明确日程。', 'calendar_not_synced');
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > 20 || recipients.some(row => !row || !/^ou_[A-Za-z0-9_-]{1,200}$/.test(row.openId || ''))) throw fail('请指定已确认的飞书面试官 open_id，不能用姓名或外部邮箱代替。', 'invalid_attendee');
  const ids = [...new Set(recipients.map(row => row.openId))];
  const data = dataOf(await command(runnerOf(options), ['calendar','event.attendees','create',
    '--params', JSON.stringify({ calendar_id: interview.calendarId, event_id: interview.eventId, user_id_type: 'open_id' }),
    '--data', JSON.stringify({ add_operator_to_attendee: false, need_notification: true, attendees: ids.map(user_id => ({ type: 'user', user_id, is_optional: false })) }),
  ], options, true));
  const attendees = Array.isArray(data?.attendees) ? data.attendees : [];
  const confirmed = ids.map(id => attendees.find(row => row.type === 'user' && row.user_id === id && row.attendee_id && row.rsvp_status !== 'removed'));
  if (confirmed.some(row => !row)) throw fail('添加面试官未返回完整的逐人日程回执，请核验本场日程，未自动重发邀请。', 'unknown_delivery');
  return { status: 'invited', eventId: interview.eventId, calendarId: interview.calendarId, feishuConnection: connection,
    ...(ids.length === 1 ? { recipientOpenId: ids[0], attendeeId: confirmed[0].attendee_id } : {}),
    attendees: confirmed.map(row => ({ openId: row.user_id, attendeeId: row.attendee_id, rsvpStatus: row.rsvp_status || 'needs_action' })) };
}

export async function createInterviewCalendar(interview, { candidate, requirement, document, settings = {} } = {}, options = {}) {
  return locked(async () => {
    if (!interview?.id) throw fail('面试草案缺少 ID。', 'invalid_interview');
    const connection = assertCalendarConnection(interview, options.connection);
    if (interview.eventId) return { eventId: interview.eventId, calendarId: interview.calendarId || settings.calendarId || 'primary', calendarUrl: interview.calendarUrl ?? '', meetingUrl: interview.meetingUrl, ...(Array.isArray(interview.calendarInviteeIds) ? { calendarInviteeIds: structuredClone(interview.calendarInviteeIds) } : {}), status: 'scheduled', reused: true, feishuConnection: connection };
    const start = shanghaiISO(interview.startAt), end = shanghaiISO(interview.endAt);
    if (Date.parse(end) <= Date.parse(start)) throw fail('面试结束时间必须晚于开始时间。', 'invalid_date');
    if (Date.parse(end) <= Date.now()) throw fail('不能创建已完全过去的面试日程。', 'invalid_date');
    const calendarId = settings.calendarId || 'primary';
    if (connection.identity === 'bot' && !settings.calendarId) throw fail('应用身份创建日程前，请先指定已向该应用授权的日历 ID。', 'not_configured');
    const legacyKey = `interview:${interview.id}:${interview.revision ?? 1}:${start}:${end}`;
    const key = options.connection ? `${legacyKey}:${larkConnectionKey(options.connection)}:${calendarId}` : legacyKey;
    const journal = await readJournal(options);
    // A legacy receipt remains evidence of an existing/uncertain external write.
    // Changing profiles must not silently create a second invitation.
    const legacy = options.connection && journal.state[legacyKey];
    if (legacy && ['scheduled', 'creating', 'unknown_delivery'].includes(legacy.status)) throw fail('这场面试存在历史连接的日程回执；请先核对原日程，未跨应用复用或重复创建。', 'calendar_context_mismatch', { statusCode: 409, feishuConnection: connection });
    if (options.connection && Object.entries(journal.state).some(([receiptKey, receipt]) => receiptKey.startsWith(legacyKey + ':') && receiptKey !== key && ['scheduled', 'creating', 'unknown_delivery'].includes(receipt?.status))) throw fail('这场面试在另一飞书连接或日历下已有日程回执；请先核对，未重复创建。', 'calendar_context_mismatch', { statusCode: 409, feishuConnection: connection });
    const previous = journal.state[key];
    if (previous?.status === 'scheduled') { assertCalendarConnection(previous.result, options.connection); return { ...previous.result, reused: true }; }
    if (previous && ['creating', 'unknown_delivery'].includes(previous.status)) throw fail('这场面试上次建会结果尚未确认；请先核对飞书日历，未自动重复创建。', 'unknown_delivery');
    const rawAttendees = interview.attendeeIds ?? interview.interviewerIds ?? [];
    const ids = (Array.isArray(rawAttendees) ? rawAttendees : String(rawAttendees).split(/[，,\s]+/)).filter(Boolean);
    if (notificationEnabled({ settings }, interview, 'invitation')) ids.push(...resolveInterviewRecipients({ settings }, interview, 'invitation').map(person => person.openId));
    if (/^ou_[A-Za-z0-9]+$/.test(interview.interviewer ?? '')) ids.push(interview.interviewer);
    const interviewerUnresolved = interview.interviewer && !ids.length;
    const meetingOwnerId = interview.meetingOwnerOpenId || interview.meetingOwnerId || settings.interviewAutomation?.meetingOwnerOpenId || settings.interviewAutomation?.ownerOpenId || settings.meetingOwnerId;
    if (meetingOwnerId && !/^ou_[A-Za-z0-9_-]{1,200}$/.test(meetingOwnerId)) throw fail('视频会议归属者必须使用已确认的本租户用户 open_id。', 'invalid_meeting_owner');
    if (meetingOwnerId && connection.identity !== 'bot') throw fail('指定视频会议归属者只支持应用身份在应用日历上创建日程。', 'identity_unsupported');
    if (meetingOwnerId) ids.push(meetingOwnerId);
    if (ids.some(id => typeof id !== 'string' || !/^(?:ou_|oc_|omm_)[A-Za-z0-9_-]{1,200}$/.test(id))) throw fail('参会人只能使用已解析的飞书用户/群/会议室 ID，不能使用姓名代替。', 'invalid_attendee');
    const marker = createHash('sha256').update(key).digest('hex').slice(0, 20);
    const description = [`候选人：${plain(candidate?.name ?? '')}`, `招聘岗位：${plain(requirement?.title ?? '')}`, `面试轮次：${plain(interview.round ?? '')}`, `面试官：${plain(interview.interviewer ?? '')}`, `地点：${plain(interview.location ?? '')}`, `时区：Asia/Shanghai`, document ? '面试资料与问题清单已在 HR 工作台准备。' : '', `工作台面试标识：${marker}`].filter(Boolean).join('\n\n');
    const args = ['calendar', '+create', '--calendar-id', calendarId, '--summary', interview.title || '招聘面试', '--start', start, '--end', end, '--description', description];
    if (ids.length) args.push('--attendee-ids', [...new Set(ids)].join(','));
    if (meetingOwnerId) args.push('--meeting-owner-id', meetingOwnerId);
    journal.state[key] = { status: 'creating', at: new Date().toISOString(), marker }; await journal.save();
    let eventWasCreated = false, result;
    try {
      const data = dataOf(await command(runnerOf(options), args, options, true));
      const eventId = scalar(data, ['event_id', 'eventId']);
      if (!eventId) throw fail('飞书创建调用成功但未收到日程 ID，请人工核验，未自动重试。', 'unknown_delivery');
      eventWasCreated = true;
      result = { eventId, calendarId: scalar(data, ['calendar_id', 'calendarId']) ?? calendarId, calendarUrl: scalar(data, ['app_link', 'appLink', 'calendar_url', 'calendarUrl']) ?? '', meetingUrl: scalar(data, ['meeting_url', 'meetingUrl']), ...(meetingOwnerId ? { meetingOwnerId } : {}), calendarInviteeIds: [...new Set(ids)], calendarReminderMinutes: 5, status: 'scheduled', idempotencyKey: key, feishuConnection: connection, ...(interviewerUnresolved ? { notice: '面试官姓名已写入描述；该姓名未解析为飞书 ID，未向该姓名另发邀请。' } : {}) };
      // Commit the successful event receipt before optional metadata reads.
      journal.state[key] = { status: 'scheduled', result, at: new Date().toISOString() }; await journal.save();
    } catch (error) {
      if (eventWasCreated) error.code = 'unknown_delivery';
      journal.state[key] = { status: error.code === 'unknown_delivery' ? 'unknown_delivery' : 'failed', marker, at: new Date().toISOString(), message: sanitize(error.message) };
      try { await journal.save(); } catch { if (eventWasCreated) throw fail('日程已创建但本地回执落盘失败，请先核对飞书日历，未自动重试。', 'unknown_delivery'); }
      throw error;
    }
    if (!result.calendarUrl || !result.meetingUrl) {
      try { Object.assign(result, await hydrateInterviewCalendar(result, options)); }
      catch (error) {
        Object.assign(result, { metadataStatus: 'unavailable', metadataNotice: '日程已创建；链接读取暂未完成，可稍后刷新本场日程。', metadataError: { code: error.code || 'error', message: sanitize(error.message), ...(error.missingScopes ? { missingScopes: sanitize(error.missingScopes) } : {}) } });
      }
      // If a metadata-only journal update fails, the prior scheduled receipt
      // remains authoritative. It must never become a failed/uncertain creation.
      try { journal.state[key].result = result; await journal.save(); }
      catch { result.metadataNotice = '日程已创建；链接回执的本地补存未完成，可稍后刷新本场日程。'; }
    }
    return result;
  });
}
