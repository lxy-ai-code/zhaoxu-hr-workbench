import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CDP_PORT, INSTALLED, WORKSPACE_ROOT } from './runtime-config.mjs';
import { upsertSearchProspects } from './candidate-pool.mjs';

export const ROOT = WORKSPACE_ROOT;
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const uid = prefix => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export const STAGES = { new: '新入库', review: '待复核', contact: '待沟通', interview: '面试中', offer: 'Offer 沟通', hired: '已入职', archived: '已归档' };
export function compactJobResult(result) {
  if (!result || typeof result !== 'object') return result;
  const kept = {};
  for (const key of ['status', 'message', 'imported', 'updated', 'deduplicated', 'applicationsAdded', 'synced', 'failed', 'failedTables', 'generated', 'baseUrl', 'eventId', 'calendarUrl', 'meetingUrl', 'messageCount', 'roundCount', 'meta', 'results']) if (result[key] !== undefined) kept[key] = result[key];
  if (result.tables) { kept.tableCount = Object.keys(result.tables).length; kept.tableKeys = Object.keys(result.tables); }
  if (result.conversation) kept.conversationId = result.conversation.id;
  return kept;
}

export function addActivity(state, type, title, detail = '', status = 'success') {
  state.activities.unshift({ id: uid('act'), type, title, detail, status, createdAt: now() });
  state.activities = state.activities.slice(0, 500);
}

export async function createSeed() {
  const stamp = now();
  const state = {
    schemaVersion: 1, revision: 0, createdAt: stamp, updatedAt: stamp,
    requirements: [], candidates: [], applications: [], interviews: [], documents: [], evaluations: [], jobs: [], activities: [], conversations: [], messages: [],
    automations: [
      { id: 'interview-pack', name: '面试前资料准备', description: '人工推进到面试阶段后，按岗位标准与候选人原文生成一页纸和问题草稿。', trigger: '进入面试阶段', status: 'enabled', lastRun: null },
      { id: 'boss-import', name: 'BOSS 当前搜索页导入', description: '通过已登录 Chrome 的页面原生请求导入当前结果，按账号与平台 ID 去重。', trigger: '手动运行', status: 'ready', lastRun: null },
      { id: 'feishu-sync', name: '飞书多维表同步', description: '按关联顺序将工作台记录写入已配置的八张表，保留回执与失败结果。', trigger: '手动运行', status: 'ready', lastRun: null },
    ],
    settings: { cdpPort: DEFAULT_CDP_PORT, baseUrl: '', baseToken: '', tables: {}, fieldMaps: {}, recordMaps: {}, calendarId: '' },
    connections: {
      boss: { status: 'unknown', message: '尚未检测浏览器连接' },
      feishu: { status: 'unknown', message: '尚未检测飞书授权' },
      storage: { mode: 'local', message: '本地镜像 · 尚未连接飞书多维表' },
    },
  };
  if (INSTALLED) {
    state.settings.bossOfflineMode = true;
    state.settings.inboxAutomation = { enabled: false };
    return state;
  }
  try {
    const source = JSON.parse(await fs.readFile(path.resolve(ROOT, '../artifacts/zhipin/search-response.json'), 'utf8'));
    const jobCapture = JSON.parse(await fs.readFile(path.resolve(ROOT, '../artifacts/zhipin/01-wapi_zpjob_job_search_job_list.json'), 'utf8'));
    const capture = JSON.parse(await fs.readFile(path.resolve(ROOT, '../artifacts/zhipin/search-request.json'), 'utf8'));
    const list = Array.isArray(jobCapture.response?.zpData) ? jobCapture.response.zpData : [];
    const job = list[0];
    if (source.code !== 0 || !Array.isArray(source.zpData?.geeks) || !source.zpData?.bossId || !job) return state;
    const requirement = {
      id: `req_${digest(job.jid).slice(0, 16)}`, title: job.jobName, department: '待补充', city: job.cityName,
      headcount: 1, salaryRange: job.salary, owner: '待指定', priority: 'normal', status: 'draft',
      jd: `从 BOSS 当前职位导入的需求草稿。学历：${job.degreeName || '待确认'}；经验：${job.workExperience || '待确认'}。请补充业务目标、职责和面试标准后启用。`,
      mustHaves: [], version: 1, source: 'boss_snapshot', sourceJobId: job.jid,
      createdAt: capture.capturedAt, updatedAt: stamp,
    };
    state.requirements.push(requirement);
    const accountKey = digest(source.zpData.bossId).slice(0, 16);
    const rows = source.zpData.geeks.map(entry => {
      const card = entry.geekCard;
      return {
        externalId: card.encryptGeekId, source: 'boss', sourceAccountKey: accountKey, name: card.name,
        city: card.city || '', workYear: card.workYear || '', degree: card.highestDegreeName || '', salary: card.salary || '',
        position: card.expect?.name?.replace(/^期望职位\s*/, '') || '', company: entry.works?.[0]?.company?.value || '',
        school: card.eduSchool || '', major: card.eduMajor || '', introduction: card.geekDesc?.name || '',
        activeDesc: card.activeDesc || '', applyStatusDesc: entry.applyStatusDesc || '',
        workHistory: (entry.works ?? []).map(work => ({ company: work.company?.value || '', position: work.position?.value || '' })),
        capturedAt: capture.capturedAt, sourceLabel: 'BOSS 已采集快照',
      };
    });
    const imported = upsertBossCandidates(state, rows, requirement.id);
    state.activities = [{ id: uid('act'), type: 'import', title: `载入 ${imported.imported} 位 BOSS 候选人`, detail: `来自 ${new Date(capture.capturedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 已采集快照；仅第 1 页。岗位标准和全部候选人待人工复核。`, status: 'success', createdAt: capture.capturedAt }];
    state.sourceCoverage = { capturedCount: rows.length, reportedTotal: source.zpData.totalCount, hasMore: source.zpData.hasMore, page: source.zpData.page, capturedAt: capture.capturedAt, message: '已采集当前第 1 页，不代表全部搜索结果' };
  } catch (error) {
    if (error.code !== 'ENOENT') addActivity(state, 'import', '初始数据未能载入', '保留空工作区，可使用 BOSS 导入或新建需求。', 'warning');
  }
  return state;
}

