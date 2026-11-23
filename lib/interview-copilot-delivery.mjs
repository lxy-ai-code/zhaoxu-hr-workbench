import { runLark, LarkCliError } from './lark-cli.mjs';
import { larkArguments, normalizeLarkConnection, withLarkErrorContext } from './lark-context.mjs';
import { safeFeishuMeetingUrl } from './feishu-interviews.mjs';
import { digest } from './store.mjs';

const esc=value=>String(value??'').replace(/[&<>*~`\[\]()#_\\]/g,c=>`&#${c.charCodeAt(0)};`);
const md=(content,size='normal')=>({tag:'markdown',content,text_size:size});
const block=(elements,background='grey-50')=>({tag:'column_set',flex_mode:'none',columns:[{tag:'column',width:'weighted',weight:1,background_style:background,padding:'12px',vertical_spacing:'8px',elements}]});
const labels={opening:'开场对齐',evidence:'经历核验',deepening:'重点深入',candidate_questions:'候选人提问',closing:'收尾安排',unknown:'整体进度'};
/** Card 2.0; compact; turquoise header; one main advice, one supporting block.
 * lark-im-card-create P0–P7: 2–3 blocks, escaped source text, no callback/tool. */
export function buildCopilotCard({interview,requirement,decision,input}={}) {
  const suggestion=decision?.suggestions?.[0];
  if(!suggestion)throw Object.assign(new Error('没有值得发送的建议。'),{code:'no_suggestion'});
  const timestamps=(input?.segments||[]).map(row=>Date.parse(row.timestamp)).filter(Number.isFinite);
  const sourceTime=timestamps.length?new Date(Math.max(...timestamps)).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}):'时间未标注';
  const elements=[
    block([md(`**${esc(suggestion.title)}**`,'heading-3'),md(esc(suggestion.kind==='question'?suggestion.question:suggestion.nextStep))],'turquoise-50'),
    block([md(`**为什么现在看这个**\n${esc(suggestion.whyNow)}`),md(`<font color='grey'>${esc(labels[decision.stage]||labels.unknown)} · 根据截至 ${esc(sourceTime)} 已取得片段\n供面试官选择，不代表候选人结论。</font>`,'notation')]),
  ];
  const url=safeFeishuMeetingUrl(interview?.meetingUrl);
  if(url)elements.push({tag:'button',type:'primary_filled',width:'fill',text:{tag:'plain_text',content:'返回本场会议'},behaviors:[{type:'open_url',default_url:url}]});
  return {schema:'2.0',config:{update_multi:true,width_mode:'compact',enable_forward:false,summary:{content:`云咩咩 · ${suggestion.title}`}},header:{title:{tag:'plain_text',content:'云咩咩 · 面试辅助'},subtitle:{tag:'plain_text',content:String(interview?.title||`${requirement?.title||'本场面试'} · ${interview?.round||'面试'}`).slice(0,60)},template:'turquoise',icon:{tag:'standard_icon',token:'myai_colorful'}},body:{direction:'vertical',padding:'12px',vertical_spacing:'12px',elements}};
}
export async function sendCopilotCard(input,{runner=runLark}={}) {
  const connection=normalizeLarkConnection(input.connection);
  if(connection.identity!=='bot'||!connection.profile||!connection.appId||!/^ou_[A-Za-z0-9_-]{1,200}$/.test(input.recipientOpenId||''))throw new LarkCliError('辅助卡片需要当前应用和已确认的本场面试官接收人。',{code:'invalid_copilot_recipient'});
  const idempotencyKey=`hrlive_${digest(JSON.stringify([input.operationId,connection,input.recipientOpenId])).slice(0,40)}`;
  const card=buildCopilotCard(input);
  try {
    const result=await runner(larkArguments(['im','+messages-send','--user-id',input.recipientOpenId,'--msg-type','interactive','--content',JSON.stringify(card),'--idempotency-key',idempotencyKey,'--format','json'],connection),{write:true,timeoutMs:60000});
    const data=result?.data??result,messageId=data?.message_id||data?.message?.message_id;
    if(result?.ok===false||typeof messageId!=='string'||!messageId)throw new LarkCliError('辅助消息未取得送达回执，未自动重发。',{code:'unknown_delivery'});
    return {status:'sent',messageId,recipientOpenId:input.recipientOpenId,feishuConnection:connection,idempotencyKey};
  }catch(error){throw withLarkErrorContext(error,connection);}
}
