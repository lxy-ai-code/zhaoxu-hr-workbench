/** Current account's native BOSS job management, filtered to 开放中.
 * Reads a recent verified account-scoped cache first; otherwise calls the chat
 * page own native GET transport with the observed job-manager wire contract. No job edit/publish/close action is invoked.
 */
import { createHash, randomUUID } from 'node:crypto';
const JOB_PATH='/wapi/zpjob/job/data/list', MANAGER='/web/chat/job/list';
const busy=new Set();
const s=v=>typeof v==='string'?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):'';
const text=v=>typeof v==='string'?v:'';
const numeric=v=>/^\d+$/.test(s(v))&&!/^0+$/.test(s(v))?s(v):null;
const scope=v=>/^[1-9]\d*$/.test(s(v))?createHash('sha256').update(s(v)).digest('hex').slice(0,16):null;
function fail(status,message,meta={}){return {status,message,jobs:[],meta:{capturedAt:new Date().toISOString(),coverage:'unavailable',readOnly:true,...meta}}}
export function bossJobStatus(row){
  const a=row.jobAuditStatus,j=row.jobStatus;
  if(row.jobGiftExposureRights)return 'open';
  if(row.jobFreeProlongExposure)return 'open';
  if(a===6||(j===0&&a===0))return 'reviewing';
  if([0,2].includes(j)&&[0,1,3,4].includes(a))return 'open';
  if(a===2)return 'rejected';if(a===5)return 'expired';if(a===9)return 'employer_review';if(a===8)return 'edit_rejected';
  if(j===1)return 'closed';if(a===7)return 'edit_reviewing';if(j===3)return 'pending';
  return 'unknown';
}
function statusText(row,status){
  if(row.jobGiftExposureRights)return '免费曝光中';if(row.jobFreeProlongExposure)return '延长曝光中';
  return {open:'开放中',reviewing:'审核中',rejected:'审核不通过',expired:'已失效',employer_review:'待贵司审核',edit_rejected:'修改审核不通过',closed:'已关闭',edit_reviewing:'修改审核中',pending:'待开放',unknown:'待确认'}[status]??'待确认';
}
export function normalizeBossJobs(snapshot,{sourceAccountKey,capturedAt=new Date().toISOString()}={}){
  const key=scope(snapshot?.accountId),meta={accountKey:key,sourceAccountKey:key,capturedAt,coverage:'open_jobs_pages_read',readOnly:true,endpoint:JOB_PATH,filter:{type:5,label:'开放中',position:0,searchStr:'',comId:'',tagIdStr:''},pageSize:20,pagesRead:snapshot?.pagesRead??0,reportedTotal:snapshot?.totalSize??null,hasMore:snapshot?.hasMore??null,mechanism:snapshot?.mechanism??'page_native_get',wire:snapshot?.wire??null};
  if(!key)return fail('shape_changed','缺少可验证的当前 BOSS 账号，未导入职位。',meta);
  if(sourceAccountKey&&sourceAccountKey!==key)return fail('permission_denied','岗位来源账号与当前 BOSS 账号不一致。',meta);
  if(snapshot.businessCode!=null&&Number(snapshot.businessCode)!==0){const message=text(snapshot.businessMessage);return fail(/登录/.test(message)?'need_auth':/频繁/.test(message)||Number(snapshot.businessCode)===5003?'rate_limited':'permission_denied','平台未返回可读取的在招岗位，未把业务错误当成零职位。',{...meta,businessCode:snapshot.businessCode})}
  if(!Array.isArray(snapshot?.rows))return fail('shape_changed','原生职位列表结构变化，未把缺失列表当零职位。',meta);
  const numericByExternal=new Map();
  if(scope(snapshot.numericLookupAccountId)===key)for(const row of snapshot.numericLookup??[]){const id=text(row.encJobId);const value=numeric(row.value);if(id&&value)numericByExternal.set(id,value)}
  const unique=new Map();let rejectedCount=0;
  for(const row of snapshot.rows){const externalId=text(row.encryptJobId);if(!externalId||!text(row.jobName)){rejectedCount++;continue}const status=bossJobStatus(row);unique.set(externalId,{externalId,numericJobId:numeric(row.jobId)??numericByExternal.get(externalId)??null,title:row.jobName,city:text(row.city)||text(row.locationName),address:text(row.addressShowText),salaryRange:text(row.salaryDesc),status,statusText:statusText(row,status),jobStatus:Number.isInteger(row.jobStatus)?row.jobStatus:null,jobAuditStatus:Number.isInteger(row.jobAuditStatus)?row.jobAuditStatus:null,source:'boss',sourceAccountKey:key,capturedAt,jd:'',jdCoverage:'not_returned_in_job_list',sourceLabel:'BOSS 职位管理·开放中'});}
  const jobs=[...unique.values()],reported=Number.isSafeInteger(meta.reportedTotal)&&meta.reportedTotal>=0?meta.reportedTotal:null;
  const duplicateCount=snapshot.rows.length-rejectedCount-jobs.length;
  const complete=snapshot.hasMore===false&&reported!==null&&jobs.length===reported&&rejectedCount===0&&duplicateCount===0&&!snapshot.capped&&!snapshot.interrupted;
  Object.assign(meta,{capturedCount:jobs.length,loadedCount:jobs.length,rejectedCount,duplicateCount,capped:!!snapshot.capped,complete,completeAsReported:complete,completenessBasis:'platform_totalSize_and_hasMore_for_open_filter',coverage:complete?'all_open_jobs_as_reported':'open_jobs_pages_read'});
  return {status:complete?'ok':'partial',message:complete?`已读取平台报告的 ${jobs.length} 个开放中岗位。`:`已读取 ${jobs.length} 个开放中岗位；分页或完整性尚未确认。`,jobs,meta};
}
class Cdp{
  constructor(ws){this.ws=ws;this.n=0;this.pending=new Map();this.handlers=new Map();ws.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.method){for(const h of this.handlers.get(m.method)??[])h(m.params);return}const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error('CDP failed')):p.resolve(m.result)}});ws.addEventListener('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP disconnected'))}this.pending.clear()})}
  static async open(target,port){const u=new URL(target.webSocketDebuggerUrl);if(u.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.port!==String(port))throw new Error('Invalid CDP');const ws=new WebSocket(u);await new Promise((resolve,reject)=>{const t=setTimeout(()=>{ws.close();reject(new Error('CDP timeout'))},4000);ws.addEventListener('open',()=>{clearTimeout(t);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(t);reject(new Error('CDP unavailable'))},{once:true})});return new Cdp(ws)}
  on(m,f){this.handlers.set(m,[...(this.handlers.get(m)??[]),f])}
  send(method,params={}){const n=++this.n;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(n);reject(new Error('CDP timeout'))},12000);this.pending.set(n,{resolve,reject,timer});this.ws.send(JSON.stringify({id:n,method,params}))})}
  close(){this.ws.close()}
}
async function properties(ctx,objectId){return ctx.c.send('Runtime.getProperties',{objectId,ownProperties:true})}
async function scoped(ctx,fn,name){const p=await properties(ctx,fn.objectId),id=p.internalProperties?.find(r=>r.name==='[[Scopes]]')?.value?.objectId;if(!id)return null;for(const row of(await properties(ctx,id)).result.filter(r=>r.value?.objectId&&r.value.description!=='Global')){const v=(await properties(ctx,row.value.objectId)).result.find(r=>r.name===name)?.value;if(v)return v}return null}
async function numericLookup(ctx){try{const f=(await ctx.c.send('Runtime.evaluate',{expression:'window.iBossRoot.chat.updateChatList',objectGroup:ctx.group,returnByValue:false})).result;const store=await scoped(ctx,f,'C3');if(!store)return null;const r=await ctx.c.send('Runtime.callFunctionOn',{objectId:store.objectId,functionDeclaration:'function(){return JSON.stringify({accountId:window._PAGE?.uid,rows:this.jobList.map(r=>({encJobId:r.encJobId,value:r.value}))})}',returnByValue:true,objectGroup:ctx.group});return JSON.parse(r.result.value)}catch{return null}}
async function readOpenJobs(){
  const rows=[];let totalSize=null,hasMore=null,pagesRead=0,capped=false;
  for(let page=1;page<=10;page++){
    const response=await this("/wapi/zpjob/job/data/list",{position:0,type:5,searchStr:"",comId:"",tagIdStr:"",page});pagesRead++;
    if(Number(response?.code)!==0)return JSON.stringify({accountId:window._PAGE?.uid,businessCode:response?.code??-1,businessMessage:response?.message});
    const z=response.zpData;if(!z||!Array.isArray(z.data))return JSON.stringify({failure:"shape_changed",message:"原生岗位响应缺少职位行。"});
    for(const r of z.data)rows.push(Object.fromEntries(["encryptJobId","jobId","jobName","city","locationName","addressShowText","salaryDesc","jobStatus","jobAuditStatus","jobGiftExposureRights","jobFreeProlongExposure"].filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])));
    totalSize=z.totalSize;hasMore=z.hasMore;
    if(hasMore===false)break;if(hasMore!==true)return JSON.stringify({accountId:window._PAGE?.uid,rows,totalSize,hasMore,pagesRead,interrupted:true});
    if(page===10)capped=true;
  }
  return JSON.stringify({accountId:window._PAGE?.uid,businessCode:0,rows,totalSize,hasMore,pagesRead,capped,mechanism:"same_page_native_get"});
}
const verifiedCache=new Map();
export async function getBossJobs({port=19222,sourceAccountKey,refresh=false}={}){
  if(!Number.isInteger(port)||port<1024||port>65535||port>=9222&&port<=9266)return fail("error","只允许使用 HR 独立 CDP 19222。");
  if(busy.has(port))return fail("error","岗位列表正在读取，请稍后重试。");busy.add(port);let ctx;
  try{
    const response=await fetch("http://127.0.0.1:"+port+"/json/list",{signal:AbortSignal.timeout(3500)});const tabs=(await response.json()).filter(t=>{try{return t.type==="page"&&new URL(t.url).origin==="https://www.zhipin.com"}catch{return false}});
    const chat=tabs.filter(t=>/^\/web\/chat\/(?:index)?\/?$/.test(new URL(t.url).pathname));const choices=chat.length?chat:tabs.filter(t=>new URL(t.url).pathname===MANAGER);
    if(choices.length!==1)return fail("read_only_unavailable","请保留一个已登录的BOSS沟通页或职位管理页；读取不会另开主标签。");
    ctx={c:await Cdp.open(choices[0],port),group:"hr-jobs-"+randomUUID()};
    const state=await ctx.c.send("Runtime.evaluate",{expression:"JSON.stringify({accountId:window._PAGE?.uid,ready:!!window.iBossRoot?.chat})",returnByValue:true});const p=JSON.parse(state.result.value);const key=scope(p.accountId);
    if(!key||!p.ready)return fail("need_auth","请检查BOSS原页面登录状态。");
    if(sourceAccountKey&&sourceAccountKey!==key)return fail("permission_denied","当前BOSS账号与岗位来源不一致。",{accountKey:key});
    const existing=verifiedCache.get(key);
    if(!refresh&&existing&&Date.now()-existing.at<30000){const cached=normalizeBossJobs({...existing.snapshot,mechanism:"verified_account_cache"},{sourceAccountKey,capturedAt:existing.capturedAt});Object.assign(cached.meta,{cacheHit:true,cacheAgeMs:Date.now()-existing.at});return cached;}
    const wrapper=(await ctx.c.send("Runtime.evaluate",{expression:"window.iBossRoot.chat.updateChatList",objectGroup:ctx.group,returnByValue:false})).result;
    const nativeGet=await scoped(ctx,wrapper,"Q");
    if(nativeGet?.type!=="function"||!nativeGet.description?.includes(".get("))return fail("shape_changed","未识别到已验证的同页原生GET客户端。");
    const wire={requestCount:0,methods:[],statuses:[]},ids=new Set();ctx.c.on("Network.requestWillBeSent",e=>{try{const u=new URL(e.request.url);if(u.origin==="https://www.zhipin.com"&&u.pathname===JOB_PATH){wire.requestCount++;wire.methods.push(e.request.method);wire.parameterKeys=[...u.searchParams.keys()];ids.add(e.requestId)}}catch{}});ctx.c.on("Network.responseReceived",e=>{if(ids.has(e.requestId))wire.statuses.push(e.response.status)});await ctx.c.send("Network.enable");
    const result=await ctx.c.send("Runtime.callFunctionOn",{objectId:nativeGet.objectId,functionDeclaration:readOpenJobs.toString(),returnByValue:true,awaitPromise:true,objectGroup:ctx.group});
    if(result.exceptionDetails||typeof result.result?.value!=="string")return fail("error","同页原生在招岗位查询未完成。",{accountKey:key});
    const snapshot=JSON.parse(result.result.value);if(snapshot.failure)return fail(snapshot.failure,snapshot.message,{accountKey:key});
    const lookup=await numericLookup(ctx);snapshot.numericLookup=lookup?.rows;snapshot.numericLookupAccountId=lookup?.accountId;snapshot.wire=wire;
    if(Number(snapshot.businessCode)===0&&(wire.requestCount!==snapshot.pagesRead||wire.methods.some(v=>v!=="GET")||wire.statuses.length!==snapshot.pagesRead||wire.statuses.some(v=>v!==200)))return fail("shape_changed","同页原生在招列表请求与已验证管理页面契约不一致。",{accountKey:key,wire});
    const normalized=normalizeBossJobs(snapshot,{sourceAccountKey});
    if(normalized.status==="ok")verifiedCache.set(key,{at:Date.now(),snapshot,capturedAt:normalized.meta.capturedAt});
    return normalized;
  }catch{return fail("error","无法读取BOSS在招岗位，请检查独立CDP19222与页面状态。")}
  finally{if(ctx){await ctx.c.send("Runtime.releaseObjectGroup",{objectGroup:ctx.group}).catch(()=>{});ctx.c.close()}busy.delete(port)}
}
