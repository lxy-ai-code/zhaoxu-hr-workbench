import {inboxRefreshDecision,inboxDisplayStats,isCurrentWorkspaceSnapshot} from './inbox-refresh.js';

export const PROMPT_STAGES = [
  {scene:'requirement_analysis',step:'01',label:'需求澄清',view:'requirements',usage:'在招聘需求中分析岗位、编制预算与标准。'},
  {scene:'sourcing_match',step:'02',label:'搜索人选匹配',view:'sourcing',usage:'BOSS 搜索 / 推荐列表，结合个人期望岗位、职业摘要与招聘需求形成匹配参考，人工选择后加入候选人池。'},
  {scene:'conversation_priority',step:'03',label:'沟通与回复排序',view:'conversations',usage:'同步新消息后，结合意向岗位、职业资料与附件安排回复先后。'},
  {scene:'resume_screen',step:'04',label:'附件简历初筛',view:'candidates',usage:'候选人池档案 → 简历与初筛，逐项核对附件与岗位证据。'},
  {scene:'interview_prep',step:'05',label:'会前准备',view:'interviews',usage:'面试场次 → 会前，生成关键判断与验证问题。'},
  {scene:'interview_copilot',step:'06',label:'会中辅助',view:'interviews',usage:'面试场次 → 会中，统一预览与持续辅助；按阶段整合岗位、候选资料与会议记录，重要追问或节奏建议由云咩咩低频私聊发送。'},
  {scene:'interview_report',step:'07',label:'会后分析',view:'interviews',usage:'面试场次 → 会后，按本次分析模板的维度名称、评分规则与权重形成证据报告；历史报告沿用生成时的设置。'},
];

