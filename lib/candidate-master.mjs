export const CANDIDATE_PROFILE_FIELDS = Object.freeze(['name','age','degree','workYear','city','position','salary','company','school','major','briefIntroduction','introduction','workHistory','education']);
const arrays = new Set(['workHistory','education']);
const own = (o,k) => Object.hasOwn(o || {},k);
const copy = value => structuredClone(value);
const empty = value => value == null || value === '' || Array.isArray(value) && value.length === 0;
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const failure = (message,statusCode=400) => Object.assign(new Error(message),{code:'candidate_profile_validation',statusCode});
const manual = candidate => new Set(Array.isArray(candidate.profileManualFields)?candidate.profileManualFields:[]);

export function candidateProfileView(candidate, source = {}) {
  if (!candidate) return copy(source);
  if(candidate.profileMasterVersion!==1&&!Number.isInteger(candidate.profileRevision)&&!candidate.profileManualFields?.length)return copy(source);
  const result = copy(source);
  for (const field of CANDIDATE_PROFILE_FIELDS) if (own(candidate,field)) result[field]=copy(candidate[field]);
  for (const [alias,field] of [['expectedSalary','salary'],['expectedPosition','position'],['expectedCity','city']]) if (own(candidate,field)) result[alias]=copy(candidate[field]);
  return result;
}

/** Apply observations only to the stable, explicitly selected person. */
export function mergeBossCandidateFields(candidate, incoming = {}, {source='boss',capturedAt=new Date().toISOString(),fillOnly=false}={}) {
  const data={...incoming};
  for(const [alias,field] of [['expectedSalary','salary'],['expectedPosition','position'],['expectedCity','city']]) if(empty(data[field])&&!empty(data[alias]))data[field]=data[alias];
  const locked=manual(candidate),changed=[];
  for(const field of CANDIDATE_PROFILE_FIELDS){
    if(locked.has(field)||empty(data[field])||fillOnly&&!empty(candidate[field]))continue;
    const value=data[field];
    if(arrays.has(field)?!Array.isArray(value):!['string','number'].includes(typeof value))continue;
    const normalized=arrays.has(field)?copy(value):String(value).trim();
    if(empty(normalized)||equal(candidate[field],normalized))continue;
    candidate[field]=normalized;changed.push(field);
  }
  if(!fillOnly&&changed.some(key=>['introduction','workHistory'].includes(key))&&!locked.has('briefIntroduction')&&candidate.profileFieldSources?.briefIntroduction?.kind==='reviewed_summary'){
    candidate.briefIntroduction='';changed.push('briefIntroduction');
  }
  if(changed.length){
    candidate.profileRevision=(candidate.profileRevision||0)+1;
    candidate.profileFieldSources??={};
    for(const key of changed)candidate.profileFieldSources[key]={kind:source,capturedAt};
    candidate.updatedAt=capturedAt;
  }
  return {changed:changed.length>0,fields:changed};
}

export function ensureCandidateMaster(state) {
  let changed=false;
  state.candidates??=[];
  for(const row of state.conversations||[]){
    if(row.source!=='boss'||!row.sourceAccountKey||!row.candidateExternalId)continue;
    let c=state.candidates.find(c=>c.source==='boss'&&c.sourceAccountKey===row.sourceAccountKey&&c.externalId===row.candidateExternalId);
    if(row.candidateId&&row.candidateId!==c?.id)continue;
    if(!c){
      const id='cand_'+createHash('sha256').update(`boss:${row.sourceAccountKey}:${row.candidateExternalId}`).digest('hex').slice(0,24);
      if(state.candidates.some(c=>c.id===id))continue;
      c={id,source:'boss',sourceAccountKey:row.sourceAccountKey,externalId:row.candidateExternalId,name:typeof row.peerName==='string'?row.peerName:'',createdAt:row.importedAt||new Date().toISOString(),updatedAt:row.importedAt||new Date().toISOString(),sourceLabel:'BOSS 沟通资料'};
      state.candidates.push(c);changed=true;
    }
    if(!row.candidateId){row.candidateId=c.id;changed=true;}
  }
  for(const c of state.candidates||[]){
    if(!own(c,'briefIntroduction')){
      const saved=(state.documents||[]).filter(d=>d.candidateId===c.id&&d.type==='interview_pack'&&d.content?.candidateBrief?.text).sort((a,b)=>Date.parse(b.updatedAt||b.createdAt||0)-Date.parse(a.updatedAt||a.createdAt||0))[0];
      c.briefIntroduction=saved?.content.candidateBrief.text||'';changed=true;
      if(saved){c.profileFieldSources??={};c.profileFieldSources.briefIntroduction={kind:'reviewed_summary',documentId:saved.id,updatedAt:saved.updatedAt||saved.createdAt};}
    }
    const sources=[];
    if(c.source==='boss'&&c.sourceAccountKey&&c.externalId){
      for(const row of state.conversations||[]){
        const meta=row.profileMeta;
        if(row.sourceAccountKey===c.sourceAccountKey&&row.candidateExternalId===c.externalId&&(!row.candidateId||row.candidateId===c.id)&&meta?.accountKey===row.sourceAccountKey&&meta.currentConversationId===row.externalId&&meta.currentPeerId===row.peerId&&row.profile&&(!row.profile.sourceAccountKey||row.profile.sourceAccountKey===c.sourceAccountKey))sources.push({data:row.profile,kind:'boss_message',at:row.profileUpdatedAt||c.capturedAt});
      }
      for(const row of state.sourcingCandidates||[])if(row.candidateId===c.id&&row.sourceAccountKey===c.sourceAccountKey&&row.externalId===c.externalId&&row.profile)sources.push({data:row.profile,kind:'boss_search',at:row.capturedAt||c.capturedAt});
    }
    for(const row of sources)if(mergeBossCandidateFields(c,row.data,{source:row.kind,capturedAt:row.at||c.updatedAt||new Date().toISOString(),fillOnly:true}).changed)changed=true;
    if(!Array.isArray(c.profileManualFields)){c.profileManualFields=[];changed=true;}
    if(!c.profileFieldSources||typeof c.profileFieldSources!=='object'){c.profileFieldSources={};changed=true;}
    if(!Number.isInteger(c.profileRevision)){c.profileRevision=0;changed=true;}
    for(const field of CANDIDATE_PROFILE_FIELDS)if(!own(c,field)||c[field]==null){c[field]=arrays.has(field)?[]:'';changed=true;}
    if(c.profileMasterVersion!==1){c.profileMasterVersion=1;changed=true;}
  }
  return changed;
}

