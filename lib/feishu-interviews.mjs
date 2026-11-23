import { createHash } from 'node:crypto';
import { runLark, LarkCliError } from './lark-cli.mjs';
import { larkArguments, normalizeLarkConnection, sameLarkConnection, withLarkErrorContext } from './lark-context.mjs';
import { assertCalendarConnection, shanghaiISO } from './feishu.mjs';
import { confirmInterviewMeetingPresence } from './interview-presence.mjs';
import { selectReminderAttachments, prepareReminderAttachments, stageReminderAttachments } from './interview-reminder-attachments.mjs';
import { ROOT } from './store.mjs';
import { professionalPriorityText } from './professional-text.mjs';
import { candidateBasicInfo } from './candidate-basic-info.mjs';
import { candidateCareerProfile } from './candidate-career-profile.mjs';

const fail = (message, code, details = {}) => new LarkCliError(message, { code, statusCode: 422, ...details });
const dataOf = value => value?.data ?? value;
const valueText = value => typeof value === 'string' ? value.trim() : '';
const clip = (value, limit) => { const clean = valueText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean; };
// Content is untrusted source material, never Card markup, an @mention or a link.
const markdownText = value => String(value ?? '').replace(/[&<>*~`\[\]()#_\\]/g, char => `&#${char.charCodeAt(0)};`);
const array = value => Array.isArray(value) ? value : [];

function botContext(input, options) {
  if (input.connection && options.connection && !sameLarkConnection(input.connection, options.connection)) throw fail('面试桥的请求连接与服务连接不一致。', 'connection_context_mismatch');
  const connection = input.connection ?? options.connection;
  const normalized = normalizeLarkConnection(connection);
  if (!connection || normalized.identity !== 'bot') throw fail('面试提醒与自动入会必须使用明确配置的飞书机器人连接。', 'identity_unsupported');
  return { connection, normalized };
}

async function invoke(args, input, options, write = false) {
  const { connection } = botContext(input, options);
  try {
    const result = await (options.runner ?? runLark)(larkArguments([...args, '--format', 'json'], connection), { ...options.commandOptions, timeoutMs: write ? 60000 : 45000, write });
    if (result?.ok === false) throw fail(result.error?.message || '飞书拒绝了本次请求。', result.error?.subtype || 'upstream_error', { upstreamCode: result.error?.code, missingScopes: result.error?.missing_scopes });
    return dataOf(result);
  } catch (error) { throw withLarkErrorContext(error, connection); }
}

export function safeFeishuMeetingUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname)) return '';
    // Preserve actual returned URLs; do not create a meeting link from an ID.
    return url.toString();
  } catch { return ''; }
}

export function meetingNumberFromUrl(value) {
  const safe = safeFeishuMeetingUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  return url.pathname.match(/^\/j\/(\d{9})\/?$/)?.[1] || '';
}

function formatWhen(interview) {
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const start = new Date(shanghaiISO(interview.startAt)), end = new Date(shanghaiISO(interview.endAt));
  if (end <= start) throw fail('面试结束时间必须晚于开始时间。', 'invalid_date');
  const startDate = dateFormatter.format(start), endDate = dateFormatter.format(end);
  const duration = (end - start) / 60000;
  return { date: startDate, time: `${timeFormatter.format(start)} — ${startDate === endDate ? '' : `${endDate} `}${timeFormatter.format(end)}`, duration: `${Number.isInteger(duration) ? duration : `约${Math.ceil(duration)}`}分钟`, caption: `${startDate} · 北京时间` };
}