export function createReplyPriorityFeatures(ctx) {
  const {state,all,byId,api,run,notify,resultNotice,render,loadWorkspace,setView,icon,escape:esc,badge,btn,dateLabel,closeOverlay}=ctx;
  state.conversationSort ||= 'latest'; state.priorityFilter ||= '';
  let runtime=state.inboxRuntime||{},lastStatusAt=0,statusBusy=false,workspaceRefreshBusy=false;
  const reuseChecks=new Map();
  const arr=value=>Array.isArray(value)?value:[];
  const clean=value=>typeof value==='string'?value:value?.text||value?.finding||value?.reason||value?.quote||'';
  const settings=()=>runtime.settings||state.data?.settings?.inboxAutomation||{enabled:true,intervalMinutes:60,autoAnalyze:true};
  const modelReady=()=>state.data?.settings?.model?.configured===true;
  const priorityFor=conversation=>conversation?.replyPriority||null;
  const scoreFor=conversation=>{const row=priorityFor(conversation);return row&&!row.stale&&typeof row.score==='number'&&Number.isFinite(row.score)&&row.score>=0&&row.score<=100?row.score:null;};
  const bandNames={high:'优先回复',normal:'常规跟进',low:'较后处理',insufficient:'资料待补'};
  const bandColor={high:'green',normal:'blue',low:'gray',insufficient:'orange'};
  const labelFor=row=>row?.stale?'材料已变化':bandNames[row?.band]||'待复核';
  function coverageFacts(coverage) {return [coverage.job==='mapped_requirement'?'岗位已关联':'岗位需确认',coverage.messages==='captured_history'?'已取聊天片段':'仅最后消息预览',coverage.profile==='professional_summary'?'已取职业摘要':'职业资料待补',coverage.attachment==='parsed_attachment'?`附件已解析${Number(coverage.parsedAttachmentCount)>0?` × ${Number(coverage.parsedAttachmentCount)}`:''}`:coverage.attachment==='unparsed_attachment'?'原件已取 · 待解析':'附件正文未取得'];}
  function priorityCompare(a,b) {
    if(state.conversationSort!=='priority')return (Date.parse(b.lastMessageAt)||0)-(Date.parse(a.lastMessageAt)||0);
    const as=scoreFor(a),bs=scoreFor(b);
    return (as===null?1:0)-(bs===null?1:0)||(bs??0)-(as??0)||(Date.parse(b.lastMessageAt)||0)-(Date.parse(a.lastMessageAt)||0);
  }
  function matchesPriority(conversation) {const row=priorityFor(conversation);return !state.priorityFilter||(state.priorityFilter==='assessed'?Boolean(row):state.priorityFilter==='unassessed'?!row:state.priorityFilter==='stale'?Boolean(row?.stale):row?.band===state.priorityFilter);}
  function listBadge(conversation) {
    const row=priorityFor(conversation),score=scoreFor(conversation);
    if(!row)return `<div class="reply-priority-list pending"><span>回复优先级</span><small>待分析</small></div>`;
    return `<div class="reply-priority-list"><span>${row.stale?'待更新':score===null?'—':`<b>${Math.round(score)}</b><small> / 100</small>`}</span>${badge(labelFor(row),row.stale?'orange':bandColor[row.band]||'gray')}</div>`;
  }
  function promptLink(scene,label='查看本环节提示词') {return btn('priority-open-template',label,'spark','small',`data-scene="${esc(scene)}"`);}
  function renderScoreCard(conversation) {
    const row=priorityFor(conversation),score=scoreFor(conversation),coverage=row?.coverage||{},reuseCheck=reuseChecks.get(conversation.id);
    const reused=Boolean(row&&(row.reusedFrom||row.reused||reuseCheck?.analysisId&&reuseCheck.analysisId===row.id));
    return `<section class="reply-priority-card"><header><div><h3>${icon('spark')}回复优先级</h3><p>安排回复先后，供 HR 复核</p></div><div class="inline-actions">${promptLink('conversation_priority','分析模板')}${btn('priority-analyse',row?'检查更新':modelReady()?'分析回复优先级':'配置分析 API',row||modelReady()?'refresh':'link','small',`data-id="${esc(conversation.id)}"`)}</div></header>${row?`<div class="reply-priority-main"><div class="reply-priority-score ${score===null?'missing':''}">${score===null?'—':Math.round(score)}<small>${score===null?'暂不评分':'/ 100'}</small></div><div>${badge(labelFor(row),row.stale?'orange':bandColor[row.band]||'gray')}<p>${esc(row.summary||'分析结果待人工复核。')}</p><small>${esc(row.generator==='codex'?'Codex 首批分析':row.generator==='model'?'系统模型分析':'分析来源待确认')} · ${reused?'复用已有分析 · 原生成 ':''}${dateLabel(row.generatedAt||row.createdAt||reuseCheck?.generatedAt)}${row.promptVersion?` · 模板 v${esc(row.promptVersion)}`:''} · 待复核</small></div></div>${row.stale?'<p class="reply-priority-stale">消息或资料已变化，请重新分析后核对排序。</p>':''}<div class="reply-priority-coverage">${coverageFacts(coverage).map(label=>`<span>${esc(label)}</span>`).join('')}</div>${arr(row.dimensions).length?`<div class="reply-priority-dimensions">${arr(row.dimensions).map(d=>`<div><label>${esc(d.name||d.key)}</label><strong>${esc(d.points)}<small> / ${esc(d.maxPoints)}</small></strong></div>`).join('')}</div>`:''}${arr(row.reasons).length?`<ul class="reply-priority-reasons">${arr(row.reasons).slice(0,3).map(reason=>`<li>${esc(clean(reason))}</li>`).join('')}</ul>`:''}${arr(row.evidence).length||arr(row.gaps).length?`<details class="reply-priority-evidence"><summary>评分依据与资料缺口 ${icon('down')}</summary>${arr(row.evidence).slice(0,6).map(item=>`<blockquote>${esc(clean(item))}<small>${esc(item.source||item.path||'本次提供资料')}</small></blockquote>`).join('')}${arr(row.gaps).map(item=>`<p>${esc(clean(item))}</p>`).join('')}</details>`:''}`:`<div class="reply-priority-empty"><strong>尚未分析这段沟通</strong><p>${modelReady()?'同步后使用系统模型，结合岗位与本次实际取得的资料分析。':'系统模型 API 尚未配置；自动分析会等待配置，已同步消息仍保留。'}</p></div>`}<footer>${row&&modelReady()?`<details class="reply-priority-force"><summary>重新调用 API</summary><p>强制重分析会再次调用模型 API，产生新的 Token 用量。</p>${btn('priority-force-analyse','强制重分析','refresh','small',`data-id="${esc(conversation.id)}" title="再次调用模型 API"`)}</details>`:''}资料不足单独标明；分数不代表录用结论，不自动发送消息或淘汰候选人。</footer></section>`;
  }
  function runtimeLabel() {const s=settings();if(runtime.connected===false)return '后台连接中断';if(!s.enabled)return '已暂停';if(runtime.running||runtime.status==='running')return '正在同步';if(runtime.lastError||runtime.lastRun?.error||['failed','error','blocked'].includes(runtime.status))return '本轮需处理';if(Number(runtime.lastRun?.failed)>0)return '消息已同步 · 部分资料待读取';if(state.inboxRefreshPending)return '本轮已完成 · 列表待刷新';if(!modelReady()&&s.autoAnalyze!==false||runtime.status==='waiting_model')return '消息同步已启用 · API 分析待配置';return '周期运行已启用';}
  function renderAutomationPanel(compact=false) {
    const s=settings(),model=state.data?.settings?.model||{};
    if(compact)return `<section class="inbox-automation-bar"><div>${icon('clock')}<span><strong>每 ${esc(s.intervalMinutes||60)} 分钟同步</strong><small class="inbox-runtime-status">${esc(runtimeLabel())}</small></span></div><div class="inline-actions">${btn('priority-configure','设置周期','edit','small')}${btn('priority-run-inbox','立即同步并分析','refresh','small soft')}${promptLink('conversation_priority','分析模板')}</div></section>`;
    return `<section class="panel inbox-automation-panel" id="inbox-automation-panel"><div class="panel-header"><div><h2 class="panel-title">BOSS 新消息与回复优先级</h2><p class="panel-subtitle">同步新消息 → 更新候选人职业资料 → 下载已授权附件 → 使用系统模型分析。</p></div><span class="inbox-runtime-status">${esc(runtimeLabel())}</span></div><form id="adv-inbox-automation-form"><div class="panel-body"><div class="inbox-automation-facts"><div><label>上次运行</label><strong class="inbox-last-run">${(runtime.lastRunAt||runtime.lastRun?.finishedAt||runtime.lastRun?.startedAt)?dateLabel(runtime.lastRunAt||runtime.lastRun?.finishedAt||runtime.lastRun?.startedAt):'尚未运行'}</strong></div><div><label>下次运行</label><strong class="inbox-next-run">${s.enabled&&runtime.nextRunAt?dateLabel(runtime.nextRunAt):s.enabled?'等待调度':'已暂停'}</strong></div><div><label>自动分析模型</label><strong>${esc(modelReady()?model.model||'系统模型':'尚未配置 API')}</strong></div></div><div class="form-grid"><div class="field"><label for="inbox-interval">同步间隔（分钟）</label><input id="inbox-interval" name="intervalMinutes" type="number" min="5" max="1440" step="1" required class="control" value="${esc(s.intervalMinutes||60)}"><small>默认 60 分钟，可按工作节奏调整。</small></div><div class="field inbox-automation-switches"><label><input type="checkbox" name="enabled" ${s.enabled!==false?'checked':''}> 启用周期同步</label><label><input type="checkbox" name="autoAnalyze" ${s.autoAnalyze!==false?'checked':''}> 同步后使用系统 API 自动分析</label></div></div><div class="inbox-api-note">${icon('info')}<span>${modelReady()?'使用下方系统模型配置。每次分析只发送本次所需的岗位、职业资料、聊天和附件正文。':'尚未配置模型 API：同步照常留存资料，分析会明确等待配置，不替换成规则打分。'}</span>${btn('adv-open-model-settings','配置系统 API','link','small')}</div><div class="inline-actions"><button type="submit" class="btn primary">${icon('check')}保存自动化设置</button>${btn('priority-run-inbox','立即运行一轮','refresh','soft')}${promptLink('conversation_priority','编辑自动分析模板')}</div><div class="inbox-last-result">${(runtime.lastError||runtime.lastRun?.error?.message)?`<p>${esc(runtime.lastError||runtime.lastRun?.error?.message)}</p>`:''}${(runtime.lastResult?.message||runtime.lastRun?.message)?`<p>${esc(runtime.lastResult?.message||runtime.lastRun?.message)}</p>`:''}</div><p class="input-note">需要本地工作台服务持续运行、独立 BOSS 浏览器保持登录。仅下载当前账号已授权附件，遇验证或权限确认会停止该项。</p></div></form></section>`;
  }
  async function refreshStatus(force=false) {
    if(statusBusy||!force&&Date.now()-lastStatusAt<15000)return;
    statusBusy=true;
    try {
      const recovered=runtime.connected===false;
      runtime={...await api('/api/inbox/status'),connected:true,lastError:null};state.inboxRuntime=runtime;lastStatusAt=Date.now();
      state.inboxRefreshPending=inboxRefreshDecision({loadedRuntime:state.data?.inboxStatus,currentRuntime:runtime,pending:state.inboxRefreshPending,recovered}).pending;
      updateStatusDom();await refreshWorkspaceSafely();
    }catch(error){runtime={...runtime,connected:false,lastError:error.message};state.inboxRuntime=runtime;updateStatusDom();}finally{statusBusy=false;}
  }
  function refreshConditions() {
    return {loadedRuntime:state.data?.inboxStatus,currentRuntime:runtime,pending:state.inboxRefreshPending,view:state.view,hidden:document.visibilityState==='hidden',hasOverlay:Boolean(document.querySelector('#overlay-root [role="dialog"],#overlay-root .drawer,#overlay-root .modal')),inputFocused:Boolean(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')),hasUnsavedForm:Boolean(document.querySelector('form[data-inbox-unsaved="true"]')),busy:Boolean(state.busy)};
  }
  async function refreshWorkspaceSafely() {
    if(workspaceRefreshBusy||!inboxRefreshDecision(refreshConditions()).refresh)return;
    workspaceRefreshBusy=true;
    try {
      const response=await api('/api/workspace');
      // The user may have started typing or opened a dialog while GET was in flight.
      if(!inboxRefreshDecision(refreshConditions()).refresh||!isCurrentWorkspaceSnapshot(response.workspace||response,state.data))return;
      const scroll={x:window.scrollX,y:window.scrollY,elements:['.inbox-table-wrap','.sidebar','.main'].map(selector=>{const el=document.querySelector(selector);return {selector,top:el?.scrollTop||0,left:el?.scrollLeft||0};})};
      state.data=response.workspace||response;
      for(const key of ['requirements','candidates','applications','interviews','documents','activities','automations','conversations','messages','prompts','analyses','resumes','bossJobs'])state.data[key]||=[];
      state.data.settings||={};state.data.schema||={tables:[]};
      runtime={...(state.data.inboxStatus||runtime),connected:true,lastError:null};state.inboxRuntime=runtime;state.inboxRefreshPending=false;
      render();
      for(const position of scroll.elements){const el=document.querySelector(position.selector);if(el){el.scrollTop=position.top;el.scrollLeft=position.left;}}
      window.scrollTo({left:scroll.x,top:scroll.y,behavior:'instant'});updateStatusDom();
    }finally{workspaceRefreshBusy=false;}
  }
  function updateStatusDom() {
    document.querySelectorAll('.inbox-runtime-status').forEach(el=>el.textContent=runtimeLabel());
    const stats=inboxDisplayStats(runtime,state.data||{});
    document.querySelectorAll('.inbox-last-run').forEach(el=>el.textContent=stats.lastRunAt?dateLabel(stats.lastRunAt):'尚未运行');
    document.querySelectorAll('.inbox-next-run').forEach(el=>el.textContent=!settings().enabled?'已暂停':stats.nextRunAt?dateLabel(stats.nextRunAt):'等待调度');
    for(const [selector,key] of [['.inbox-last-new','newConversations'],['.inbox-last-collected','collected'],['.inbox-last-failed','failed'],['.inbox-pending-collection','pendingCollection'],['.inbox-pending-analysis','pendingAnalysis']])document.querySelectorAll(selector).forEach(el=>el.textContent=stats[key]);
    document.querySelectorAll('.inbox-refresh-note').forEach(el=>{el.hidden=!state.inboxRefreshPending;el.textContent='后台已有更新；结束输入或关闭详情后，列表会自动刷新。';});
    document.querySelectorAll('.candidate-inbox-runbar').forEach(el=>el.classList.toggle('backend-disconnected',runtime.connected===false));
    document.querySelectorAll('.inbox-backend-note').forEach(el=>{el.hidden=runtime.connected!==false;el.textContent='后台连接中断：定时任务需要本地服务持续运行。连接恢复后会自动刷新列表。';});
    document.querySelectorAll('.inbox-last-result').forEach(el=>el.innerHTML=[runtime.lastError||runtime.lastRun?.error?.message,runtime.lastResult?.message||runtime.lastRun?.message].filter(Boolean).map(value=>`<p>${esc(value)}</p>`).join(''));
  }
  function stageInfo(scene) {return PROMPT_STAGES.find(stage=>stage.scene===scene);}
  function renderPromptStages() {return `<nav class="prompt-stage-map" aria-label="提示词使用环节">${PROMPT_STAGES.map(stage=>`<button data-action="priority-open-template" data-scene="${stage.scene}" class="${state.promptSceneFilter===stage.scene?'active':''}"><span>${stage.step}</span><strong>${stage.label}</strong></button>`).join('')}</nav>`;}
  function renderPromptUsage(prompt) {const stage=stageInfo(prompt.scene);return stage?`<div class="prompt-usage"><div>${icon('flow')}<span><strong>使用环节 ${stage.step} · ${esc(stage.label)}</strong><p>${esc(stage.usage)}</p></span></div>${btn('priority-open-stage','前往使用环节','arrow','small',`data-scene="${esc(stage.scene)}"`)}</div>`:'';}
  function openTemplate(scene,promptId) {if(['live_assist','interview_verify'].includes(scene)){scene=scene==='live_assist'?'interview_copilot':'interview_report';promptId='';}const prompt=byId('prompts',promptId)||all('prompts').find(row=>row.scene===scene);state.promptSceneFilter=scene||prompt?.scene||'';state.promptQuery='';state.selectedPromptId=prompt?.id||null;closeOverlay();setView('prompts');document.querySelector('.page-header')?.scrollIntoView({block:'start'});}
  function enhanceView() {
    if(state.view==='automations') {
      document.querySelector('.content .notice')?.remove();
      document.querySelector('.page-header')?.insertAdjacentHTML('afterend',renderAutomationPanel());
    }
    if(state.view==='settings') {
      const modelPanel=document.getElementById('model-settings-panel');
      if(modelPanel)document.querySelector('.page-header')?.insertAdjacentElement('afterend',modelPanel);
      modelPanel?.insertAdjacentHTML('beforebegin',renderAutomationPanel());
    }
    if(state.view==='conversations') {
      document.querySelector('.communication-scope')?.insertAdjacentHTML('beforebegin',renderAutomationPanel(true));
      document.querySelector('.conversation-filters')?.insertAdjacentHTML('beforeend',`<select class="control" data-filter="conversationSort" aria-label="会话排序"><option value="latest" ${state.conversationSort==='latest'?'selected':''}>按最新消息排序</option><option value="priority" ${state.conversationSort==='priority'?'selected':''}>按回复优先分排序</option></select><select class="control" data-filter="priorityFilter" aria-label="回复优先级筛选"><option value="">全部分析状态</option>${[['high','优先回复'],['normal','常规跟进'],['low','较后处理'],['insufficient','资料待补'],['assessed','已有分析'],['unassessed','尚未分析'],['stale','材料已变化']].map(([value,label])=>`<option value="${value}" ${state.priorityFilter===value?'selected':''}>${label}</option>`).join('')}</select>`);
      for(const element of document.querySelectorAll('.conversation-list-item[data-id]')) {const conversation=byId('conversations',element.dataset.id);if(conversation)element.querySelector('.conversation-preview')?.insertAdjacentHTML('beforebegin',listBadge(conversation));}
      const conversation=byId('conversations',state.selectedConversationId);
      if(conversation)document.querySelector('.conversation-detail-scroll .communication-message-section')?.insertAdjacentHTML('beforebegin',renderScoreCard(conversation));
    }
    if(['conversations','settings','automations'].includes(state.view))refreshStatus();
  }
  function handleAction(button) {
    const {action,id,scene}=button.dataset;
    if(action==='priority-open-template')openTemplate(scene,id);
    else if(action==='priority-open-stage'){const stage=stageInfo(scene);if(stage){closeOverlay();setView(stage.view);document.querySelector('.page-header')?.scrollIntoView({block:'start'});}}
    else if(action==='priority-configure'){setView('automations');document.getElementById('inbox-automation-panel')?.scrollIntoView({behavior:'smooth',block:'start'});}
    else if(action==='priority-run-inbox')run(button,async()=>{const result=await api('/api/inbox/run','POST',{});await loadWorkspace();await refreshStatus(true);resultNotice(result,'本轮同步与分析已返回，请核对资料覆盖范围。');});
    else if(action==='priority-analyse'||action==='priority-force-analyse') {
      const force=action==='priority-force-analyse',existing=priorityFor(byId('conversations',id));
      if(!modelReady()&&(force||!existing)){setView('settings');document.getElementById('model-settings-panel')?.scrollIntoView({behavior:'smooth',block:'start'});}
      else run(button,async()=>{const result=await api(`/api/conversations/${encodeURIComponent(id)}/priority-analysis`,'POST',{generator:'model',force});if(result.reused)reuseChecks.set(id,{analysisId:result.id,generatedAt:result.generatedAt||result.createdAt});else reuseChecks.delete(id);await loadWorkspace();if(result.reused)notify(result.message||'资料未变化，复用已有分析，本次未调用模型 API、未新增 Token 用量。');else resultNotice(result,'回复优先级分析已生成，等待人工复核。');});
    }
    else return false;
    return true;
  }
  function handleSubmit(event) {
    const form=event.target;if(form.id!=='adv-inbox-automation-form')return false;
    event.preventDefault();if(!form.reportValidity())return true;
    const values=new FormData(form),button=event.submitter||form.querySelector('[type=submit]');
    run(button,async()=>{await api('/api/inbox/settings','PATCH',{enabled:values.has('enabled'),autoAnalyze:values.has('autoAnalyze'),intervalMinutes:Number(values.get('intervalMinutes'))});await loadWorkspace();await refreshStatus(true);notify('自动同步设置已保存。');});
    return true;
  }
  const statusTimer=setInterval(()=>{if(['conversations','settings','automations'].includes(state.view)&&document.visibilityState!=='hidden')refreshStatus(true);},15000);
  statusTimer.unref?.();
  const markUnsaved=event=>{const form=event.target.closest?.('form');if(form)form.dataset.inboxUnsaved='true';};
  document.addEventListener('input',markUnsaved,true);document.addEventListener('change',markUnsaved,true);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden'&&['conversations','settings','automations'].includes(state.view))refreshStatus(true);});
  return {enhanceView,handleAction,handleSubmit,priorityCompare,matchesPriority,renderPromptStages,renderPromptUsage,promptLink,openTemplate,renderScoreCard};
}
