const field = (key, name, type = 'text', extra = {}) => ({ key, name, type, ...extra });
const common = () => [field('id', '工作台ID'), field('_snapshot', '结构化快照', 'json'), field('createdAt', '创建时间', 'date'), field('updatedAt', '更新时间', 'date')];
const states = (key, name, options) => field(key, name, 'select', { options });
const link = (key, name, relation) => field(key, name, 'link', { relation });
export const SCHEMA = {
  version: 3,
  tables: [
    { key: 'requirements', name: '招聘需求', description: '岗位画像、业务目标、编制与预算依据、JD 和版本化用人标准。', fields: [...common(), field('title', '岗位名称'), field('department', '部门'), field('city', '工作城市'), field('headcount', '招聘人数', 'number'), field('salaryRange', '薪资范围'), field('owner', '招聘负责人'), field('priority', '优先级'), states('status', '需求状态', ['draft', 'clarifying', 'pending_approval', 'open', 'active', 'paused', 'filled', 'closed', '待澄清', '待审批', '招聘中', '暂停', '已关闭']), field('businessGoal', '业务目标'), field('requestReason', '招聘原因'), field('headcountJustification', '编制与工作量依据'), field('budget', '完整用工预算'), field('targetDate', '期望到岗日'), field('reportingTo', '汇报对象'), field('teamContext', '现有团队与职责边界'), field('successCriteria', '入职成果与衡量标准'), field('jd', '职位描述'), field('mustHaves', '用人标准', 'json'), field('version', '标准版本', 'number'), field('sourceJobId', 'BOSS职位标识'), field('sourceAccountKey', '来源账号范围')] },
    { key: 'bossJobs', name: 'BOSS招聘岗位', description: '本账号平台岗位与内部需求的关联；保留真实岗位标识，不按名称自动合并。', fields: [...common(), field('externalId','BOSS岗位标识'), field('numericJobId','平台数字岗位ID'), field('externalIds','岗位标识别名','json'), field('sourceAccountKey','来源账号范围'), field('title','平台岗位名称'), field('city','工作城市'), field('salaryRange','平台薪资'), field('status','平台状态'), field('statusText','平台状态说明'), field('jd','平台职位正文'), link('requirementId','内部招聘需求','requirements'), field('mappingSource','关联方式'), field('mappingReviewedAt','关联确认时间','date'), field('capturedAt','采集时间','date'), field('lastSeenAt','最近返回时间','date'), field('listedInLastSync','本次列表是否返回','json')] },
    { key: 'candidates', name: '候选人主档', description: '候选人统一主档与人工维护来源；其他模块引用同一人，搜索和会话仅保留采集与分析快照。入池由人工操作，不按姓名合并。年龄只展示，不用于分析或评分。', fields: [...common(), field('name', '候选人姓名'), field('age', '年龄（仅展示）'), field('source', '来源平台'), field('externalId', '来源候选人ID'), field('sourceAccountKey', '来源账号范围'), states('poolStatus','入池状态',['待筛选','已入池']), field('poolJoinedAt','首次加入候选池时间','date'), field('poolPrimaryChannel','首次入池渠道'), field('poolSources','入池来源记录','json'), field('pool','完整入池记录','json'), field('city', '来源城市文本'), field('workYear', '工作年限'), field('degree', '学历'), field('salary', '薪资文本'), field('position', '期望岗位'), field('company', '近期公司'), field('school', '院校'), field('major', '专业'), field('introduction', '个人介绍'), field('briefIntroduction', '面试人简介'), field('workHistory', '工作经历', 'json'), field('education', '教育经历', 'json'), field('profileRevision', '主档资料版本', 'number'), field('profileManualFields', '人工维护字段', 'json'), field('profileFieldSources', '主档字段来源', 'json'), field('profileMasterVersion', '主档结构版本', 'number'), field('capturedAt', '采集时间', 'date')] },
    { key:'sourcingCandidates',name:'搜索推荐人选',description:'BOSS 搜索/推荐已取得的职业摘要及所评估需求；采集不代表人工入池，消息资料独立保存。',fields:[...common(),link('candidateId','人物主档','candidates'),field('sourceAccountKey','来源账号范围'),field('externalId','BOSS人选标识'),field('channel','来源渠道'),field('sourceLabel','来源说明'),link('requirementId','评估招聘需求','requirements'),field('requirementSource','需求关联依据'),field('profile','搜索资料快照','json'),field('capturedAt','来源采集时间','date')] },
    { key: 'applications', name: '应聘流程', description: '候选人×需求中间表，一人可应聘多个岗位。', fields: [...common(), link('candidateId', '候选人', 'candidates'), link('requirementId', '招聘需求', 'requirements'), states('stage', '流程阶段', ['new', 'screening', 'review', 'contact', 'contacting', 'interview', 'decision', 'offer', 'hired', 'rejected', 'archived', 'withdrawn', '待初筛', '待复核', '待沟通', '面试中', '待决策', 'Offer', '已入职', '已归档']), field('reviewStatus', '复核状态'), field('evidence', '匹配证据', 'json'), field('notes', '跟进备注'), field('criteriaVersion', '标准版本', 'number'), field('nextActionAt', '下次跟进时间', 'date')] },
    { key: 'documents', name: '资料与证据', description: '简历、面试包、问题、JD 与复盘资料；每次生成保留版本。', fields: [...common(), field('type', '资料类型'), field('title', '资料标题'), link('applicationId', '应聘流程', 'applications'), link('candidateId', '候选人', 'candidates'), link('requirementId', '招聘需求', 'requirements'), field('content', '结构化内容', 'json'), field('generator', '生成方式'), field('version', '资料版本', 'number'), field('feishuUrl', '飞书文档链接')] },
    { key: 'interviews', name: '面试场次', description: '每轮面试一行，按场次维护面试官接收名单与逐人通知回执。', fields: [...common(), link('applicationId', '应聘流程', 'applications'), link('candidateId', '候选人', 'candidates'), link('requirementId', '招聘需求', 'requirements'), field('title', '面试标题'), field('startAt', '开始时间', 'date'), field('endAt', '结束时间', 'date'), field('interviewer', '面试官'), field('notificationRecipients', '面试消息接收人', 'json'), field('notificationSettings', '通知环节设置', 'json'), field('notifications', '逐人通知回执', 'json'), field('meetingOwnerOpenId', '会议发起人标识'), field('location', '面试地点'), field('round', '面试轮次'), field('status', '面试状态'), field('calendarStatus', '日历同步状态'), field('calendarUrl', '飞书日程链接'), field('eventId', '飞书日程ID'), field('calendarId', '飞书日历ID'), link('documentId', '面试资料', 'documents')] },
    { key: 'evaluations', name: '评估记录', description: '以岗位标准和履历证据辅助复核，录用结论由人确认。', fields: [...common(), link('applicationId', '应聘流程', 'applications'), link('interviewId', '面试场次', 'interviews'), field('type', '评估类型'), field('reviewer', '评估人'), field('criteriaVersion', '标准版本', 'number'), field('evidence', '评估证据', 'json'), field('conclusion', '评估建议'), field('status', '人工确认状态'), field('notes', '评估备注')] },
    { key: 'jobs', name: '执行任务', description: '采集、材料生成、同步的执行状态与范围。', fields: [...common(), field('type', '任务类型'), field('title', '任务标题'), field('status', '执行状态'), field('idempotencyKey', '幂等键'), field('result', '执行结果', 'json'), field('startedAt', '开始时间', 'date'), field('finishedAt', '结束时间', 'date'), field('error', '错误摘要')] },
    { key: 'activities', name: '活动日志', description: '业务动作与外部回执的可追踪时间线。', fields: [...common(), field('type', '事件类型'), field('title', '事件标题'), field('detail', '事件详情'), field('status', '事件状态'), field('entityId', '业务对象ID')] },
    { key: 'conversations', name: '沟通会话', description: '主动联系与候选人发起的会话、回复证据和待办；不按掩码姓名自动关联。', fields: [...common(), field('externalId', '来源会话ID'), field('source', '来源渠道'), field('sourceAccountKey', '来源账号范围'), field('peerId', '对方平台ID'), field('peerName', '对方姓名'), field('peerPosition', '对方岗位'), field('peerCompany', '对方公司'), field('communicatedJobExternalId','沟通岗位平台标识'), field('communicatedJobNumericId','沟通岗位数字ID'), field('communicatedPosition','平台沟通岗位'), link('bossJobId','BOSS岗位','bossJobs'), field('requirementSource','需求关联方式'), field('jobMappingStatus','岗位关联状态'), field('jobMappingConflict','岗位关联差异','json'), link('candidateId', '候选人', 'candidates'), link('requirementId', '招聘需求', 'requirements'), field('unreadCount', '未读数', 'number'), field('lastMessage', '最近消息'), field('lastMessageAt', '最近消息时间', 'date'), states('initiator', '发起方', ['candidate', 'hr', 'unknown']), states('communicationStatus', '沟通状态', ['new', 'needs_reply', 'waiting', 'interview_ready', 'closed']), field('roundCount', '沟通轮数', 'number'), field('messageCount', '消息数量', 'number'), field('historyComplete', '历史是否完整', 'json'), field('summary', '沟通摘要与证据', 'json'), field('notes', '跟进备注'), field('followUpAt', '下次跟进时间', 'date'), field('importedAt', '导入时间', 'date'), field('profile', '沟通人资料', 'json')] },
    { key: 'messages', name: '消息明细', description: '只读导入的逐条消息与原始时间；所属会话使用真实关联字段。', fields: [...common(), field('externalId', '来源消息ID'), link('conversationId', '沟通会话', 'conversations'), states('sender', '发送方', ['candidate', 'hr', 'system', 'unknown']), field('senderName', '发送者名称'), field('text', '消息内容'), field('sentAt', '消息时间', 'date'), field('type', '消息类型')] },
    { key: 'prompts', name: '提示词模板库', description: '七个招聘环节的版本化业务分析规则和评分设置；资料输入模板与输出结构由系统维护。', fields: [...common(), field('scene', '适用场景'), field('name', '模板名称'), field('description', '使用说明'), field('version', '模板版本', 'number'), field('systemPrompt', '系统提示词'), field('evaluationRules', '评分设置', 'json'), field('userPrompt', '任务提示词'), field('outputSchema', '输出结构', 'json'), field('sourceRefs', '参考来源', 'json')] },
    { key: 'resumes', name: '简历档案', description: '下载或上传的附件原件与解析正文；保留文件指纹和来源身份。旧在线快照仅留作历史，不用于新分析。', fields: [...common(), link('candidateId', '候选人', 'candidates'), link('applicationId', '应聘流程', 'applications'), field('name', '简历名称'), field('kind', '文件类别'), field('mimeType', '文件格式'), field('size', '字节数', 'number'), field('sha256', '内容指纹'), field('source', '来源'), field('textStatus', '原文解析状态'), field('text', '简历解析原文'), field('onlineData', '在线详情分段', 'json'), field('sourceMeta', '来源与身份', 'json'), field('coverage', '资料覆盖范围'), field('capturedAt', '采集时间', 'date'), field('lastCheckedAt', '最近核对时间', 'date'), field('version', '资料版本', 'number')] },
    { key: 'analyses', name: '分析与核验', description: '需求、简历、会前、会中、会后分析草稿与原始证据，保留模板和需求版本。', fields: [...common(), field('scene', '分析场景'), field('title', '分析标题'), field('generator', '分析来源'), field('status', '人工确认状态'), link('requirementId', '招聘需求', 'requirements'), link('candidateId', '候选人', 'candidates'), link('applicationId', '应聘流程', 'applications'), link('interviewId', '面试场次', 'interviews'), link('promptId', '提示词模板', 'prompts'), field('promptVersion', '提示词版本', 'number'), field('requirementVersion', '需求版本', 'number'), field('summary', '分析摘要'), field('conclusion', '结论建议'), field('dimensions', '分析维度', 'json'), field('clarifyingQuestions', '待澄清问题', 'json'), field('recommendations', '修改建议', 'json'), field('evidence', '证据引用', 'json'), field('questions', '建议追问', 'json'), field('sourceSnapshot', '输入来源快照', 'json')] },
  ],
};

