/** Native, already-authorized BOSS attachment downloads. No resume request,
 * exchange, openChat, anonymous resume view, credit use or PDF reconstruction.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_ROOT } from './runtime-config.mjs';
import { createHash, randomUUID } from 'node:crypto';

const DATA = path.join(WORKSPACE_ROOT, 'data');
const ROOTS = [path.join(DATA, 'resumes'), path.join(DATA, 'imports/resume-validation')];
const CHECK_PATH = '/wapi/zpgeek/resume/boss/preview/check.json';
const LIMIT = 20 * 1024 * 1024;
const busy = new Set();
const scalar = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
const sha = value => createHash('sha256').update(value).digest('hex');
const failure = (status, message, meta = {}) => ({ status, message, items: [], meta: { capturedAt: new Date().toISOString(), source: 'BOSS 原生已授权附件下载链', coverage: 'one_selected_candidate', ...meta } });
const attachmentCheck = raw => Object.fromEntries(['isResumeVisible','isCanPreview','isOnline','expired','previewType'].filter(key=>raw?.zpData?.[key]!==undefined).map(key=>[key,raw.zpData[key]]));

export function classifyAttachmentCheck(input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'code')) return { status: 'error', message: '附件权限响应结构已变化，未将缺失数据当作已授权。' };
  const message = String(input.message ?? '');
  if (/未登录|请.*登录|登录.*过期|登录.*失效/.test(message)) return { status: 'need_auth', message: 'BOSS 登录状态不可用，请在独立 BOSS 窗口中手动登录。' };
  if (Number(input.code) !== 0) return { status: 'permission_denied', message: 'BOSS 未授予该附件访问权限，未自动申请或重复请求。' };
  const detail = input.zpData;
  if (!detail || typeof detail !== 'object') return { status: 'error', message: '附件检查缺少可验证的权限详情。' };
  if (detail.expired === true || detail.expired === 1) return { status: 'requires_review', message: '平台标记附件简历已过期；需人工处理，工作台不会自动发送新的简历申请。' };
  if (detail.isOnline === true || detail.isOnline === 1) return { status: 'not_available', message: '当前返回的是在线简历状态，未将网页资料冒充为平台附件。' };
  if (detail.isResumeVisible === false || detail.isResumeVisible === 0) return { status: 'not_available', message: '当前账号尚未获得该候选人的可下载附件，不能据此判断对方是否已上传。可上传已有简历，或在 BOSS 中沟通获取附件。' };
  if (!(detail.isResumeVisible === true || detail.isResumeVisible === 1)) return { status: 'error', message: '附件检查未返回明确的可见状态，未将缺失字段当作没有附件。' };
  // The native UI offers download when the attachment is visible but cannot
  // be previewed. Preview support is independent of the download grant.
  if (!detail.d || typeof detail.d !== 'string') return { status: 'error', message: '平台未返回有效的原生下载凭据，未拼造文件地址。' };
  return { status: 'ok', message: '平台确认附件已获授权。' };
}

export function inspectResumeBytes(value, mimeType = '') {
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > LIMIT) throw new Error('简历文件为空或超过 20 MB 上限。');
  const prefix = bytes.subarray(0, 256).toString('utf8').trimStart();
  if (prefix.startsWith('{')) {
    try {
      const result=JSON.parse(bytes.toString('utf8'));
      if(Object.hasOwn(result,'code')&&Number(result.code)!==0){
        const message=String(result.message??'');
        const status=/登录|login/i.test(message)?'need_auth':/风控|频繁|安全验证|验证码/.test(message)?'requires_review':'permission_denied';
        throw Object.assign(new Error('平台原生文件接口返回业务拒绝，未取得简历文件。'),{code:'resume_business_error',businessCode:Number.isFinite(Number(result.code))?Number(result.code):null,status});
      }
    } catch(error) { if(error.code==='resume_business_error')throw error; }
  }
  if (/^(?:<!doctype|<html|\{\s*"(?:code|error|message)")/i.test(prefix)) throw new Error('下载响应是页面或业务错误，不是简历文件。');
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-' && bytes.subarray(-4096).includes(Buffer.from('%%EOF'))) return { extension: '.pdf', mimeType: 'application/pdf', kind: 'pdf' };
  if (bytes.subarray(0, 2).toString('ascii') === 'PK') {
    if (!bytes.includes(Buffer.from('word/document.xml')) || !bytes.includes(Buffer.from('[Content_Types].xml')) || !bytes.subarray(-66000).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) throw new Error('ZIP 响应不符合 DOCX 简历文件结构。');
    return { extension: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' };
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) return { extension: '.doc', mimeType: 'application/msword', kind: 'doc' };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { extension: '.png', mimeType: 'image/png', kind: 'image' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return { extension: '.jpg', mimeType: 'image/jpeg', kind: 'image' };
  throw new Error(`平台返回的文件格式暂不支持${mimeType ? `（${String(mimeType).split(';')[0]}）` : ''}，未保存为伪造的 PDF。`);
}
export function safeResumeFilename(value, extension = '.pdf') {
  let stem = String(value || 'BOSS附件简历').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  stem = stem.replace(/\.(?:pdf|docx?|png|jpe?g)$/i, '');
  if (!stem || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem)) stem = `简历_${stem || 'file'}`;
  return `${stem}${extension}`;
}
export function resolveResumeOutput(directory = ROOTS[0]) {
  const resolved = path.resolve(directory);
  if (!ROOTS.some(root => resolved === root || resolved.startsWith(root + path.sep))) throw new Error('简历只能归档在工作台 data/resumes 或 data/imports/resume-validation 下。');
  return resolved;
}
export async function saveNativeResume(bytes, { outputDirectory, name, kind = 'attachment', mimeType } = {}) {
  const directory = resolveResumeOutput(outputDirectory);
  // Reject links/junctions before mkdir; a lexical path alone is insufficient.
  for (let current = directory; current !== path.dirname(DATA) && current.startsWith(DATA); current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('归档路径含链接或目录联接，无法确认安全归属。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(directory, { recursive: true });
  const real = await fs.realpath(directory);
  const realData = await fs.realpath(DATA);
  const roots = ROOTS.map(root => path.join(realData, path.relative(DATA, root)));
  if (!roots.some(root => real === root || real.startsWith(root + path.sep))) throw new Error('输出目录解析到了归档范围之外。');
  const format = inspectResumeBytes(bytes, mimeType), hash = sha(bytes);
  const original = safeResumeFilename(name, format.extension);
  const filename = `${path.basename(original, format.extension)}--${hash.slice(0, 16)}${format.extension}`;
  const destination = path.join(real, filename);
  try { await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || sha(await fs.readFile(destination)) !== hash) throw error; }
  return { path: destination, name: filename, mimeType: format.mimeType, size: bytes.length, sha256: hash, kind };
}

class Cdp {
  constructor(ws) { this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return}const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error('CDP command failed')):p.resolve(m.result)}});ws.addEventListener('close',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP disconnected'))}this.pending.clear()}); }
  static async open(target,port) { const url=new URL(target.webSocketDebuggerUrl);if(url.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.port!==String(port))throw new Error('Invalid CDP address');const ws=new WebSocket(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('CDP timeout'))},4000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP unavailable'))},{once:true})});return new Cdp(ws); }
  send(method,params={}) {const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout'))},25000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}))});}
  close(){this.ws.close()}
}
async function props(c,id,ownProperties=true){return c.send('Runtime.getProperties',{objectId:id,ownProperties})}
async function scope(c,fn,name){const p=await props(c,fn);const id=p.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value?.objectId;if(!id)return null;const entries=await props(c,id);for(const e of entries.result.filter(p=>p.value?.objectId&&p.value.description!=='Global')){const p=await props(c,e.value.objectId);const v=p.result.find(p=>p.name===name)?.value;if(v)return v}return null}
async function context(port,expectedScope){
  if(!Number.isInteger(port)||port<1024||port>65535||(port>=9222&&port<=9266))throw new Error('请使用 HR 独立 CDP 19222，不得连接店铺端口池。');
  const res=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(3500)});const list=await res.json();const matches=list.filter(t=>{try{return t.type==='page'&&new URL(t.url).hostname==='www.zhipin.com'&&/^\/web\/chat\/(?:index)?\/?$/.test(new URL(t.url).pathname)}catch{return false}});
  if(matches.length!==1)throw new Error('请在 HR 独立浏览器保留一个已登录 BOSS 沟通页。');
  const c=await Cdp.open(matches[0],port);const group=`hr-resumes-${randomUUID()}`;
  try {const r=await c.send('Runtime.evaluate',{expression:'JSON.stringify({id:window._PAGE?.uid,ready:!!window.iBossRoot?.chat})',returnByValue:true});const identity=JSON.parse(r.result.value);const id=scalar(identity.id);if(!/^[1-9][0-9]*$/.test(id)||!identity.ready)throw Object.assign(new Error('BOSS 需要手工登录。'),{status:'need_auth'});const accountKey=sha(id).slice(0,16);if(expectedScope&&accountKey!==expectedScope)throw Object.assign(new Error('BOSS 当前账号与档案来源账号不一致。'),{status:'permission_denied'});return {c,group,accountId:id,accountKey};}catch(error){c.close();throw error}
}
async function storeFor(ctx){const {c,group}=ctx;const f=(await c.send('Runtime.evaluate',{expression:'window.iBossRoot.chat.updateChatList',objectGroup:group,returnByValue:false})).result;const name=f.description?.match(/([A-Za-z_$][0-9A-Za-z_$]*)[.]updateChatList/)?.[1];const bridge=await scope(c,f.objectId,name);if(!bridge)return null;const p=await props(c,bridge.objectId,false);const getter=p.result.find(p=>p.name==='getFriendByUniqueId')?.value;const d=await scope(c,getter.objectId,getter.description.match(/([A-Za-z_$][0-9A-Za-z_$]*)[.]getFriendByUniqueId/)[1]);const dp=await props(c,d.objectId,false);const unread=dp.result.find(p=>p.name==='getUnreadGeek')?.value;const index=await scope(c,unread.objectId,unread.description.match(/return\s+([A-Za-z_$][0-9A-Za-z_$]*)[.]map/)[1]);return {store:d,index};}
async function previewClient(ctx){
  const {c,group}=ctx;const f=(await c.send('Runtime.evaluate',{expression:'window.iBossRoot.resume.attatchResumeViewer',objectGroup:group,returnByValue:false})).result;
  const info=await props(c,f.objectId);const id=info.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value?.objectId;if(!id)return null;const scopes=await props(c,id);
  for(const entry of scopes.result.filter(p=>p.value?.objectId&&p.value.description!=='Global')){
    const vars=await props(c,entry.value.objectId);
    for(const candidate of vars.result.filter(p=>p.value?.type==='object'&&p.value.objectId&&p.value.subtype!=='null')){
      const r=await c.send('Runtime.callFunctionOn',{objectId:candidate.value.objectId,functionDeclaration:'function(){const root=this.A?.options??this.A;if(!root||root.name!=="resume-viewer")return null;const v=root.components?.NewResumeOnline?.options??root.components?.NewResumeOnline;const a=v?.components?.AttachmentResume?.options??v?.components?.AttachmentResume;return a?.methods?.getResumeDetail??null}',returnByValue:false,objectGroup:group});
      if(r.result?.type!=='function')continue;
      const helperName=r.result.description.match(/([A-Za-z_$][0-9A-Za-z_$]*)[.]if/)?.[1];if(!helperName)continue;
      const api=await scope(c,r.result.objectId,helperName);if(!api)continue;
      const fn=await c.send('Runtime.callFunctionOn',{objectId:api.objectId,functionDeclaration:'function(){return this.if}',returnByValue:false,objectGroup:group});
      if(fn.result?.type==='function'&&fn.result.description.includes(CHECK_PATH))return fn.result;
    }
  }return null;
}
async function attachmentOperation(checker,index,selectors,download,expectedAccountId){
  if(String(window._PAGE?.uid)!==expectedAccountId)return JSON.stringify({status:'permission_denied',message:'账号发生变化。'});
  const rows=index.slice(0,1200).map(id=>this.getFriendByUniqueId(id)).filter(Boolean);
  const matches=rows.filter(row=>(!selectors.conversationId||String(row.uniqueId)===selectors.conversationId)&&(!selectors.peerId||String(row.friendId)===selectors.peerId)&&(!selectors.candidateExternalId||row.encryptUid===selectors.candidateExternalId));
  if(matches.length!==1)return JSON.stringify({status:'requires_review',message:'未能从当前账号已加载会话中唯一匹配此候选人。'});
  const row=matches[0];if(!row.encryptUid)return JSON.stringify({status:'permission_denied',message:'缺少本账号可用的候选人标识。'});
  if(row.friendSource===1)return JSON.stringify({status:'requires_review',message:'此来源采用不同附件链，当前未验证，未尝试下载或申请。'});
  if(selectors.resumeId&&selectors.resumeId!=='latest')return JSON.stringify({status:'permission_denied',message:'未验证此附件版本的归属；请使用平台当前已授权附件。'});
  const beforeUnread=this.getUnreadCount();const response=await checker({geekId:row.encryptUid});const afterUnread=this.getUnreadCount();
  const detail=response?.zpData;
  const identity={conversationId:String(row.uniqueId),peerId:String(row.friendId),candidateExternalId:row.encryptUid};
  const result={code:response?.code,message:response?.message,zpData:detail?{isResumeVisible:detail.isResumeVisible,isCanPreview:detail.isCanPreview,isOnline:detail.isOnline,expired:detail.expired,d:detail.d?'[present]':null,previewType:detail.previewType}:null,identity,beforeUnread,afterUnread};
  if(!download||Number(response?.code)!==0||!detail||!(detail.isResumeVisible===true||detail.isResumeVisible===1)||detail.expired||detail.isOnline||!detail.d)return JSON.stringify(result);
  // Keep the native grant representation: the UI's URL encoding coerces it;
  // do not decode, rebuild, or reject a value merely for not being a string.
  const query=new URLSearchParams({d:detail.d});
  const url='https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/'+encodeURIComponent(row.encryptUid)+'?'+query;
  // Native anchor downloads use the browser's existing login context. Return
  // this ephemeral grant only to the private CDP driver, never public metadata.
  return JSON.stringify({...result,nativeDownloadUrl:url});
}
function selected(input){const v={conversationId:scalar(input.conversationId),peerId:scalar(input.peerId),candidateExternalId:scalar(input.candidateExternalId),resumeId:scalar(input.resumeId)};return v.conversationId||v.peerId||v.candidateExternalId?v:null;}
async function browserDownload(ctx,url){
  const parsed=new URL(url);if(parsed.origin!=='https://docdownload.zhipin.com'||!parsed.pathname.startsWith('/wflow/zpgeek/download/download4boss/'))throw Object.assign(new Error('Unexpected native file source'),{code:'download_source_blocked'});
  const tree=await ctx.c.send('Page.getFrameTree');
  const {resource}=await ctx.c.send('Network.loadNetworkResource',{frameId:tree.frameTree.frame.id,url,options:{disableCache:false,includeCredentials:true}});
  if(!resource?.success||!resource.stream)throw Object.assign(new Error('Native browser file download failed'),{code:'download_http_error',httpStatus:resource?.httpStatusCode});
  const chunks=[];let size=0;
  try {for(;;){const part=await ctx.c.send('IO.read',{handle:resource.stream,size:65536});const bytes=Buffer.from(part.data,part.base64Encoded?'base64':'utf8');size+=bytes.length;if(size>LIMIT)throw Object.assign(new Error('File too large'),{code:'file_too_large'});chunks.push(bytes);if(part.eof)break;}}
  finally {await ctx.c.send('IO.close',{handle:resource.stream}).catch(()=>{});}
  const headers=Object.fromEntries(Object.entries(resource.headers??{}).map(([k,v])=>[k.toLowerCase(),v]));
  return {bytes:Buffer.concat(chunks),mimeType:headers['content-type']??'',name:filenameFromDisposition(headers['content-disposition']),transport:'browser_native_resource_with_existing_login'};
}
async function operation(input,download){let ctx;try{const selectors=selected(input);if(!selectors)return failure('requires_review','请先选择具体候选人档案，不能按姓名或默认第一位下载。');ctx=await context(input.port??19222,input.sourceAccountKey);const store=await storeFor(ctx),checker=await previewClient(ctx);if(!store||!checker)return failure('error','未找到已验证的原生附件客户端，未猜测接口或申请简历。',{accountKey:ctx.accountKey});const result=await ctx.c.send('Runtime.callFunctionOn',{objectId:store.store.objectId,functionDeclaration:attachmentOperation.toString(),arguments:[{objectId:checker.objectId},{objectId:store.index.objectId},{value:selectors},{value:download},{value:ctx.accountId}],returnByValue:true,awaitPromise:true,objectGroup:ctx.group});if(result.exceptionDetails||typeof result.result?.value!=='string')return failure('error','原生附件查询失败，未下载简历。',{accountKey:ctx.accountKey});const raw=JSON.parse(result.result.value);const meta={accountKey:ctx.accountKey,sourceIdentity:raw.identity,source:'BOSS 原生附件权限检查及文件下载',coverage:'latest_authorized_attachment_only',unreadStateUnchanged:raw.beforeUnread===raw.afterUnread,capturedAt:new Date().toISOString(),endpoint:CHECK_PATH};if(raw.status)return failure(raw.status,raw.message,meta);if(download&&raw.nativeDownloadUrl){try{raw.downloaded=await browserDownload(ctx,raw.nativeDownloadUrl);meta.transport=raw.downloaded.transport;}catch(error){return failure(error.httpStatus===401?"need_auth":error.httpStatus===403?"permission_denied":"error","原生附件传输失败，未记为下载成功。",{...meta,diagnostics:{stage:"browser_download",errorCode:error.code??"download_failed",httpStatus:error.httpStatus??null}})}finally{delete raw.nativeDownloadUrl;}}return {raw,meta};}catch(error){return failure(error.status??'error',error.status?error.message:'无法连接独立 BOSS 浏览器或读取附件。请检查 HR CDP 19222 与登录状态。');}finally{if(ctx){await ctx.c.send('Runtime.releaseObjectGroup',{objectGroup:ctx.group}).catch(()=>{});ctx.c.close()}}}

export async function getBossResumeAvailability(input={}) {
  const result=await operation(input,false);if(!result.raw)return result;const verdict=classifyAttachmentCheck(result.raw);
  return {status:verdict.status,message:verdict.message,items:[{id:'latest',kind:'attachment',name:'BOSS 当前已授权附件简历',available:verdict.status==='ok',source:'平台原生附件权限检查'}],meta:{...result.meta,attachmentCheck:attachmentCheck(result.raw)}};
}
function filenameFromDisposition(value){const encoded=value?.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];if(encoded){try{return decodeURIComponent(encoded.replace(/^"|"$/g,''))}catch{}}return value?.match(/filename="?([^";]+)"?/i)?.[1]??'BOSS附件简历';}
export async function downloadBossResume(input={}) {
  if(input.kind&&input.kind!=='attachment')return failure('not_available','在线简历功能已移除，当前只支持下载已获授权的简历附件。');
  try{resolveResumeOutput(input.outputDirectory);}catch(error){return failure('error',error.message)}
  const port=input.port??19222;if(busy.has(port))return failure('error','另一份简历正在下载，请稍后重试。');busy.add(port);
  let result, downloaded, stage='permission_check';
  try{result=await operation(input,true);if(!result.raw)return result;const verdict=classifyAttachmentCheck(result.raw);if(verdict.status!=='ok')return failure(verdict.status,verdict.message,{...result.meta,attachmentCheck:attachmentCheck(result.raw)});stage='download_bytes';
    if(result.raw.downloaded)downloaded=result.raw.downloaded;
    else return failure('error','附件已获授权，但未取得有效文件字节，未记为下载成功。',result.meta);
    stage='validate_and_save';
    const file=await saveNativeResume(downloaded.bytes,{outputDirectory:input.outputDirectory,name:downloaded.name,mimeType:downloaded.mimeType,kind:'attachment'});
    return {status:'ok',message:'已取得并校验 BOSS 原生附件简历，文件保留平台原字节。',file,meta:{...result.meta,coverage:'native_original_attachment_bytes',nativeBytesPreserved:true,noRequestSent:true,noCreditAction:true}};
  }catch(error){const diagnostics={stage,errorCode:error.code??'download_validation_failed',...(error.httpStatus?{httpStatus:error.httpStatus}:{}),...(error.businessCode!=null?{businessCode:error.businessCode}:{}),...(downloaded?{byteLength:downloaded.bytes.length,responseMimeType:String(downloaded.mimeType).split(';')[0],magic:downloaded.bytes.subarray(0,8).toString('hex')}:{} )};
    return failure(error.status??'error',error.status==='need_auth'?'原生下载需要有效 BOSS 登录，请在独立窗口中检查登录状态。':error.status==='requires_review'?'平台要求人工处理或验证，已停止下载且不会重试其他候选人。':error.status==='permission_denied'?'平台原生下载未授予文件访问权限，未申请、交换或保存为成功简历。':'原生附件下载或格式校验失败，未保存为成功简历。',{...result?.meta,diagnostics});}finally{busy.delete(port)}
}
