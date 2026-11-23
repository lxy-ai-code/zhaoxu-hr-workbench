export const INTERVIEW_MESSAGE_STAGES = [
  ['invitation','会议邀请','创建日程后发送会议入口'],
  ['preparation','会前资料','按本场提前时间发送准备与附件'],
  ['joined','开始辅助','云咩咩确认入会后发送'],
  ['copilot','会中辅助','仅推送重要问题与节奏建议'],
  ['summarizing','开始总结','确认会议结束后发送'],
  ['summary','面试总结','报告生成后发送总结'],
];
const array=value=>Array.isArray(value)?value:[];
const validId=value=>typeof value==='string'&&/^ou_[A-Za-z0-9_-]{1,200}$/.test(value);
const checked=value=>value===true||value==='true';
const unnamedRecipients=new Set(['原提醒接收人','已确认飞书身份','已确认飞书联系人','已配置接收人']);

export function isNamedInterviewRecipient(person) {
  const name=typeof person?.name==='string'?person.name.trim():'';
  return validId(person?.openId)&&Boolean(name)&&!unnamedRecipients.has(name)&&!/^ou_[A-Za-z0-9_-]+$/.test(name);
}

function recipientSelectionText(rows) {
  const choices=normalizeRecipientChoices(rows),names=choices.filter(isNamedInterviewRecipient).map(person=>person.name),unresolved=choices.length-names.length;
  return `${names.length?`已选面试官：${names.join('、')}`:'已选面试官：请搜索姓名并勾选'}${unresolved?`（${unresolved} 位旧接收人待核对姓名）`:''}`;
}

export function normalizeRecipientChoices(rows) {
  const seen=new Set();
  return array(rows).filter(row=>row&&validId(row.openId)&&!seen.has(row.openId)&&seen.add(row.openId)).map(row=>({openId:row.openId,name:typeof row.name==='string'&&row.name.trim()?row.name.trim().slice(0,100):'已确认飞书身份',...(typeof row.department==='string'&&row.department.trim()?{department:row.department.trim().slice(0,200)}:{}),...(typeof row.appId==='string'&&row.appId?{appId:row.appId}:{})}));
}

export function configuredInterviewRecipients(settings={},interview={}) {
  const config=settings.interviewAutomation||settings;
  if(Array.isArray(interview.notificationRecipients))return normalizeRecipientChoices(interview.notificationRecipients);
  if(Array.isArray(config.defaultNotificationRecipients))return normalizeRecipientChoices(config.defaultNotificationRecipients);
  return validId(config.reminderRecipientOpenId)?[{openId:config.reminderRecipientOpenId,name:'原提醒接收人'}]:[];
}

export function parseRecipientLines(text='') {
  if(typeof text!=='string')throw new Error('请按每行“姓名 | 飞书身份”填写。');
  const rows=text.split(/\r?\n/).map(row=>row.trim()).filter(Boolean).map(line=>{
    const match=line.match(/^(.+?)\s*[|｜]\s*(ou_[A-Za-z0-9_-]{1,200})$/);
    if(!match||!match[1].trim()||match[1].trim().length>100)throw new Error('接收人格式为“姓名 | ou_…”；请使用当前云咩咩应用已确认的飞书身份。');
    return {name:match[1].trim(),openId:match[2]};
  });
  if(rows.length>20)throw new Error('每次最多配置20位面试消息接收人。');
  return normalizeRecipientChoices(rows);
}

export function recipientFormPayload(values={},prefix='notification') {
  const rows=Object.entries(values).filter(([key])=>key.startsWith(`${prefix}Recipient_`)).map(([,value])=>{
    let row;try{row=JSON.parse(value);}catch{throw new Error('面试官选项已失效，请刷新后重新选择。');}
    if(!validId(row?.openId)||typeof row.name!=='string'||!row.name.trim())throw new Error('请明确选择有效的面试官身份。');
    return row;
  });
  const recipients=normalizeRecipientChoices([...rows,...parseRecipientLines(values[`${prefix}RecipientsText`]||'')]).map(({openId,name})=>({openId,name}));
  if(recipients.length>20)throw new Error('每场最多选择20位消息接收人。');
  return recipients;
}

export function interviewNotificationPayload(values={}) {
  const payload={};
  if(values.notificationRecipientsPresent==='true')payload.notificationRecipients=recipientFormPayload(values);
  if(values.notificationSettingsPresent==='true')payload.notificationSettings=Object.fromEntries(INTERVIEW_MESSAGE_STAGES.map(([key])=>[key,checked(values[`notificationStage_${key}`])]));
  return payload;
}