export function validateSchema(schema = SCHEMA) {
  if (!Array.isArray(schema.tables) || !schema.tables.length) throw new Error('Schema must contain tables.');
  const keys = new Set();
  for (const table of schema.tables) {
    if (!table.key || keys.has(table.key)) throw new Error(`Duplicate or missing table key: ${table.key}`);
    keys.add(table.key);
    if (table.fields?.[0]?.key !== 'id' || table.fields[0].type !== 'text') throw new Error(`The primary field of ${table.key} must be the workbench ID.`);
    const seen = new Set();
    const names = new Set();
    for (const f of table.fields) {
      if (seen.has(f.key) || names.has(f.name)) throw new Error(`Duplicate field in ${table.key}: ${f.key}`);
      seen.add(f.key); names.add(f.name);
      if (!['text', 'number', 'select', 'date', 'link', 'json'].includes(f.type)) throw new Error(`Unsupported field type: ${f.type}`);
      if (f.type === 'select' && !f.options?.length) throw new Error(`Select options missing: ${f.key}`);
    }
  }
  for (const table of schema.tables) for (const f of table.fields) if (f.type === 'link' && !keys.has(f.relation)) throw new Error(`Unknown relation ${f.relation}`);
  return true;
}

export function toLarkField(f, tableIds = {}) {
  const result = { name: f.name, type: f.type === 'date' ? 'datetime' : f.type === 'json' ? 'text' : f.type };
  if (f.type === 'select') Object.assign(result, { multiple: false, options: f.options.map(name => ({ name })) });
  if (f.type === 'date') result.style = { format: 'yyyy-MM-dd HH:mm Z' };
  if (f.type === 'link') {
    const id = typeof tableIds[f.relation] === 'string' ? tableIds[f.relation] : tableIds[f.relation]?.id;
    if (!id || !/^tbl/.test(id)) throw new Error(`Missing real table ID for ${f.relation}`);
    result.link_table = id;
    result.bidirectional = false;
  }
  return result;
}

validateSchema();
