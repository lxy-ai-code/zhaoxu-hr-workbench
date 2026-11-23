import {runLark} from './lark-cli.mjs';
import {larkArguments,normalizeLarkConnection,sameLarkConnection} from './lark-context.mjs';

const longId=value=>typeof value==='string'&&/^\d{10,25}$/.test(value);
const moment=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const safeCode=value=>/^[A-Za-z0-9_.:-]{1,100}$/.test(String(value||''))?String(value):'report_meeting_read_failed';
const unknown=(reason,code,metadata={})=>({active:null,ended:false,reason,...metadata,...(code?{error:{code:safeCode(code),message:reason,...metadata}}:{})});
function context(input){
  const raw=input.connection??input.settings?.feishuConnection;
  const connection=normalizeLarkConnection(raw),interview=input.interview,joined=interview?.autoJoin,session=interview?.liveSession;
  if(!raw||connection.identity!=='bot'||!interview?.id||!interview.feishuConnection||!sameLarkConnection(interview.feishuConnection,connection))throw Object.assign(new Error(),{code:'report_meeting_context_unconfirmed'});
  if(input.connection&&input.settings?.feishuConnection&&!sameLarkConnection(input.connection,input.settings.feishuConnection))throw Object.assign(new Error(),{code:'connection_context_mismatch'});
  const source=joined?.meetingId?joined:session;
  if(!longId(source?.meetingId)||!source.feishuConnection||!sameLarkConnection(source.feishuConnection,connection))throw Object.assign(new Error(),{code:'report_meeting_context_unconfirmed'});
  if(joined?.meetingId&&session?.meetingId&&joined.meetingId!==session.meetingId)throw Object.assign(new Error(),{code:'meeting_context_mismatch'});
  if(session?.meetingId&&session.feishuConnection&&!sameLarkConnection(session.feishuConnection,connection))throw Object.assign(new Error(),{code:'connection_context_mismatch'});
  const meetingNo=typeof joined?.meetingNo==='string'&&/^\d{9}$/.test(joined.meetingNo)?joined.meetingNo:null;
  return {connection,interview,meetingId:source.meetingId,meetingNo};
}

/** Local evidence must identify the actual meeting; schedule-window completion
 * is deliberately excluded. A manual marker is accepted only when explicit. */
export function localReportEndEvidence(input={}) {
  let selected;try{selected=context(input);}catch{return null;}
  const {interview,connection,meetingId,meetingNo}=selected,capture=interview.liveCapture;
  if(moment(capture?.meetingEndedAt)&&capture.meetingId===meetingId&&sameLarkConnection(capture.feishuConnection,connection))return {active:false,ended:true,meetingId,meetingNo,source:'live_capture_end_event',verifiedAt:moment(capture.meetingEndedAt),feishuConnection:connection,reason:'本场明确会议结束事件已记录。'};
  if(interview.status==='completed'&&interview.completionSource==='manual'&&moment(interview.completedAt))return {active:false,ended:true,meetingId,meetingNo,source:'manual_interview_completion',verifiedAt:moment(interview.completedAt),feishuConnection:connection,reason:'本场已由人工明确标记结束。'};
  return null;
}

/** Read one exact meeting with the configured HR bot. Failure, empty receipts,
 * missing scopes and unknown status never imply the meeting has ended. */
export async function inspectReportMeetingEnd(input={}, {runner=runLark}={}) {
  let selected;try{selected=context(input);}catch(error){return unknown('本场会议或应用关联尚未确认。',error.code||'invalid_report_meeting_context');}
  const local=localReportEndEvidence(input);if(local)return local;
  const {connection,meetingId,meetingNo}=selected;
  try{
    const response=await runner(larkArguments(['vc','meeting','get','--meeting-id',meetingId,'--query-mode','0','--format','json'],connection),{timeoutMs:45000,write:false});
    if(response?.ok!==true){if(response?.error)throw {code:response.error.subtype||response.error.type||'report_meeting_read_unconfirmed',upstreamCode:response.error.code,missingScopes:response.error.missing_scopes};return unknown('飞书没有返回明确成功的会议详情。','report_meeting_read_unconfirmed');}
    const meeting=response.data?.meeting;
    if(!meeting||typeof meeting!=='object'||Array.isArray(meeting)||(meeting.id??meeting.meeting_id)!==meetingId||(meetingNo&&meeting.meeting_no!==meetingNo))return unknown('会议详情没有精确匹配本场会议。','meeting_context_mismatch');
    const status=meeting.status;
    if(![1,2,3].includes(status))return unknown('飞书会议状态暂不能确定。','report_meeting_status_unknown');
    return {active:status===2,ended:status===3,meetingId,meetingNo:meetingNo||meeting.meeting_no||null,source:'feishu_meeting_status',meetingStatus:status,verifiedAt:new Date().toISOString(),feishuConnection:connection,reason:status===3?'飞书已确认本场会议结束。':status===2?'飞书已确认本场会议仍在进行。':'飞书会议仍处于呼叫中。'};
  }catch(error){
    const missingScopes=Array.isArray(error?.missingScopes)?error.missingScopes.filter(scope=>typeof scope==='string'&&scope.length<=160&&/^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_.]*)+$/.test(scope)).slice(0,20):[];
    const metadata={...(missingScopes.length?{missingScopes}:{}),...(Number.isFinite(error?.upstreamCode)?{upstreamCode:error.upstreamCode}:{})};
    const permission=missingScopes.length||/scope|permission/i.test(String(error?.code||''));
    return unknown(permission?'读取会议状态所需权限尚未开通，会议结束状态未确认。':'暂未读取到明确会议状态，将继续等待。',error?.code||'report_meeting_read_failed',metadata);
  }
}
