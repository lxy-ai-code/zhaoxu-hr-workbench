const scalarFields=[['name','姓名'],['age','年龄'],['degree','学历'],['workYear','工作经验'],['city','城市'],['position','期望岗位'],['salary','期望薪资'],['company','最近公司'],['school','毕业院校'],['major','专业'],['briefIntroduction','面试人简介'],['introduction','职业摘要原文']];
const rowFields={
  workHistory:[['company','公司'],['position','岗位'],['dateRange','时间'],['description','工作内容'],['responsibilities','工作职责'],['achievements','工作成果'],['startDate','开始时间'],['endDate','结束时间']],
  education:[['school','学校'],['major','专业'],['degree','学历'],['dateRange','时间'],['description','补充说明'],['startDate','开始时间'],['endDate','结束时间']],
};
const scalarKeys=new Set(scalarFields.map(([key])=>key));
const asText=value=>typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?String(value):'';
const list=value=>Array.isArray(value)?value:[];
const emptyRow=kind=>Object.fromEntries(rowFields[kind].map(([key])=>[key,'']));
const normalizeRow=(row,kind)=>typeof row==='string'?{...emptyRow(kind),description:row}:Object.fromEntries(rowFields[kind].map(([key])=>[key,asText(row?.[key])]));

/** Only editable career fields enter this snapshot; identity/source keys never do. */
export function candidateProfileEditorSnapshot(candidate={}) {
  return {...Object.fromEntries(scalarFields.map(([key])=>[key,asText(candidate[key])])),...Object.fromEntries(Object.keys(rowFields).map(kind=>[kind,list(candidate[kind]).map(row=>normalizeRow(row,kind))]))};
}

export function candidateProfileEditorDraftFromEntries(entries) {
  const draft=candidateProfileEditorSnapshot(),rows={workHistory:new Map(),education:new Map()};
  for(const [name,value] of entries){
    if(typeof name!=='string')continue;
    if(name.startsWith('profile.')&&scalarKeys.has(name.slice(8))){if(typeof value!=='string')throw new Error('资料字段应填写文字。');draft[name.slice(8)]=value;continue;}
    const match=name.match(/^(workHistory|education)\.(\d+)\.([A-Za-z]+)$/);
    if(!match||!rowFields[match[1]].some(([key])=>key===match[3]))continue;
    const index=Number(match[2]);if(!Number.isSafeInteger(index)||index<0||index>10000)throw new Error('经历条目已变化，请重新打开编辑。');
    if(typeof value!=='string')throw new Error('经历字段应填写文字。');
    if(!rows[match[1]].has(index))rows[match[1]].set(index,emptyRow(match[1]));
    rows[match[1]].get(index)[match[3]]=value;
  }
  for(const kind of Object.keys(rows))draft[kind]=[...rows[kind]].sort(([a],[b])=>a-b).map(([,row])=>row);
  return draft;
}

/** Comparing snapshots keeps an untouched historical array out of the patch. */
export function candidateProfileEditorChanges(original,draft) {
  const before=candidateProfileEditorSnapshot(original),after=candidateProfileEditorSnapshot(draft),fields={};
  for(const key of [...scalarKeys,...Object.keys(rowFields)])if(JSON.stringify(before[key])!==JSON.stringify(after[key]))fields[key]=after[key];
  return fields;
}

