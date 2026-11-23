export const MAX_REMINDER_MINUTES=10080;

export function eligibleInterviewApplications(data,candidateId='') {
  return (data.applications||[]).filter(application=>(!candidateId||application.candidateId===candidateId)&&application.stage!=='archived'&&(data.requirements||[]).some(requirement=>requirement.id===application.requirementId));
}

export function defaultReminderMinutes(settings={}) {
  const value=Number(settings.interviewAutomation?.defaultReminderMinutes??30);
  return Number.isInteger(value)&&value>=0&&value<=MAX_REMINDER_MINUTES?value:30;
}

export function interviewSchedulePayload(values,applicationId) {
  if(!applicationId)throw new Error('请明确选择本场面试关联的候选人与岗位。');
  const parseTime=value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value||'')?new Date(`${value}:00+08:00`):new Date(NaN);
  const start=parseTime(values.startAt),end=parseTime(values.endAt);
  if(!Number.isFinite(start.valueOf())||!Number.isFinite(end.valueOf()))throw new Error('请填写有效的面试开始和结束时间。');
  if(end<=start)throw new Error('结束时间必须晚于开始时间。');
  const reminderMinutes=Number(values.reminderMinutes);
  if(values.reminderMinutes==null||String(values.reminderMinutes).trim()===''||!Number.isInteger(reminderMinutes)||reminderMinutes<0||reminderMinutes>MAX_REMINDER_MINUTES)throw new Error('提醒提前时间须为 0–10080 的整数分钟。');
  const checked=value=>value===true||value==='true';
  const fields=Object.fromEntries(Object.entries(values).filter(([key])=>!key.startsWith('notification')));
  const notifications=interviewNotificationPayload(values);
  const names=(notifications.notificationRecipients||[]).filter(isNamedInterviewRecipient).map(person=>person.name);
  const legacyInterviewer=typeof values.interviewer==='string'?values.interviewer.trim():'';
  const interviewer=names.length?names.join('、'):isNamedInterviewRecipient({openId:'ou_manual',name:legacyInterviewer})?legacyInterviewer:'';
  if(!interviewer)throw new Error('请搜索飞书通讯录并勾选面试官；若使用旧安排方式，请在面试官备注中填写面试官姓名。');
  return {...fields,interviewer,applicationId,startAt:start.toISOString(),endAt:end.toISOString(),createCalendar:checked(values.createCalendar),reminderEnabled:notifications.notificationSettings?notifications.notificationSettings.preparation:checked(values.reminderEnabled),reminderMinutes,autoJoinEnabled:checked(values.autoJoinEnabled),...notifications};
}

export function interviewCalendarState(interview={}) {
  const status=interview.calendarStatus;
  if(status==='synced')return interview.eventId?{label:interview.calendarBinding?.source==='existing_event'?'已关联飞书日程':'飞书日程已创建',color:'green'}:{label:'日程回执待核验',color:'orange'};
  return ({pending:{label:'日程创建中',color:'blue'},failed:{label:'日程创建未完成',color:'orange'},unknown_delivery:{label:'日程结果待核验',color:'orange'}})[status]||{label:'本地安排',color:'gray'};
}

export function verifiedJoinedMeetingId(interview,connection) {
  const joined=interview?.autoJoin,receipt=joined?.feishuConnection;
  if(joined?.status!=='joined'||typeof joined.meetingId!=='string'||!/^\d{10,25}$/.test(joined.meetingId))return '';
  const explicit=value=>value&&typeof value==='object'&&!Array.isArray(value)&&['profile','appId'].every(key=>typeof value[key]==='string'&&value[key].trim())&&['bot','user'].includes(value.identity)&&(value.tenantKey==null||typeof value.tenantKey==='string');
  if(!explicit(receipt)||!explicit(connection))return '';
  if(!['profile','identity','appId','tenantKey'].every(key=>(receipt[key]??'')===(connection[key]??'')))return '';
  return joined.meetingId;
}

export async function refreshExistingInterviewStatus(interview,{api,loadWorkspace,showInterviewDetail,notify}) {
  if(!interview?.id)return;
  let metadataError;
  if(interview.calendarStatus==='synced'&&interview.eventId){
    try{await api(`/api/interviews/${encodeURIComponent(interview.id)}/calendar/refresh`,'POST',{});}catch(error){metadataError=error;}
  }
  await loadWorkspace();showInterviewDetail(interview.id);
  if(metadataError)notify(`现有日程链接读取未完成：${metadataError.message||'请稍后重试'}。请在飞书核对原日程。`,true);
}