export function renderRecipientPicker({directory=[],selected=[],prefix='notification',escape:esc,idPrefix='interview-notify',includeManual=true,appId=''}={}) {
  const choices=normalizeRecipientChoices([...array(directory),...array(selected)]),selectedIds=new Set(array(selected).map(row=>row.openId));
  return `<div class="interview-recipient-picker" data-recipient-picker data-prefix="${esc(prefix)}" data-recipient-app-id="${esc(appId)}"><input type="hidden" name="${prefix}RecipientsPresent" value="true"><label class="interview-directory-label" for="${esc(idPrefix)}-search">搜索飞书通讯录</label><div class="interview-directory-search"><input id="${esc(idPrefix)}-search" class="control" data-recipient-query type="search" placeholder="输入面试官姓名" autocomplete="off" aria-label="搜索飞书面试官"><button type="button" class="btn small" data-recipient-search>搜索</button></div><p class="interview-directory-status" data-recipient-status aria-live="polite">输入姓名后搜索并勾选；同名人员请核对部门。</p><p class="interview-recipient-result-label" data-recipient-result-label>常用 / 已选面试官</p><div class="interview-recipient-choices" data-recipient-choices>${recipientChoiceMarkup(choices,selectedIds,prefix,esc)}</div><p class="interview-recipient-selected" data-recipient-selected aria-live="polite">${esc(recipientSelectionText(choices.filter(person=>selectedIds.has(person.openId))))}</p><p class="input-note">已勾选的面试官会保留，搜索其他姓名可继续添加。接收人需在云咩咩应用的可用范围内；业务面试官直接在飞书接收消息，无需登录工作台。</p></div>`;
}

function recipientChoiceMarkup(choices,selectedIds,prefix,esc) {
  return choices.map((person,index)=>`<label class="interview-recipient-option"><input type="checkbox" name="${prefix}Recipient_${index}" value="${esc(JSON.stringify({openId:person.openId,name:person.name}))}" data-recipient-department="${esc(person.department||'')}" data-recipient-app-id="${esc(person.appId||'')}" ${selectedIds.has(person.openId)?'checked':''}><span><strong>${esc(person.name)}</strong><small>${esc(person.department||'已确认飞书联系人')}</small></span></label>`).join('');
}

/** Per-picker sequence and app binding discard stale directory responses. */
export function createRecipientSearchModel({api,currentAppId=()=>''}={}) {
  let sequence=0;
  return {invalidate(){sequence++;},async search(query,{explicit=false}={}){
    const clean=String(query||'').trim(),turn=++sequence,appId=currentAppId();
    if(!clean||(!explicit&&[...clean].length<2))return {status:'idle',recipients:[],message:clean?'再输入一个字，或点击搜索。':'请输入面试官姓名。'};
    try{
      const result=await api(`/api/feishu/recipients?query=${encodeURIComponent(clean)}`);
      if(turn!==sequence||currentAppId()!==appId)return {status:'discarded',recipients:[]};
      if(result?.appId&&appId&&result.appId!==appId)return {status:'unavailable',recipients:[],message:'飞书应用已变化，请刷新后重新搜索。'};
      if(!['ok','partial'].includes(result?.status)||result?.source!=='feishu_directory')return {status:result?.status||'unavailable',recipients:[],message:result?.message||'飞书通讯录暂不可用，请联系管理员完成授权。'};
      const recipients=normalizeRecipientChoices(array(result.recipients).filter(row=>row.selectable!==false)).filter(row=>!row.appId||!appId||row.appId===appId);
      return {status:result.status,recipients,message:[result.status==='partial'?'通讯录覆盖尚不完整；以下仅显示已读取的联系人，未找到不代表不存在。':'',recipients.length?`找到 ${recipients.length} 位联系人，请勾选并核对部门。`:'没有找到可见的匹配联系人，可尝试完整姓名。',result.message].filter(Boolean).join(' ')};
    }catch(error){if(turn!==sequence||currentAppId()!==appId)return {status:'discarded',recipients:[]};return {status:'unavailable',recipients:[],message:error.message||'通讯录搜索暂未完成。'};}
  }};
}

