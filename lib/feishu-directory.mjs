import { runLark } from './lark-cli.mjs';
import { larkArguments, normalizeLarkConnection, larkConnectionKey } from './lark-context.mjs';

// Official Contact v3 contracts, checked against the current Feishu markdown
// documentation. Never use another app's user-search open_id for this bot.
export const FEISHU_DIRECTORY_SOURCES = Object.freeze([
  'https://open.feishu.cn/document/server-docs/contact-v3/scope/list.md',
  'https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department.md',
  'https://open.feishu.cn/document/contact-v3/user/batch.md',
  'https://open.feishu.cn/document/server-docs/contact-v3/department/get.md',
  'https://open.feishu.cn/document/server-docs/contact-v3/department/children.md',
]);
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validOpenId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{1,200}$/.test(value);
const validResourceId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}$/.test(value);
const problem = (message, code = 'directory_response_invalid') => Object.assign(new Error(message), { code });
const permissionError = error => error?.missingScopes?.length || /scope|permission|forbidden|authority|access_denied/i.test(String(error?.code || '')) || [40004, 40014, 41050, 99991672, 99991679].includes(error?.upstreamCode);
// A per-resource data-range denial or a transport failure does not establish
// that the group API is unavailable for every other authorized group.
const groupPermissionError = error => array(error?.missingScopes).length > 0 || /scope|permission|forbidden|access_denied/i.test(String(error?.code || '')) || [99991672, 99991679].includes(error?.upstreamCode);
const failureInfo = error => ({ code: String(error?.code || 'directory_unavailable').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 100), missingScopes: array(error?.missingScopes).filter(value => typeof value === 'string' && /^contact:[a-zA-Z0-9_.:]+$/.test(value)).slice(0, 12) });
const fold = value => text(value, 300).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
const boundedLimit = (value, fallback, ceiling) => Number.isFinite(value) ? Math.max(1, Math.min(ceiling, Math.floor(value))) : fallback;

/** Scoped in-memory directory. It stores only name/id/department and never
 * exports a complete directory to the browser: a nonempty search is required.
 * No OAuth login, app changes, invitations, messages or workspace writes occur. */