export function renderInterviewExecutionStatus(interview,{escape:esc,badge,btn,dateLabel}) {
  const calendar=interviewCalendarState(interview),reminder=interview.reminder||{},autoJoin=interview.autoJoin||{},test=reminder.testReceipt;
  const labels={scheduled:'待执行',pending:'待执行',sending:'正在发送',joining:'正在请求入会',awaiting_approval:'等待主持人允许入会',cancelled:'已取消',ended:'会议已结束',requested:'入会请求已受理，待确认',accepted:'入会请求已受理，待确认',joined:'机器人已入会',sent:'正式提醒已发送',failed:'执行未完成',unknown_delivery:'结果待核验',disabled:'未启用',waiting:'等待会议开始',waiting_meeting:'等待会议创建',waiting_config:'等待系统配置',blocked:'等待处理',expired:'已过执行时间',skipped:'本次未执行'};
  const errorText=error=>typeof error==='string'?error:[error?.message,error?.code?`（${error.code}）`:''].filter(Boolean).join(' ')||'执行未完成';
  const row=(label,value)=>value?`<p><span>${label}</span><strong>${esc(value)}</strong></p>`:'';
  const stateBadge=(status,fallback,success)=>badge(labels[status]||status||fallback,success?'green':['failed','unknown_delivery','blocked','expired'].includes(status)?'orange':status==='disabled'?'gray':'blue');
  const reminderStatus=reminder.status||(interview.reminderEnabled===false?'disabled':''),joinStatus=autoJoin.status||(interview.autoJoinEnabled===false?'disabled':'');
  const link=raw=>{try{const url=new URL(raw);return ['https:','http:'].includes(url.protocol)?url.href:'';}catch{return '';}};
  const calendarUrl=link(interview.calendarUrl),meetingUrl=link(interview.meetingUrl);
  const hasTestReceipt=Boolean(test?.messageId);
  return `<section class="interview-execution-status" aria-label="日程与机器人任务"><div class="interview-execution-heading"><h3>日程与机器人任务</h3><div class="execution-heading-actions"><span>以飞书返回的回执为准</span>${btn('interview-status-refresh','刷新状态','refresh','small',`data-id="${esc(interview.id)}"`)}</div></div><div class="interview-execution-grid"><article><h4>飞书日程 ${badge(calendar.label,calendar.color)}</h4>${row('开始时间',interview.startAt?dateLabel(interview.startAt):'')}${row('结束时间',interview.endAt?dateLabel(interview.endAt):'')}${calendarUrl?`<a class="btn small" href="${esc(calendarUrl)}" target="_blank" rel="noopener">打开飞书日程 ↗</a>`:''}${meetingUrl?`<a class="btn small" href="${esc(meetingUrl)}" target="_blank" rel="noopener">打开飞书会议 ↗</a>`:''}${interview.calendarStatus==='synced'&&interview.eventId&&!calendarUrl&&!meetingUrl?'<p class="execution-note">链接待读取，可点击刷新状态。</p>':''}${interview.calendarId||interview.eventId?`<details class="interview-calendar-receipt"><summary>查看日程回执</summary>${row('日历 ID',interview.calendarId)}${row('日程 ID',interview.eventId)}</details>`:''}${interview.calendarError?`<p class="execution-error">${esc(errorText(interview.calendarError))}</p>`:''}${interview.calendarStatus==='unknown_delivery'?'<p class="execution-error">请先核验原日程，避免重复创建。</p>':''}</article><article><h4>机器人提醒 ${reminderStatus==='sent'&&!reminder.messageId?badge('提醒回执待核验','orange'):stateBadge(reminderStatus,'未配置',Boolean(reminder.messageId&&reminderStatus==='sent'))}</h4>${row('提前时间',interview.reminderMinutes!=null?`${interview.reminderMinutes} 分钟`:'')}${row('正式提醒时间',reminder.dueAt?dateLabel(reminder.dueAt):'')}${row('正式发送时间',reminder.sentAt?dateLabel(reminder.sentAt):'')}${row('正式消息回执',reminder.messageId)}${reminder.error?`<p class="execution-error">${esc(errorText(reminder.error))}</p>`:''}${test?`<div class="interview-test-receipt">${badge(hasTestReceipt?'测试卡片已发送':test.status==='unknown_delivery'?'测试结果待核验':'测试卡片未确认',hasTestReceipt?'green':'orange')}${row('测试消息回执',test.messageId)}${row('测试发送时间',test.sentAt?dateLabel(test.sentAt):'')}${test.error?`<p class="execution-error">${esc(errorText(test.error))}</p>`:''}<small>测试卡片不替代正式提醒。</small></div>`:''}<div class="execution-actions">${btn('interview-reminder-test',hasTestReceipt?'测试卡片已发送':'发送测试提醒','chat','small',`data-id="${esc(interview.id)}" ${hasTestReceipt||['unknown_delivery','sending','pending'].includes(test?.status)?'disabled':''}`)}</div></article><article><h4>机器人自动入会 ${joinStatus==='joined'&&!autoJoin.joinedAt?badge('入会回执待核验','orange'):stateBadge(joinStatus,'未配置',joinStatus==='joined'&&Boolean(autoJoin.joinedAt))}</h4>${row('计划入会时间',interview.autoJoinEnabled&&interview.startAt?dateLabel(interview.startAt):'')}${row(autoJoin.verificationSource==='bot_user_active_meeting'?'确认在会时间':'入会时间',autoJoin.joinedAt?dateLabel(autoJoin.joinedAt):'')}${row('会议 ID',autoJoin.meetingId)}${row('会议号',autoJoin.meetingNo)}${autoJoin.error?`<p class="execution-error">${esc(errorText(autoJoin.error))}</p>`:''}${!autoJoin.joinedAt&&['requested','accepted','joining','awaiting_approval'].includes(joinStatus)?'<p class="execution-note">已提交的入会请求仍需会议状态确认。</p>':''}</article></div></section>`;
}
import {interviewNotificationPayload,isNamedInterviewRecipient} from './interview-recipients.js';