function preparation(input) {
  const { interview = {}, candidate = {}, requirement = {}, document } = input;
  if (!interview.id) throw fail('面试准备缺少面试 ID。', 'invalid_interview');
  for (const [key, current] of [['candidateId',candidate.id],['requirementId',requirement.id]]) if(current&&interview[key]&&current!==interview[key])throw fail('本场面试与候选人或岗位不一致。','preparation_context_mismatch');
  const candidateId=candidate.id||interview.candidateId,requirementId=requirement.id||interview.requirementId;
  for (const [key, expected] of [['candidateId', candidateId], ['requirementId', requirementId], ['applicationId', interview.applicationId]]) {
    if (document?.[key] && expected && document[key] !== expected) throw fail('面试材料与本场候选人、岗位或应聘流程不一致。', 'preparation_context_mismatch');
  }
  const content = document?.content && typeof document.content === 'object' ? document.content : {};
  const prior = input.analysis ?? content.analysis ?? document?.analysis;
  const analysis = prior && (!prior.scene || prior.scene === 'interview_prep') ? prior : null;
  for (const [key, expected] of [['candidateId', candidateId], ['requirementId', requirementId], ['applicationId', interview.applicationId]]) {
    if (analysis?.[key] && expected && analysis[key] !== expected) throw fail('会前分析与本场候选人、岗位或应聘流程不一致。', 'preparation_context_mismatch');
  }
  const questionSources = [...array(analysis?.questions), ...array(content.questions)];
  const seen = new Set();
  const questions = questionSources.flatMap(row => {
    const question = valueText(typeof row === 'string' ? row : row?.question);
    if(question.length>4000)throw fail('单题文字过长，请按会前模板整理为可直接朗读的问题；未截断或隐藏原题。','invalid_preparation_question');
    if (!question || seen.has(question)) return [];
    seen.add(question); return [{ ...(typeof row === 'object' ? row : {}), question, topic: clip(row?.topic, 40) }];
  });
  const rawBasics=candidateBasicInfo(candidate,requirement);
  const hasCandidate=Boolean(input.candidate&&typeof input.candidate==='object'&&!Array.isArray(input.candidate));
  const manualFields=new Set(array(candidate.profileManualFields));
  const savedBasics=content.candidateBasics&&typeof content.candidateBasics==='object'&&!Array.isArray(content.candidateBasics)?content.candidateBasics:{};
  const trustedBasics=Boolean(candidateId&&document?.candidateId===candidateId);
  const trustedJob=Boolean(requirementId&&document?.requirementId===requirementId);
  const safeSaved=candidateBasicInfo({name:savedBasics.name,age:savedBasics.age,degree:savedBasics.degree,workYear:savedBasics.experience,salary:savedBasics.expectedSalary,position:savedBasics.targetPosition,workHistory:[{company:savedBasics.recentCompany,position:savedBasics.recentPosition,dateRange:savedBasics.recentPeriod}]},{title:savedBasics.interviewPosition});
  const basics=Object.fromEntries(Object.entries(rawBasics).map(([key,value])=>[key,value||(!hasCandidate&&(key==='interviewPosition'?trustedBasics&&trustedJob:trustedBasics)?safeSaved[key]:'')]));
  const savedCareer=trustedBasics&&content.candidateProfile?.candidateId===candidateId?content.candidateProfile:{};
  const career=hasCandidate?candidateCareerProfile(candidate):candidateCareerProfile({id:candidateId,city:savedCareer.city,introduction:savedCareer.introduction,briefIntroduction:savedCareer.briefIntroduction,capturedAt:savedCareer.capturedAt,workHistory:savedCareer.workHistory,education:savedCareer.education});
  const school = manualFields.has('school') ? valueText(candidate.school)
    : career.education.find(row => row.school && row.degree === basics.degree)?.school
      || career.education.find(row => row.school)?.school;
  const profile=[clip(basics.name,18)||'姓名 —',`年龄 ${clip(basics.age,10)||'—'}`,`学历 ${clip(basics.degree,16)||'—'}`,
    ...(school ? [`学校 ${clip(school,36)}`] : []), `经验 ${clip(basics.experience,18)||'—'}`,`期望薪资 ${clip(basics.expectedSalary,28)||'—'}`,`目标岗位 ${clip(basics.targetPosition,28)||'—'}`].join(' · ');
  const recentWork=[clip(basics.recentCompany,28),clip(basics.recentPosition,20),clip(basics.recentPeriod,28)].filter(Boolean).join(' · ');
  const questionViews = questions.map(row => ({title:clip(row.topic||'面试提问',20),mainQuestion:row.question,type:row.type||'experience',sources:array(row.evidence),purpose:valueText(row.purpose),referenceAnswer:row.referenceAnswer||null}));
  const focus = questionViews.slice(0, 3).map(row => row.title);
  const savedBrief=analysis?.candidateBrief||content.candidateBrief;
  const snapshotBrief=typeof savedBrief==='string'?savedBrief:savedBrief?.text;
  const briefText=hasCandidate?manualFields.has('briefIntroduction')?valueText(candidate.briefIntroduction):valueText(candidate.briefIntroduction)||valueText(candidate.introduction):trustedBasics?valueText(career.briefIntroduction)||valueText(snapshotBrief)||valueText(career.introduction):'';
  const brief=clip(professionalPriorityText(briefText,2000),180);
  const score=Object.hasOwn(input,'scoreSummary')?input.scoreSummary:content.scoreSummary||analysis?.scoreSummary;
  const scoreSummary=score&&Number.isFinite(score.score)&&score.score>=0&&score.score<=100&&(!score.candidateId||score.candidateId===candidate.id)&&(!score.requirementId||score.requirementId===requirement.id)?score:null;
  const fitReasons=array(savedBrief?.fitReasons).length?array(savedBrief.fitReasons):array(content.candidateBrief?.fitReasons).length?array(content.candidateBrief.fitReasons):array(scoreSummary?.matchReasons);
  const matching=fitReasons.map(row=>typeof row==='string'?{text:row}:row).filter(row=>valueText(row?.text)).slice(0,3);
  const reminderAt = valueText(interview.reminder?.dueAt);
  const reminderTime = reminderAt && Number.isFinite(Date.parse(reminderAt)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(reminderAt)) : '';
  return { when: formatWhen(interview), basics, career, profile, recentWork, focus, brief,scoreSummary,matching,reminderTime, questions, questionViews, meetingUrl: safeFeishuMeetingUrl(interview.meetingUrl), calendarUrl: safeCalendarUrl(interview.calendarUrl) };
}