export function createFeishuDirectory({ runner = runLark, clock = Date.now, ttlMs = 900000, maxRequests = 600, maxUsers = 5000, maxDepartments = 200 } = {}) {
  maxRequests = boundedLimit(maxRequests, 600, 600);
  maxUsers = boundedLimit(maxUsers, 5000, 5000);
  maxDepartments = boundedLimit(maxDepartments, 200, 200);
  const cache = new Map(), inflight = new Map();

  async function buildIndex(connection) {
    let requests = 0, truncated = false, incompleteGroups = false;
    const users = new Map(), directUserIds = new Set(), authorizedDepartments = new Set(), groupIds = new Set(), departments = new Map(), queriedDepartments = new Set();
    const failures = [];
    const recordFailure = error => {
      const failure = failureInfo(error);
      if (!failures.some(row => row.code === failure.code && row.missingScopes.join() === failure.missingScopes.join())) failures.push(failure);
    };
    const rememberId = (set, id, limit) => { if (set.has(id)) return; if (set.size >= limit) { truncated = true; return; } set.add(id); };
    function rememberDepartment(row, id) {
      if (!object(row)) throw problem('通讯录未返回可识别的部门信息。');
      const name = text(row.name, 100) || departments.get(id)?.name || '';
      departments.set(id, { name });
      if (!name) recordFailure({ code: 'directory_department_name_permission', missingScopes: ['contact:department.base:readonly'] });
    }
    const api = async (route, params) => {
      if (requests >= maxRequests) { truncated = true; throw problem('本次通讯录读取已达到上限。', 'directory_read_limit'); }
      requests++;
      const response = await runner(larkArguments(['api', 'GET', route, '--params', JSON.stringify(params), '--format', 'json'], connection), { write: false, timeoutMs: 30000 });
      if (response?.ok !== true || response.identity && response.identity !== 'bot' || !object(response.data)) throw problem('通讯录没有返回当前应用的明确成功结果。');
      return response.data;
    };
    async function pages(route, params, consume) {
      let token = '';
      const seen = new Set();
      do {
        const data = await api(route, { ...params, ...(token ? { page_token: token } : {}) });
        consume(data);
        if (data.has_more !== true) return;
        const next = text(data.page_token, 4000);
        if (!next || seen.has(next)) throw problem('通讯录分页标记无效或重复。');
        seen.add(next); token = next;
      } while (requests < maxRequests);
      truncated = true;
    }
    function addUser(row, department = '') {
      if (!object(row) || !validOpenId(row.open_id)) return;
      if (row.status?.is_resigned === true || row.status?.is_exited === true || row.status?.is_frozen === true) return;
      const name = text(row.name || row.localized_name, 100);
      if (!name) { recordFailure({ code: 'directory_name_permission', missingScopes: ['contact:user.base:readonly'] }); return; }
      const prior = users.get(row.open_id);
      if (!prior && users.size >= maxUsers) { truncated = true; return; }
      const departmentNames = [...new Set([
        ...array(prior?._departments), department,
        ...array(row.department_ids).map(id => departments.get(String(id))?.name),
      ].filter(Boolean))];
      users.set(row.open_id, { openId: row.open_id, name, department: departmentNames.join(' / '), appId: connection.appId, selectable: true,
        _departments: departmentNames, _match: [...new Set([name, text(row.en_name, 100), text(row.nickname, 100), ...departmentNames].filter(Boolean))].map(fold),
      });
    }

    await pages('/open-apis/contact/v3/scopes', { user_id_type: 'open_id', department_id_type: 'open_department_id', page_size: 100 }, data => {
      array(data.user_ids).filter(validOpenId).forEach(id => rememberId(directUserIds, id, maxUsers));
      array(data.department_ids).filter(validResourceId).forEach(id => rememberId(authorizedDepartments, id, maxDepartments));
      array(data.group_ids).filter(validResourceId).forEach(id => rememberId(groupIds, id, maxDepartments));
    });

    // A scope can consist solely of an explicitly authorized user group.
    // A missing optional group permission is reported as incomplete coverage.
    for (const groupId of groupIds) {
      if (requests >= maxRequests) { truncated = true; break; }
      try {
        for (const memberType of ['user', 'department']) await pages(`/open-apis/contact/v3/group/${encodeURIComponent(groupId)}/member/simplelist`, { member_type: memberType, member_id_type: 'open_id', page_size: 100 }, data => {
          for (const row of array(data.memberlist)) {
            if (memberType === 'user' && validOpenId(row.member_id)) rememberId(directUserIds, row.member_id, maxUsers);
            if (memberType === 'department' && validResourceId(row.member_id)) {
              if (row.member_id === '0' && !authorizedDepartments.has('0')) {
                incompleteGroups = true; recordFailure({ code: 'directory_root_not_explicitly_authorized' });
              } else rememberId(authorizedDepartments, row.member_id, maxDepartments);
            }
          }
        });
      } catch (error) {
        incompleteGroups = true; recordFailure(error);
        if (groupPermissionError(error)) break;
      }
    }

    // Do not query department 0 as a shortcut: it requires full-company scope.
    // Traverse only department IDs actually returned by Contact scopes/groups.
    const departmentQueue = [...authorizedDepartments];
    const queuedDepartments = new Set(departmentQueue);
    while (departmentQueue.length && queriedDepartments.size < maxDepartments && requests < maxRequests) {
      const departmentId = departmentQueue.shift();
      if (queriedDepartments.has(departmentId)) continue;
      queriedDepartments.add(departmentId);
      // Children responses do not contain the requested department itself.
      // Read only an explicitly authorized root whose name is not yet cached.
      if (authorizedDepartments.has(departmentId) && !departments.has(departmentId)) {
        try {
          const data = await api(`/open-apis/contact/v3/departments/${encodeURIComponent(departmentId)}`, { department_id_type: 'open_department_id', user_id_type: 'open_id' });
          if (data.department?.open_department_id && data.department.open_department_id !== departmentId) throw problem('通讯录返回的部门标识不匹配。');
          rememberDepartment(data.department, departmentId);
        } catch (error) { recordFailure(error); }
      }
      // These two reads are independent once this department's label is known.
      // api() reserves its budget synchronously, so concurrency cannot exceed it.
      const reads = await Promise.allSettled([
        pages(`/open-apis/contact/v3/departments/${encodeURIComponent(departmentId)}/children`, { department_id_type: 'open_department_id', user_id_type: 'open_id', fetch_child: false, page_size: 50 }, data => {
          for (const row of array(data.items)) {
            const id = text(row.open_department_id, 200);
            if (!validResourceId(id) || row.status?.is_deleted === true) continue;
            if (id === '0' && !authorizedDepartments.has('0')) { recordFailure({ code: 'directory_root_not_explicitly_authorized' }); continue; }
            if (!queuedDepartments.has(id)) {
              if (queuedDepartments.size < maxDepartments) { departmentQueue.push(id); queuedDepartments.add(id); }
              else { truncated = true; continue; }
            }
            rememberDepartment(row, id);
          }
        }),
        pages('/open-apis/contact/v3/users/find_by_department', { department_id: departmentId, department_id_type: 'open_department_id', user_id_type: 'open_id', page_size: 50 }, data => {
          array(data.items).forEach(row => addUser(row, departments.get(departmentId)?.name || ''));
        }),
      ]);
      for (const result of reads) if (result.status === 'rejected') recordFailure(result.reason);
    }
    if (departmentQueue.length) truncated = true;

    // Group membership often overlaps department members; avoid fetching the
    // same user again after a usable directory record has already been read.
    const ids = [...directUserIds].filter(id => !users.has(id));
    let offset = 0;
    for (; offset < ids.length && requests < maxRequests; offset += 50) {
      try {
        await pages('/open-apis/contact/v3/users/batch', { user_ids: ids.slice(offset, offset + 50), user_id_type: 'open_id', department_id_type: 'open_department_id' }, data => array(data.items).forEach(row => addUser(row)));
      } catch (error) { recordFailure(error); }
    }
    if (offset < ids.length) truncated = true;
    const missingScopes = [...new Set(failures.flatMap(row => row.missingScopes))];
    return { rows: [...users.values()], indexedAt: clock(), requests, coverage: { scope: 'application_authorized', indexedUsers: users.size, authorizedUsers: directUserIds.size, indexedDepartments: queriedDepartments.size, authorizedDepartments: authorizedDepartments.size, authorizedGroups: groupIds.size, readRequests: requests, truncated, incomplete: failures.length > 0 || incompleteGroups }, missingScopes, failures };
  }

  async function search({ connection: value, query = '', refresh = false, limit = 30 } = {}) {
    const term = text(query, 100);
    if ([...term].length > 50 || /[\p{Cc}]/u.test(term)) return { status: 'invalid_query', source: 'feishu_directory', recipients: [], message: '请输入50字以内的姓名。' };
    if (!term) return { status: 'query_required', source: 'feishu_directory', recipients: [], message: '输入飞书通讯录中的姓名，勾选对应面试官。' };
    let connection;
    try { connection = normalizeLarkConnection(value); } catch { return { status: 'not_configured', source: 'feishu_directory', recipients: [], message: '请先连接云咩咩飞书应用。' }; }
    if (connection.identity !== 'bot' || !connection.profile || !connection.appId) return { status: 'not_configured', source: 'feishu_directory', recipients: [], message: '通讯录选择须使用当前云咩咩应用身份。' };
    const key = larkConnectionKey(connection);
    let index = cache.get(key), cached = Boolean(index && clock() - index.indexedAt < ttlMs && !refresh);
    try {
      if (!cached) {
        if (!inflight.has(key)) inflight.set(key, buildIndex(connection).then(value => { cache.set(key, value); while (cache.size > 3) cache.delete(cache.keys().next().value); return value; }).finally(() => inflight.delete(key)));
        index = await inflight.get(key);
      }
      const matches = index.rows.filter(row => row._match.some(value => value.includes(fold(term))));
      const wanted = Number.isInteger(limit) ? Math.max(1, Math.min(30, limit)) : 30;
      const recipients = matches.slice(0, wanted).map(({ _match, _departments, ...row }) => row);
      const partial = index.coverage.truncated || index.coverage.incomplete;
      const veryLimited = index.coverage.indexedUsers <= 1 && index.coverage.authorizedDepartments === 0 && index.coverage.authorizedGroups === 0;
      return { status: index.rows.length === 0 && index.missingScopes.length ? 'permission_required' : partial ? 'partial' : 'ok', source: 'feishu_directory', query: term, recipients, hasMore: matches.length > wanted, cached, indexedAt: new Date(index.indexedAt).toISOString(), appId: connection.appId, coverage: { ...index.coverage, limitedToSingleUser: veryLimited && index.coverage.indexedUsers === 1 },
        ...(index.missingScopes.length ? { missingScopes: index.missingScopes } : {}),
        message: veryLimited ? index.coverage.indexedUsers === 1 ? '当前云咩咩通讯录授权范围仅包含一位成员；搜索其他面试官前，请管理员将相应人员或部门加入通讯录授权范围。' : '当前云咩咩通讯录授权范围尚未包含可读取成员，请管理员将相应人员或部门加入通讯录授权范围。' : partial ? '已显示当前授权范围中取得的结果，部分目录尚未完整读取；可刷新后重试或请管理员检查通讯录权限。' : recipients.length ? '请按姓名和部门确认面试官；同名人员分别列出。' : '当前授权通讯录范围内未找到匹配人员，可调整姓名或刷新通讯录。',
      };
    } catch (error) {
      const permission = Boolean(permissionError(error));
      const needsDataRange = [40004,40014,41050].includes(error?.upstreamCode) || /authority|resource_forbidden/i.test(String(error?.code || ''));
      return { status: permission ? 'permission_required' : 'unavailable', source: 'feishu_directory', query: term, recipients: [], appId: connection.appId, ...failureInfo(error), message: permission ? '云咩咩尚未获准读取所需通讯录信息，请管理员检查应用通讯录权限及授权范围。' : '飞书通讯录暂时不可读取，请稍后重试。', ...(permission ? { needsDataRange, requiredScopes: array(error?.missingScopes).length ? failureInfo(error).missingScopes : needsDataRange ? [] : ['contact:contact.base:readonly', 'contact:user.base:readonly'] } : {}) };
    }
  }
  return { search, clear: () => cache.clear() };
}

const sharedDirectory = createFeishuDirectory();
export const searchFeishuRecipients = options => sharedDirectory.search(options);