export function createRecipientDirectoryController({api,escape:esc,currentAppId=()=>''}={}) {
  const pickers=new WeakMap();
  const get=picker=>{let entry=pickers.get(picker);if(!entry){entry={model:createRecipientSearchModel({api,currentAppId}),timer:null,selected:new Map()};pickers.set(picker,entry);}for(const input of picker.querySelectorAll('input[type=checkbox]')){let person;try{person=JSON.parse(input.value);if(input.dataset.recipientDepartment)person.department=input.dataset.recipientDepartment;if(input.dataset.recipientAppId)person.appId=input.dataset.recipientAppId;}catch{continue;}if(input.checked)entry.selected.set(person.openId,person);else entry.selected.delete(person.openId);}return entry;};
  function showSelection(picker,entry){const selected=picker.querySelector('[data-recipient-selected]');if(selected)selected.textContent=recipientSelectionText([...entry.selected.values()]);}
  async function search(picker,explicit){if(!picker.isConnected)return;const entry=get(picker),query=picker.querySelector('[data-recipient-query]')?.value||'',status=picker.querySelector('[data-recipient-status]');if(!status)return;status.textContent='正在搜索飞书通讯录…';const result=await entry.model.search(query,{explicit});if(!picker.isConnected||result.status==='discarded')return;status.textContent=result.message||'';status.dataset.state=result.status;if(['ok','partial'].includes(result.status)){const label=picker.querySelector('[data-recipient-result-label]');if(label)label.textContent=result.status==='partial'?'已读取的搜索结果与已选面试官':'搜索结果与已选面试官';for(const person of result.recipients)if(entry.selected.has(person.openId))entry.selected.set(person.openId,person);const all=normalizeRecipientChoices([...result.recipients,...entry.selected.values()]);picker.querySelector('[data-recipient-choices]').innerHTML=recipientChoiceMarkup(all,new Set(entry.selected.keys()),picker.dataset.prefix||'notification',esc);showSelection(picker,entry);}}
  return {validateForm(form){for(const picker of form.querySelectorAll('[data-recipient-picker]'))if(picker.dataset.recipientAppId&&currentAppId()&&picker.dataset.recipientAppId!==currentAppId())throw new Error('飞书应用已变化，请重新打开面试安排并搜索选择面试官。');},handleInput(event){const picker=event.target.closest?.('[data-recipient-picker]');if(!picker)return false;const entry=get(picker);if(event.target.matches?.('[data-recipient-query]')){clearTimeout(entry.timer);entry.model.invalidate();entry.timer=setTimeout(()=>{void search(picker,false);},400);return true;}if(event.target.type==='checkbox'){showSelection(picker,entry);return true;}return false;},handleClick(event){const button=event.target.closest?.('[data-recipient-search]');if(!button)return false;const picker=button.closest('[data-recipient-picker]'),entry=get(picker);clearTimeout(entry.timer);void search(picker,true);return true;},handleKeydown(event){if(event.key!=='Enter'||!event.target.matches?.('[data-recipient-query]'))return false;event.preventDefault();const picker=event.target.closest('[data-recipient-picker]'),entry=get(picker);clearTimeout(entry.timer);void search(picker,true);return true;}};
}

export function renderNotificationStages(settings={},esc,prefix='notification') {
  settings=settings&&typeof settings==='object'?settings:{};
  return `<input type="hidden" name="${prefix}SettingsPresent" value="true"><div class="interview-notification-stage-grid">${INTERVIEW_MESSAGE_STAGES.map(([key,label,description])=>`<label class="interview-notification-stage"><input type="checkbox" name="${prefix}Stage_${key}" value="true" ${settings[key]!==false?'checked':''}><span><strong>${esc(label)}</strong><small>${esc(description)}</small></span></label>`).join('')}</div>`;
}

export function renderScheduleNotificationOptions(settings={},ctx={}) {
  const config=settings.interviewAutomation||{},selected=configuredInterviewRecipients(settings);
  return `<fieldset class="field full interview-notification-options"><legend>接收面试消息的面试官</legend><p>同一位面试官将按下方选择，在飞书收到本场邀请、会前资料、会中辅助与会后总结。</p>${renderRecipientPicker({directory:config.recipientDirectory,selected,escape:ctx.escape,appId:settings.feishuConnection?.appId})}<h4>本场发送哪些消息</h4>${renderNotificationStages(config.defaultNotificationSettings,ctx.escape)}</fieldset>`;
}

export function automationRecipientSettingsPayload(values={}) {
  const result={};
  if(values.recipientDirectoryPresent==='true')result.recipientDirectory=parseRecipientLines(values.recipientDirectoryText||'');
  if(values.defaultNotificationRecipientsPresent==='true')result.defaultNotificationRecipients=recipientFormPayload(values,'defaultNotification');
  if(values.defaultNotificationSettingsPresent==='true')result.defaultNotificationSettings=Object.fromEntries(INTERVIEW_MESSAGE_STAGES.map(([key])=>[key,checked(values[`defaultNotificationStage_${key}`])]));
  return result;
}