function cleanFields(fields){
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw failure('请提交要修改的候选人资料字段。');
  const result={};
  for(const [key,value]of Object.entries(fields)){
    if(!CANDIDATE_PROFILE_FIELDS.includes(key))throw failure('只能修改候选人的基本信息、职业介绍、工作和教育经历。');
    if(arrays.has(key)){
      if(!Array.isArray(value)||value.length>100)throw failure('工作或教育经历应为不超过100条的记录。');
      const keys=key==='workHistory'?['company','position','dateRange','startDate','endDate','description','responsibilities','achievements']:['school','major','degree','dateRange','startDate','endDate','description'];
      result[key]=value.map(row=>{
        if(typeof row==='string')return row.trim().slice(0,20000);
        if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!keys.includes(k)))throw failure('经历中包含不可编辑的字段。');
        const out={};for(const [field,text]of Object.entries(row)){if(typeof text!=='string'||text.length>20000)throw failure('经历字段必须是文字，且单项不超过20000字。');out[field]=text.trim();}return out;
      });
    }else{if(typeof value!=='string'||value.length>(key==='introduction'?30000:key==='briefIntroduction'?3000:1000))throw failure('候选人资料字段格式或长度不正确。');result[key]=value.trim();}
  }
  return result;
}

export function updateCandidateProfile(state,candidateId,input,{at=new Date().toISOString()}={}){
  if(!input||Object.keys(input).some(k=>!['fields','revision'].includes(k)))throw failure('候选人资料只接受修改字段与资料版本。');
  const c=(state.candidates||[]).find(row=>row.id===candidateId);if(!c)throw failure('候选人不存在。',404);
  if(!Number.isInteger(input.revision)||input.revision<0)throw failure('请刷新后重新编辑候选人资料。');
  if(input.revision!==(c.profileRevision||0))throw failure('候选人资料已更新，请刷新后再保存。',409);
  const fields=cleanFields(input.fields),changed=Object.keys(fields).filter(key=>!equal(c[key],fields[key]));
  if(!changed.length)return {candidate:copy(c),changed:false,revision:c.profileRevision||0};
  const locked=manual(c);c.profileFieldSources??={};
  for(const key of changed){c[key]=fields[key];locked.add(key);c.profileFieldSources[key]={kind:'manual',updatedAt:at};}
  if(changed.some(key=>['introduction','workHistory'].includes(key))&&!own(fields,'briefIntroduction')&&!locked.has('briefIntroduction')&&c.profileFieldSources.briefIntroduction?.kind==='reviewed_summary'){
    c.briefIntroduction='';c.profileFieldSources.briefIntroduction={kind:'derived_summary_stale',updatedAt:at};
  }
  c.profileManualFields=[...locked];c.profileRevision=(c.profileRevision||0)+1;c.profileMasterVersion=1;c.updatedAt=at;
  return {candidate:copy(c),changed:true,revision:c.profileRevision};
}
import { createHash } from 'node:crypto';