const md = (content, extra = {}) => ({ tag: 'markdown', content, margin: '0px', ...extra });
function safeCalendarUrl(value) {
  const safe = safeFeishuMeetingUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  return /^(?:applink\.feishu\.cn|applink\.larksuite\.com|applink\.larkoffice\.com)$/.test(url.hostname) && /^\/client\/calendar\/event\/detail\/?$/.test(url.pathname) ? safe : '';
}
function block(elements, { background = 'grey-50', id } = {}) {
  return { tag: 'column_set', ...(id ? { element_id: id } : {}), flex_mode: 'none', horizontal_spacing: '8px', columns: [{ tag: 'column', width: 'weighted', weight: 1, background_style: background, padding: '12px', vertical_spacing: '4px', elements }] };
}
function foldedPanel(title, elements) {
  return { tag: 'collapsible_panel', expanded: false, direction: 'vertical', vertical_spacing: '8px', padding: '8px', border: { color: 'grey-100', corner_radius: '5px' }, header: { title: { tag: 'plain_text', content: title }, background_color: 'grey-50', padding: '8px', width: 'fill', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 }, elements };
}
function questionTile(question, index) {
  const answer=question.referenceAnswer||{},sources=question.sources.slice(0,2).filter(ref=>valueText(ref.quote));
  const sourceLabel=ref=>ref.source==='resume'||/^resumes\[/.test(ref.path||'')?'附件简历':ref.source==='requirement'||/^(?:requirement|job)\./.test(ref.path||'')?'本岗位职责与标准':ref.source==='professionalKnowledge'?'专业参考资料':'候选人职业资料';
  const metadata=[...sources.map(ref=>md(`**来源 · ${markdownText(sourceLabel(ref))}**\n${markdownText(clip(ref.quote,180))}`,{text_size:'notation'})),
    ...(question.purpose?[md(`**考察点**\n${markdownText(clip(question.purpose,160))}`,{text_size:'notation'})]:[]),
    ...(valueText(answer.text)||array(answer.keyPoints).length?[md(`**面试官参考答案${answer.verificationStatus==='verified'?'':' · 待核验'}**\n${markdownText(clip(answer.text,300))}${array(answer.keyPoints).length?'\n'+answer.keyPoints.slice(0,4).map(point=>`• ${markdownText(clip(point,100))}`).join('\n'):''}`,{text_size:'notation'})]:question.type==='professional'?[md('参考答案待补充核验，暂不作为标准答案。',{text_size:'notation'})]:[]),
    ...array(answer.sourceRefs).filter(ref=>valueText(ref.quote)).slice(0,1).map(ref=>md(`**答案依据 · ${markdownText(sourceLabel(ref))}**\n${markdownText(clip(ref.quote,180))}`,{text_size:'notation'})),
  ];
  return block([
    md(`<text_tag color='turquoise'>${String(index + 1).padStart(2, '0')}</text_tag>  **${markdownText(question.title)}**  <font color='grey'>${question.type==='professional'?'专业知识题':'经历核验题'}</font>`),
    md(markdownText(question.mainQuestion)),
    ...(metadata.length?[foldedPanel('来源与面试官参考',metadata)]:[]),
  ], { background: 'grey-50', id: `interview_q${index + 1}` });
}
function preparationScoreRecord(score,matching) {
  if(!score)return [];
  const sourceRefs=matching.flatMap(row=>array(row.evidence)).filter(ref=>valueText(ref?.quote)).slice(0,6);
  return [foldedPanel('评分记录',[
    md(`${markdownText(clip(score.label||score.kind||score.scene||'已有评分',60))} · ${score.score}/100`,{text_size:'notation'}),
    ...(score.stale?[md('历史结果 · 标准或资料已更新',{text_size:'notation'})]:[]),
    ...(score.createdAt?[md(`评分时间：${markdownText(clip(score.createdAt,60))}`,{text_size:'notation'})]:[]),
    ...(valueText(score.summary)?[md(markdownText(clip(score.summary,500)),{text_size:'notation'})]:[]),
    ...(array(score.reasons).length?[md(array(score.reasons).slice(0,3).map(row=>`• ${markdownText(clip(typeof row==='string'?row:row.text,220))}`).join('\n'),{text_size:'notation'})]:[]),
    ...sourceRefs.map(ref=>md(`**${ref.source==='requirement'?'岗位要求':'相关经历'}**\n${markdownText(clip(ref.quote,180))}`,{text_size:'notation'})),
  ])];
}
function fullCandidateProfile(p,attachment) {
  const career=p.career;
  if(attachment)return [foldedPanel('完整候选人资料',[md(`完整资料较长，将以独立附件提供：${markdownText(attachment.name)}`),md(`含 ${career.workHistory.length} 段工作经历、${career.education.length} 段教育经历及完整职业摘要。`,{text_size:'notation'})])];
  const elements=[
    ...(career.city?[md(`**城市**  ${markdownText(career.city)}`,{text_size:'notation'})]:[]),
    ...([p.basics.targetPosition,p.basics.expectedSalary].some(Boolean)?[md(`**求职意向**\n${[p.basics.targetPosition?'目标岗位：'+p.basics.targetPosition:'',p.basics.expectedSalary?'期望薪资：'+p.basics.expectedSalary:''].filter(Boolean).map(markdownText).join('\n')}`,{text_size:'notation'})]:[]),
    ...(career.introduction?[md(`**职业摘要**\n${markdownText(career.introduction)}`)]:[]),
    ...(career.workHistory.length?[md('**全部工作经历**'),...career.workHistory.map((row,index)=>md(`**${String(index+1).padStart(2,'0')} · ${markdownText([row.company,row.position].filter(Boolean).join(' · ')||'工作经历')}**${row.dateRange?'\n'+markdownText(row.dateRange):''}${row.description?'\n'+markdownText(row.description):''}`))]:[]),
    ...(career.education.length?[md('**教育经历**'),...career.education.map((row,index)=>md(`**${String(index+1).padStart(2,'0')} · ${markdownText(row.school||'教育经历')}**${[row.major,row.degree].some(Boolean)?'\n'+markdownText([row.major?'专业 '+row.major:'',row.degree?'学历 '+row.degree:''].filter(Boolean).join(' · ')):''}${row.dateRange?'\n'+markdownText(row.dateRange):''}${row.description?'\n'+markdownText(row.description):''}`))]:[]),
  ];
  return elements.length?[foldedPanel('完整候选人资料',elements)]:[];
}
function completeCandidateText(p) {
  const b=p.basics,c=p.career;
  return ['完整候选人资料',`姓名：${b.name||'—'}`,`年龄：${b.age||'—'}`,`学历：${b.degree||'—'}`,`工作经验：${b.experience||'—'}`,`期望薪资：${b.expectedSalary||'—'}`,`目标岗位：${b.targetPosition||'—'}`,...(b.interviewPosition&&b.interviewPosition!==b.targetPosition?[`本场岗位：${b.interviewPosition}`]:[]),`城市：${c.city||'—'}`,'','职业摘要',c.introduction||'—','','全部工作经历',...c.workHistory.flatMap((row,index)=>[`${index+1}. ${[row.company,row.position,row.dateRange].filter(Boolean).join(' · ')}`,row.description,'']),'教育经历',...c.education.flatMap((row,index)=>[`${index+1}. ${[row.school,row.major?'专业 '+row.major:'',row.degree?'学历 '+row.degree:'',row.dateRange].filter(Boolean).join(' · ')}`,row.description||'','']),...(c.capturedAt?[`资料更新时间：${c.capturedAt}`]:[])].join('\n');
}
function actionButton(label, url, primary) {
  return { tag: 'button', type: primary ? 'primary_filled' : 'default', width: 'fill', text: { tag: 'plain_text', content: label }, behaviors: [{ type: 'open_url', default_url: url }] };
}
function cardNodes(element, { folded = true } = {}) {
  if (!element || typeof element !== 'object') return [];
  if (!folded && element.tag === 'collapsible_panel') return [element.header?.title].filter(Boolean);
  return [element, ...array(element.elements).flatMap(row => cardNodes(row, { folded })), ...array(element.columns).flatMap(row => cardNodes(row, { folded }))];
}
function plainCardText(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/[*`]/g, '');
}

/** Card output follows lark-im-card-create Step 1–3 and P0–P7 gates.
 * Card 2.0, turquoise/default; one time focal point and one folded outline.
 * Attachments are real original files sent beside the card, never local links.
 */
export function buildInterviewReminderCard(input = {}) {
  const p = preparation(input), { interview, candidate = {}, requirement = {} } = input;
  const attachments = input.reminderAttachments ?? selectReminderAttachments(input);
  const buttons = [
    ...(p.meetingUrl ? [actionButton('进入飞书会议', p.meetingUrl, true)] : []),
    ...(p.calendarUrl ? [actionButton('查看日程', p.calendarUrl, !p.meetingUrl)] : []),
  ];
  const elements = [
    block([
      md(`**${markdownText(p.when.time)}**`, { text_size: 'heading-1' }),
      md(`<font color='grey'>${markdownText(p.when.caption)} · ${markdownText(p.when.duration)}</font>`, { text_size: 'notation' }),
      md(`${p.basics.interviewPosition&&p.basics.interviewPosition!==p.basics.targetPosition?'本场岗位 · ':''}${markdownText(clip(p.basics.interviewPosition || '本场面试', 24))} · ${markdownText(clip(interview.round || '面试', 8))}`),
      ...(p.profile ? [md(`<font color='grey'>${markdownText(p.profile)}</font>`, { text_size: 'notation' })] : []),
      md(`<font color='grey'>最近工作</font>  ${markdownText(p.recentWork||'—')}`,{text_size:'notation'}),
    ], { background: 'turquoise-50' }),
    block([
      ...(p.brief?[md('**面试人简介**'),md(markdownText(p.brief),{text_size:'normal'})]:[]),
      ...(p.scoreSummary?[md(`**${markdownText(({sourcing_match:'岗位匹配',conversation_priority:'回复优先级',interview_report:'面试评分',resume_screen:'简历匹配'}[p.scoreSummary.kind||p.scoreSummary.scene]||p.scoreSummary.label||'已有评分'))} · ${p.scoreSummary.score}/100**`,{text_size:'notation'})]:[]),
      ...(p.matching.length?[md(`**匹配点**\n${p.matching.map(row=>`• ${markdownText(clip(row.text,120))}`).join('\n')}`,{text_size:'notation'})]:[]),
      md(`**这次重点聊**\n${p.focus.length?p.focus.map(markdownText).join(' · '):'岗位职责与过往经历'}`,{element_id:'interview_focus',text_size:'notation'}),
      ...preparationScoreRecord(p.scoreSummary,p.matching),
      ...fullCandidateProfile(p,input.candidateProfileAttachment),
    ], { background: 'grey-50' }),
    ...(buttons.length ? [{ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns: buttons.map(button => ({ tag: 'column', width: 'weighted', weight: 1, elements: [button] })) }] : []),
    ...(p.questions.length?[foldedPanel(`面试提纲 · ${p.questions.length}个问题`,p.questionViews.map(questionTile))]:[block([md('还没有准备面试问题',{element_id:'interview_questions_empty',text_size:'notation'})])]),
    ...(attachments.length ? [block([md('**附件简历**'),md(attachments.map(row=>`• ${markdownText(clip(row.name, 46))}`).join('\n')),md("<font color='grey'>原文件以独立文件消息提供。</font>", {text_size:'notation'})])] : []),
  ];
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', enable_forward: false, summary: { content: `${clip(p.basics.name || '候选人', 24)} · ${clip(p.basics.interviewPosition || '岗位', 30)} · ${p.when.time}` } },
    header: { title: { tag: 'plain_text', content: clip(interview.title || `${p.basics.name || '候选人'} · ${p.basics.interviewPosition || '岗位'}面试`, 42) }, subtitle: { tag: 'plain_text', content: input.test === true ? `样式预览 · ${p.reminderTime ? `正式提醒 ${p.reminderTime}` : '正式提醒仍按计划发送'}` : '云咩咩 · 面试手卡' }, template: 'turquoise', icon: { tag: 'standard_icon', token: 'hirelogo_colorful' } },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: '12px', elements },
  };
  try {validateInterviewReminderCard(card);} catch(error) {
    if(error.code==='invalid_reminder_card'&&!input.candidateProfileAttachment&&fullCandidateProfile(p).length) {
      try {buildInterviewReminderCard({...input,candidateProfileAttachment:{name:'完整候选人资料.txt'}});} catch(baseError) {throw baseError;}
      throw fail('完整候选人资料超出单张卡片限制，需以完整资料附件提供；未截断任何履历或职业原文。','candidate_profile_too_large',{attachmentRequired:true,profileBytes:Buffer.byteLength(completeCandidateText(p),'utf8')});
    }
    throw error;
  }
  return card;
}

export function validateInterviewReminderCard(card) {
  const elements = card?.body?.elements ?? [], nodes = elements.flatMap(row => cardNodes(row));
  const panels = elements.filter(row => row.tag === 'collapsible_panel');
  const blocks = elements.filter(row => row.tag === 'column_set');
  const text = JSON.stringify(card);
  const buttons = nodes.filter(row => row.tag === 'button');
  const visible = [card?.header?.title?.content, card?.header?.subtitle?.content, ...elements.flatMap(row => cardNodes(row, { folded: false })).map(row => row.content || row.text?.content)].filter(Boolean).map(plainCardText).join('');
  const validPanels = panels.length === 0?nodes.some(row=>row.element_id==='interview_questions_empty'):panels.length === 1 && panels.every(panel => panel.expanded === false && !cardNodes(panel).some(row => row.tag === 'form')) && /^面试提纲 · [1-9]\d*个问题$/.test(panels[0]?.header?.title?.content);
  const timeFocus = nodes.filter(row => row.text_size === 'heading-1');
  const questionTiles = panels[0]?.elements ?? [];
  const questionCharacters = questionTiles.map(tile => cardNodes(tile).map(row => plainCardText(row.content || '')).join('').length);
  const expandedCharacters = [card.header?.title?.content,card.header?.subtitle?.content,...nodes.map(row=>row.content || row.text?.content)].filter(Boolean).map(plainCardText).join('').length;
  if (card?.schema !== '2.0' || !card?.header?.title?.content || card?.header?.template !== 'turquoise' || card?.config?.width_mode !== 'default' || elements.length < 3 || elements.length > 5 || !validPanels || timeFocus.length !== 1 || !nodes.some(row=>row.element_id==='interview_focus') || questionTiles.length > 30 || questionTiles.some((row,index)=>row.tag!=='column_set'||row.element_id!==`interview_q${index+1}`)|| questionCharacters.some(count=>count>1400) || expandedCharacters>10000 || blocks.some(row => row.flex_mode !== 'none' || row.columns?.some(col => col.tag !== 'column' || col.width !== 'weighted'))) throw fail('面试卡片未通过信息层级与问题模块密度检查。', 'invalid_reminder_card');
  const visibleButtons = elements.flatMap(row => cardNodes(row, { folded: false })).filter(row => row.tag === 'button');
  if (visible.length > 800 || nodes.length > 200 || buttons.length > 2 || buttons.length !== visibleButtons.length || buttons.some((row, index) => row.type !== (index ? 'default' : 'primary_filled') || row.behaviors?.length !== 1 || row.behaviors[0].type !== 'open_url' || !safeFeishuMeetingUrl(row.behaviors[0].default_url)) || Buffer.byteLength(text, 'utf8') > 28000) throw fail('面试卡片未通过首屏密度、操作或大小检查。', 'invalid_reminder_card');
  return { valid: true, visibleCharacters: visible.length, expandedCharacters, questionCharacters, gates: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] };
}

export async function sendReminder(input = {}, options = {}) {
  const { connection, normalized } = botContext(input, options);
  if (input.interview?.eventId) assertCalendarConnection(input.interview, connection);
  const settings = input.settings ?? {};
  const recipientOpenId = input.recipientOpenId ?? settings.interviewAutomation?.reminderRecipientOpenId ?? settings.interviewAutomation?.recipientOpenId ?? settings.interviewAutomation?.ownerOpenId ?? settings.reminderRecipientOpenId;
  if (!/^ou_[A-Za-z0-9_-]{1,200}$/.test(recipientOpenId ?? '')) throw fail('面试私聊提醒需要已确认的本场面试官飞书 open_id。', 'invalid_recipient');
  const p=preparation(input);
  const verified=await prepareReminderAttachments(input,options.attachmentStorage);
  let candidateProfileAttachment;
  try {buildInterviewReminderCard({...input,reminderAttachments:verified.files});} catch(error) {
    if(error.code!=='candidate_profile_too_large')throw error;
    const bytes=Buffer.from(completeCandidateText(p),'utf8'),sha256=createHash('sha256').update(bytes).digest('hex');
    candidateProfileAttachment={name:'完整候选人资料.txt',sha256};
    verified.files.push({id:`candidate_profile_${sha256.slice(0,24)}`,purpose:'candidate_profile',name:candidateProfileAttachment.name,sha256,bytes});
  }
  const prepared = await stageReminderAttachments(verified, options.attachmentStorage);
  try {
  if(candidateProfileAttachment&&!prepared.files.some(row=>row.purpose==='candidate_profile'))throw fail('完整候选人资料附件未能生成，尚未发送卡片；原资料未被截断。','candidate_profile_attachment_failed',{definitelyNotSent:true});
  const card = buildInterviewReminderCard({...input,reminderAttachments:prepared.files.filter(row=>row.purpose!=='candidate_profile'),candidateProfileAttachment});
  const operationId = input.operationId || `interview-reminder:${input.interview.id}:${input.interview.revision ?? 1}:${input.interview.startAt}`;
  const key = `hrprep_${createHash('sha256').update(JSON.stringify([operationId, normalized, recipientOpenId])).digest('hex').slice(0, 40)}`;
  const data = await invoke(['im', '+messages-send', '--user-id', recipientOpenId, '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', key], input, options, true);
  const messageId = valueText(data?.message_id || data?.messageId || data?.message?.message_id);
  if (!messageId) throw fail('提醒请求已提交，但未返回消息 ID；未自动重试。', 'unknown_delivery');
  const attachmentReceipts=[...prepared.failures];
  for(const resume of prepared.files) {
    const attachmentKey=`hrcv_${createHash('sha256').update(JSON.stringify([operationId,normalized,recipientOpenId,resume.sha256])).digest('hex').slice(0,40)}`;
    try {
      const fileData=await invoke(['im','+messages-send','--user-id',recipientOpenId,'--file',resume.relativePath,'--idempotency-key',attachmentKey],input,{...options,commandOptions:{...options.commandOptions,cwd:options.attachmentStorage?.root||ROOT}},true);
      const fileMessageId=valueText(fileData?.message_id||fileData?.messageId||fileData?.message?.message_id);
      if(!fileMessageId)throw fail('附件未返回消息回执。','unknown_delivery');
      attachmentReceipts.push({...(resume.purpose==='candidate_profile'?{kind:'candidate_profile'}:{resumeId:resume.id}),name:resume.name,sha256:resume.sha256,status:'sent',messageId:fileMessageId,idempotencyKey:attachmentKey,recipientOpenId,feishuConnection:normalized});
    }catch(error){
      attachmentReceipts.push({...(resume.purpose==='candidate_profile'?{kind:'candidate_profile'}:{resumeId:resume.id}),name:resume.name,sha256:resume.sha256,status:'unknown_delivery',idempotencyKey:attachmentKey,recipientOpenId,feishuConnection:normalized,error:{code:error.code||'unknown_delivery',message:'附件发送结果待核验，未自动重发。'}});
    }
  }
  return { messageId, recipientOpenId, status: 'sent', idempotencyKey: key, feishuConnection: normalized, attachmentStatus:attachmentReceipts.length?attachmentReceipts.every(row=>row.status==='sent')?'sent':'partial':'none',attachmentReceipts };
  } finally { try { await prepared.cleanup(); } catch { /* A local cleanup issue must not erase a known remote receipt. */ } }
}

function exactEvent(data, eventId) {
  const event = data?.event ?? data;
  if (!event || valueText(event.event_id || event.eventId) !== eventId) throw fail('飞书未返回本场精确日程，未读取或加入其他会议。', 'calendar_event_mismatch');
  return event;
}

function calendarTimestamp(value) {
  if (typeof value?.datetime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.datetime)) return Date.parse(value.datetime);
  const raw = value?.timestamp;
  if (typeof raw !== 'string' && typeof raw !== 'number') return NaN;
  return /^\d{10}$/.test(String(raw)) ? Number(raw) * 1000 : NaN;
}

/** Read a user-visible calendar event. The returned binding records the read
 * identity separately from the bot identity that owns downstream delivery. */
export async function readExistingInterviewCalendar(interview, reference, { connection, runner = runLark } = {}) {
  const defaultUser = connection?.identity === 'user' && !connection.profile && !connection.appId && !connection.tenantKey;
  const configured = defaultUser ? undefined : connection;
  const readConnection = normalizeLarkConnection(configured);
  if (readConnection.identity !== 'user') throw fail('读取已有日程需要飞书用户身份。', 'identity_unsupported');
  const { calendarId, eventId } = reference;
  if (typeof calendarId !== 'string' || !/^[A-Za-z0-9_.@-]{1,300}$/.test(calendarId) || typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/.test(eventId)) throw fail('请提供已核对的飞书日历与日程 ID。', 'invalid_calendar_reference', { statusCode: 400 });
  let event;
  try {
    const result = await runner(larkArguments(['calendar', '+get', '--calendar-id', calendarId, '--event-id', eventId, '--format', 'json'], configured), { timeoutMs: 45000, write: false });
    if (result?.ok === false) throw fail(result.error?.message || '已有飞书日程无法读取。', result.error?.subtype || 'upstream_error');
    event = exactEvent(dataOf(result), eventId);
  } catch (error) { throw withLarkErrorContext(error, configured); }
  if (['cancelled', 'canceled', 'deleted'].includes(event.status)) throw fail('本场已有日程已取消。', 'calendar_event_cancelled');
  if (valueText(event.summary) !== interview.title || calendarTimestamp(event.start_time ?? event.start) !== Date.parse(interview.startAt) || calendarTimestamp(event.end_time ?? event.end) !== Date.parse(interview.endAt)) throw fail('飞书日程的主题或时间与工作台面试不一致。', 'calendar_event_mismatch', { statusCode: 409 });
  const calendarUrl = safeCalendarUrl(event.app_link || event.appLink);
  const meetingUrl = safeFeishuMeetingUrl(event.vchat?.meeting_url || event.meeting_url);
  const meetingNo = meetingNumberFromUrl(meetingUrl);
  const meetingId = valueText(event.vchat?.vc_info?.meeting_id);
  return {
    calendarId, eventId, calendarUrl, meetingUrl,
    metadataStatus: calendarUrl && meetingUrl ? 'complete' : 'partial',
    calendarBinding: { source: 'existing_event', readConnection, calendarId, eventId, meetingNo, ...(/^\d{10,25}$/.test(meetingId) ? { meetingId } : {}), meetingUrl, verifiedAt: new Date().toISOString() },
  };
}

export async function getCalendarMeeting(input = {}, options = {}) {
  const { connection, normalized } = botContext(input, options);
  const { interview, settings = {} } = input;
  if (!interview?.eventId) throw fail('自动入会需要本场已创建日程的 ID。', 'calendar_event_required');
  assertCalendarConnection(interview, connection);
  const calendarId = interview.calendarId || settings.calendarId;
  if (!calendarId) throw fail('自动入会需要本场日程的明确日历 ID。', 'not_configured');
  const binding = interview.calendarBinding;
  if (binding?.source === 'existing_event') {
    const meetingUrl = safeFeishuMeetingUrl(binding.meetingUrl);
    const meetingNo = meetingNumberFromUrl(meetingUrl);
    if (binding.calendarId !== calendarId || binding.eventId !== interview.eventId || binding.readConnection?.identity !== 'user' || !Number.isFinite(Date.parse(binding.verifiedAt)) || meetingNo !== binding.meetingNo) throw fail('已有日程的会议绑定与本场不一致。', 'calendar_event_mismatch');
    if (!meetingNo) return { status: 'not_started', reason: 'meeting_number_unavailable', meetingUrl, feishuConnection: normalized };
    return { status: 'joinable', started: false, meetingNo, meetingUrl, ...(binding.meetingId ? { meetingId: binding.meetingId } : {}), source: 'existing_calendar_event', feishuConnection: normalized };
  }
  const event = exactEvent(await invoke(['calendar', '+get', '--calendar-id', calendarId, '--event-id', interview.eventId], input, options), interview.eventId);
  if (['cancelled', 'canceled'].includes(event.status)) return { status: 'cancelled', feishuConnection: normalized };
  const meetingUrl = safeFeishuMeetingUrl(event.vchat?.meeting_url || event.meeting_url);
  const meetingNo = meetingNumberFromUrl(meetingUrl);
  // calendar +meeting currently only supports user. Never switch this bot to a
  // user or scan that user's active meetings. The exact Calendar URL is enough
  // for a join-only attempt; it does not prove the meeting has started.
  const meetingId = valueText(event.vchat?.vc_info?.meeting_id);
  if (!meetingNo) return { status: 'not_started', reason: 'meeting_number_unavailable', meetingUrl, feishuConnection: normalized };
  if (!meetingId) return { status: 'joinable', started: false, meetingNo, meetingUrl, source: 'calendar_event', feishuConnection: normalized };
  if (!/^\d{10,25}$/.test(meetingId)) throw fail('本场日程返回的会议 ID 格式无效。', 'invalid_meeting');
  // Additional room detail is optional and needs vc:meeting:readonly. The normal
  // join-only workflow does not request that extra scope or inspect participants.
  if (options.verifyMeetingStatus !== true) return { status: 'joinable', started: false, meetingId, meetingNo, meetingUrl, source: 'calendar_event', feishuConnection: normalized };
  const detail = await invoke(['vc', 'meeting', 'get', '--meeting-id', meetingId], input, options);
  const meeting = detail?.meeting;
  if (!meeting || String(meeting.id ?? '') !== meetingId || String(meeting.meeting_no ?? '') !== meetingNo) throw fail('会议详情与本场日程不匹配，未入会。', 'meeting_context_mismatch');
  const status = ({ 1: 'not_started', 2: 'active', 3: 'ended' })[meeting.status];
  if (!status) throw fail('会议状态无法确认，未据此入会。', 'unknown_meeting_status');
  return { status, started: status === 'active', meetingId, meetingNo, meetingUrl, source: 'calendar_event', feishuConnection: normalized };
}

function waitingStatus(value) {
  return ['waiting', 'waiting_room', 'awaiting_approval', 'pending_approval', 'pending', 'joining'].includes(String(value ?? '').toLowerCase());
}

export async function joinMeeting(input = {}, options = {}) {
  const { normalized } = botContext(input, options);
  const meetingNo = valueText(input.meetingNo), expectedId = valueText(input.meetingId);
  if (!/^\d{9}$/.test(meetingNo)) throw fail('自动入会需要本场日程返回的九位会议号。', 'invalid_meeting');
  if (expectedId && !/^\d{10,25}$/.test(expectedId)) throw fail('长会议 ID 格式无效。', 'invalid_meeting');
  let data;
  try {
    // Never --action start. A join request cannot initiate this meeting.
    data = await invoke(['vc', '+meeting-join', '--meeting-number', meetingNo, '--action', 'join'], input, options, true);
  } catch (error) {
    if (String(error.upstreamCode ?? '') === '121014') return { status: 'not_started', joined: false, meetingNo, feishuConnection: normalized };
    // 121003 has several causes (room/password/permissions), not proof of waiting.
    throw error;
  }
  const meeting = data?.meeting;
  const state = data?.join_status ?? data?.joinStatus ?? data?.status;
  if (waitingStatus(state) || waitingStatus(meeting?.join_status) || data?.awaiting_approval === true || data?.waiting_room === true) return { status: 'awaiting_approval', joined: false, meetingNo, ...(valueText(meeting?.id) ? { meetingId: valueText(meeting.id) } : {}), feishuConnection: normalized };
  const meetingId = valueText(meeting?.id ?? data?.meeting_id);
  const actualNo = valueText(meeting?.meeting_no ?? data?.meeting_no);
  if (!/^\d{10,25}$/.test(meetingId) || actualNo !== meetingNo || (expectedId && expectedId !== meetingId)) throw fail('入会请求已提交，但回执未确认本场会议；未标记为已入会或自动重试。', 'unknown_delivery');
  // Official SDK JoinBotRespData.join_user means the successfully joined bot:
  // https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/vc/v1/model.go
  // Meeting status=2 alone describes the room, never the bot's admission.
  const joinUser = data?.join_user;
  const joinedUserReceipt = !!valueText(joinUser?.id) && Number.isInteger(joinUser?.user_type);
  const joined = joinedUserReceipt || data?.joined === true || state === 'joined' || meeting?.join_status === 'joined';
  if (!joined || data?.joined === false) {
    // BotMeetingInfo does not define the room-status enum or require join_user.
    // A missing admission field can be confirmed by this exact app/user room
    // intersection; this reads only and never issues a second join request.
    try { return await confirmInterviewMeetingPresence({...input,meetingId,meetingNo},options); }
    catch { throw fail('入会回执和只读在会核验均未确认机器人已在会中；未自动重试入会。', 'unknown_delivery'); }
  }
  return { status: 'joined', joined: true, meetingId, meetingNo, ...(joinedUserReceipt ? { joinUser: { id: joinUser.id, userType: joinUser.user_type } } : {}), meetingUrl: safeFeishuMeetingUrl(meeting?.url), feishuConnection: normalized };
}

export function createFeishuInterviewBridge(options = {}) {
  return {
    sendReminder: input => sendReminder(input, options),
    getCalendarMeeting: input => getCalendarMeeting(input, options),
    joinMeeting: input => joinMeeting(input, options),
  };
}