export function createCandidateProfileEditor(ctx) {
  const {byId,api,modal,escape:esc,run,loadWorkspace,notify,closeOverlay}=ctx;
  let opened=null,sequence=0;
  const fieldMarkup=(name,label,value,{textarea=false,extra=''}={})=>`<div class="field ${textarea?'full':''}"><label>${esc(label)}${textarea?`<textarea class="control" name="${esc(name)}" rows="3" ${extra}>${esc(value)}</textarea>`:`<input class="control" name="${esc(name)}" value="${esc(value)}" ${extra}>`}</label></div>`;
  const listNames={workHistory:'工作经历',education:'教育经历'};
  function rowMarkup(kind,row,index){
    const primary=kind==='workHistory'?['company','position','dateRange','description']:['school','major','degree','dateRange','description'];
    const renderField=([key,label])=>fieldMarkup(`${kind}.${index}.${key}`,label,row[key],{textarea:['description','responsibilities','achievements'].includes(key),extra:`data-profile-list="${kind}" data-profile-row="${index}" data-profile-column="${key}"`});
    const more=rowFields[kind].filter(([key])=>!primary.includes(key));
    return `<article class="candidate-profile-edit-row"><header><h4>${listNames[kind]} ${index+1}</h4><button type="button" class="btn small" data-action="candidate-profile-row-remove" data-list="${kind}" data-index="${index}">删除本条</button></header><div class="form-grid">${rowFields[kind].filter(([key])=>primary.includes(key)).map(renderField).join('')}</div>${more.length?`<details class="candidate-profile-edit-more"><summary>更多日期与内容</summary><div class="form-grid">${more.map(renderField).join('')}</div></details>`:''}</article>`;
  }
  function render(){
    if(!opened)return;
    const {draft,id,session}=opened;
    const body=`<form id="candidate-profile-editor-form" data-candidate-id="${esc(id)}" data-profile-editor-session="${session}"><p class="candidate-profile-edit-note">各模块共用这份候选人档案。缺少的信息可先留空，手动修改的信息会保留。</p><section class="candidate-profile-edit-section"><h3>基本信息</h3><div class="form-grid">${scalarFields.map(([key,label])=>fieldMarkup(`profile.${key}`,label,draft[key],{textarea:['introduction','briefIntroduction'].includes(key),extra:`data-profile-field="${key}"`})).join('')}</div></section>${Object.keys(rowFields).map(kind=>`<section class="candidate-profile-edit-section"><header><h3>${listNames[kind]}</h3><button type="button" class="btn small" data-action="candidate-profile-row-add" data-list="${kind}">添加${listNames[kind]}</button></header>${draft[kind].length?draft[kind].map((row,index)=>rowMarkup(kind,row,index)).join(''):'<p class="candidate-profile-edit-empty">暂未填写</p>'}</section>`).join('')}</form>`;
    modal(`${draft.name||'候选人'} · 编辑档案`,'修改姓名、求职期望和职业经历，保存后在各模块同步显示。',body,`<button type="button" class="btn" data-action="candidate-profile-editor-cancel">取消</button><button type="submit" class="btn primary" form="candidate-profile-editor-form">保存档案</button>`,true);
  }
  function open(id){
    const candidate=byId('candidates',id);
    if(!candidate){notify('未找到该候选人，请刷新后重试。',true);return false;}
    const original=candidateProfileEditorSnapshot(candidate);
    opened={id:candidate.id,revision:Number.isInteger(candidate.profileRevision)?candidate.profileRevision:0,original,draft:structuredClone(original),session:++sequence};
    render();return true;
  }
  function belongs(form){return Boolean(opened&&form?.id==='candidate-profile-editor-form'&&form.dataset?.candidateId===opened.id&&form.dataset?.profileEditorSession===String(opened.session));}
  function sync(form){if(!belongs(form))throw new Error('编辑的候选人已变化，请重新打开档案。');opened.draft=candidateProfileEditorDraftFromEntries(new FormData(form));}
  function handleAction(button){
    const action=button?.dataset?.action;
    if(action==='candidate-profile-edit'){open(button.dataset.id);return true;}
    if(!['candidate-profile-row-add','candidate-profile-row-remove','candidate-profile-editor-cancel'].includes(action))return false;
    if(action==='candidate-profile-editor-cancel'){opened=null;closeOverlay();return true;}
    const form=button.closest?.('form'),kind=button.dataset.list;
    if(!belongs(form)||!Object.hasOwn(rowFields,kind)){notify('编辑内容已变化，请重新打开档案。',true);return true;}
    try{sync(form);}catch(error){notify(error.message,true);return true;}
    if(action==='candidate-profile-row-add')opened.draft[kind].push(emptyRow(kind));
    else{const index=Number(button.dataset.index);if(!Number.isInteger(index)||index<0||index>=opened.draft[kind].length){notify('未找到这条经历，请重新打开档案。',true);return true;}opened.draft[kind].splice(index,1);}
    render();return true;
  }
  function handleInput(event){
    const field=event.target,form=field?.closest?.('form');
    if(form?.id!=='candidate-profile-editor-form')return false;
    if(!belongs(form))return true;
    const key=field.dataset?.profileField,kind=field.dataset?.profileList,column=field.dataset?.profileColumn,index=Number(field.dataset?.profileRow);
    if(scalarKeys.has(key))opened.draft[key]=field.value;
    else if(Object.hasOwn(rowFields,kind)&&Number.isInteger(index)&&opened.draft[kind][index]&&rowFields[kind].some(([key])=>key===column))opened.draft[kind][index][column]=field.value;
    return true;
  }
  function handleSubmit(event){
    const form=event.target;if(form?.id!=='candidate-profile-editor-form')return false;
    event.preventDefault();if(form.reportValidity&&!form.reportValidity())return true;
    if(!belongs(form)){notify('编辑的候选人已变化，请重新打开档案。',true);return true;}
    if(opened.saving)return true;
    try{sync(form);}catch(error){notify(error.message,true);return true;}
    const snapshot=opened,fields=candidateProfileEditorChanges(snapshot.original,snapshot.draft);
    if(!Object.keys(fields).length){opened=null;closeOverlay();notify('资料没有变化。');return true;}
    snapshot.saving=true;
    run(event.submitter,async()=>{
      try{
        await api(`/api/candidates/${encodeURIComponent(snapshot.id)}/profile`,'PATCH',{fields,revision:snapshot.revision});
        // A later editor may have opened while this request was running.
        if(opened?.session===snapshot.session){opened=null;closeOverlay();}
        await loadWorkspace();notify('候选人档案已保存。');
      }finally{if(opened?.session===snapshot.session)opened.saving=false;}
    });
    return true;
  }
  return {open,handleAction,handleInput,handleSubmit};
}
