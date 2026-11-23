import { runLark, LarkCliError } from './lark-cli.mjs';
import { larkArguments, normalizeLarkConnection, sameLarkConnection, withLarkErrorContext } from './lark-context.mjs';
import { assertCalendarConnection } from './feishu.mjs';

const fail=(message,code='presence_unconfirmed')=>new LarkCliError(message,{code,statusCode:409});

/** Reconcile an already attempted join using only the bot/user active intersection.
 * Never joins, starts, leaves, sends, or mutates local state. Empty is not absence.
 */
export async function confirmInterviewMeetingPresence(input={},options={}) {
  if(input.connection&&options.connection&&!sameLarkConnection(input.connection,options.connection))throw fail('核验连接不一致。','connection_context_mismatch');
  const rawConnection=input.connection??options.connection,connection=normalizeLarkConnection(rawConnection);
  if(!rawConnection||connection.identity!=='bot')throw fail('核验必须使用明确的 HR 应用身份。','identity_unsupported');
  const interview=input.interview,join=interview?.autoJoin;
  if(!interview?.id||!interview.eventId||interview.calendarStatus!=='synced')throw fail('本场尚无确认的飞书日程。','calendar_not_synced');
  assertCalendarConnection(interview,connection);
  if(!join?.operationId||!['unknown_delivery','joining','awaiting_approval','joined'].includes(join.status)||!join.feishuConnection||!sameLarkConnection(join.feishuConnection,connection))throw fail('没有属于当前应用的本场入会尝试可核验。','join_context_mismatch');
  const meetingNo=input.meetingNo??join.meetingNo,expectedId=input.meetingId??join.meetingId;
  if(!/^\d{9}$/.test(meetingNo??'')||meetingNo!==join.meetingNo)throw fail('核验会议号与原入会尝试不一致。','meeting_context_mismatch');
  if(expectedId!==undefined&&expectedId!==null&&expectedId!==''&&!/^\d{10,25}$/.test(expectedId))throw fail('原会议 ID 格式无效。','invalid_reference');
  const ownerOpenId=input.ownerOpenId??input.settings?.interviewAutomation?.meetingOwnerOpenId;
  if(!/^ou_[A-Za-z0-9]+$/.test(ownerOpenId??''))throw fail('请指定本场会议归属人的应用内身份。','owner_required');
  let response;
  try {
    response=await (options.runner??runLark)(larkArguments(['vc','+meeting-list-active','--user-id',ownerOpenId,'--format','json'],connection),{timeoutMs:45000,write:false});
  } catch(error) {throw withLarkErrorContext(error,connection);}
  if(response?.ok!==true)throw fail('飞书未确认本次只读核验。');
  const meetings=response.data?.meetings;
  if(!Array.isArray(meetings))throw fail('活跃会议返回结构无法确认，本场保持待核验。');
  const matches=meetings.filter(row=>row?.meeting_no===meetingNo);
  if(matches.length!==1||!/^\d{10,25}$/.test(matches[0]?.meeting_id??'')||(expectedId&&matches[0].meeting_id!==expectedId))throw fail('未找到唯一匹配的本人和机器人共同参会记录，本场保持待核验。');
  return {status:'joined',joined:true,meetingId:matches[0].meeting_id,meetingNo,verificationSource:'bot_user_active_meeting',verifiedAt:new Date().toISOString(),ownerOpenId,feishuConnection:connection};
}