export function upsertBossCandidates(state, rows, requirementId) {
  return upsertSearchProspects(state, rows, requirementId);
}

const windowsRenameRetryDelays = [50, 100, 200, 400, 800];

export class Store {
  constructor(file = path.join(ROOT, 'data/workspace.json'), seed = createSeed) { this.file = file; this.seed = seed; this.queue = Promise.resolve(); }
  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); if (this.state.schemaVersion !== 1) throw new Error('不支持的数据版本，请先备份。'); this.state.conversations ??= []; this.state.messages ??= []; if (this.state.settings.cdpPort === 9222) { this.state.settings.cdpPort = DEFAULT_CDP_PORT; await this.persist(this.state); } for (const job of this.state.jobs ?? []) if (job.result) job.result = compactJobResult(job.result); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = await this.seed(); await this.persist(this.state); }
    return this;
  }
  read() { return structuredClone(this.state); }
  async persist(state) {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, this.file);
        return;
      } catch (error) {
        const retryDelay = windowsRenameRetryDelays[attempt];
        if (process.platform !== 'win32' || !retryDelay || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        // A Windows file handle can briefly block replacement. Retry the same
        // complete snapshot while the mutation queue still owns this write.
        await delay(retryDelay);
      }
    }
  }
  mutate(fn) {
    const task = this.queue.then(async () => {
      const draft = this.read();
      const result = await fn(draft);
      draft.revision = (draft.revision || 0) + 1; draft.updatedAt = now();
      await this.persist(draft); this.state = draft;
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