export function renderDefaultInterviewNotificationSettings(settings={},ctx={}) {
  const {escape:esc}=ctx,config=settings.interviewAutomation||{},selected=configuredInterviewRecipients(settings),directory=normalizeRecipientChoices([...array(config.recipientDirectory),...selected]);
  return `<section class="interview-default-recipients"><h3>接收面试消息的面试官</h3><p>直接搜索飞书通讯录，按姓名和部门选择默认面试官。安排面试时可单独调整，业务面试官只需在飞书接收消息。</p><h4>默认接收人</h4>${renderRecipientPicker({directory,selected,prefix:'defaultNotification',escape:esc,idPrefix:'default-interview-notify',appId:settings.feishuConnection?.appId})}<details class="interview-recipient-manual"><summary>管理员维护 · 兼容旧联系人</summary><label class="interview-directory-label" for="automation-recipient-directory">已确认联系人备份</label><input type="hidden" name="recipientDirectoryPresent" value="true"><textarea id="automation-recipient-directory" name="recipientDirectoryText" class="control" rows="3" spellcheck="false">${esc(directory.map(row=>`${row.name} | ${row.openId}`).join('\n'))}</textarea><small>仅供管理员兼容旧配置；HR日常直接搜名字，不需要填写技术标识。</small></details><h4>新面试默认发送环节</h4>${renderNotificationStages(config.defaultNotificationSettings,esc,'defaultNotification')}<p class="input-note">默认设置用于新安排的面试，已有面试以各场保存的设置为准。</p></section>`;
}

export function renderInterviewNotificationSettings(interview={},settings={},ctx={}) {
  const {escape:esc,badge=label=>label,dateLabel=value=>value}=ctx,config=settings.interviewAutomation||{},recipients=configuredInterviewRecipients(settings,interview);
  const deliveries=array(interview.notifications?.deliveries),stageNames={...Object.fromEntries(INTERVIEW_MESSAGE_STAGES.map(([key,label])=>[key,label])),calendar_invitation:'飞书日程邀请'};
  const statusNames={pending:'待发送',scheduled:'待发送',sending:'正在发送',sent:'已发送',invited:'已邀请',failed:'发送失败',blocked:'等待处理',unknown_delivery:'结果待核验',skipped:'本次跳过',cancelled:'已取消',disabled:'未启用'};
  const receipts=deliveries.map(row=>{const sent=row.status==='sent'&&Boolean(row.messageId),invited=row.kind==='calendar_invitation'&&row.status==='invited'&&Boolean(row.eventId),recipient=recipients.find(person=>person.openId===(row.recipientOpenId||row.openId));return `<li><span>${esc(stageNames[row.stage||row.kind]||'面试消息')}</span><strong>${esc(row.recipientName||recipient?.name||'已配置接收人')}</strong>${badge(sent?'已发送':invited?'已邀请':['sent','invited'].includes(row.status)?'回执待核验':statusNames[row.status]||'等待处理',sent||invited?'green':row.status==='unknown_delivery'||row.status==='failed'?'orange':'gray')}${row.sentAt?`<small>${esc(dateLabel(row.sentAt))}</small>`:''}</li>`;}).join('');
  return `<section class="interview-notifications-panel" aria-label="面试官飞书消息"><header><div><h3>面试官飞书消息</h3><p>${recipients.length?recipients.map(row=>esc(row.name)).join('、'):'尚未指定接收人'} · 业务面试官无需使用工作台</p></div>${badge(`${recipients.length} 位接收人`,recipients.length?'green':'orange')}</header><details class="interview-notifications-edit"><summary>调整本场接收人与消息环节</summary><form id="adv-interview-notifications-form" data-id="${esc(interview.id)}">${renderRecipientPicker({directory:config.recipientDirectory,selected:recipients,escape:esc,idPrefix:'edit-interview-notify',appId:settings.feishuConnection?.appId})}<h4>消息环节</h4>${renderNotificationStages(interview.notificationSettings,esc)}<p class="input-note">保存仅影响本场后续任务，已发送消息保留回执，不会因调整接收人重复发送旧消息。</p><button type="submit" class="btn small primary">保存本场消息设置</button></form></details>${receipts?`<details class="interview-notification-receipts"><summary>查看发送记录 · ${deliveries.length} 条</summary><ul>${receipts}</ul></details>`:'<p class="input-note">尚无本场消息发送记录；实际发送后会逐人显示回执。</p>'}</section>`;
}
