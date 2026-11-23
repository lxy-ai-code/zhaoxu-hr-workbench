export function documentGenerationStatus(document={}) {
  if(document.generator==='materials')return {label:'已收集资料',detail:'已收集资料 · 待生成问题',tone:'gray',pending:true,generated:false};
  if(['ai','model','agent','codex','claude'].includes(document.generator))return {label:'AI 草稿',detail:'AI 草稿',tone:'purple',pending:false,generated:true};
  return {label:'历史资料草稿',detail:'历史资料草稿',tone:'green',pending:false,generated:false};
}

export function latestDocumentsByCandidate(documents, applications) {
  const candidateByApplication = new Map(applications.map(row => [row.id, row.candidateId]));
  const newestFirst = [...documents].sort((a, b) =>
    (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const seen = new Set();
  return newestFirst.filter(document => {
    const candidateId = document.candidateId || candidateByApplication.get(document.applicationId);
    if (!candidateId) return true;
    if (seen.has(candidateId)) return false;
    seen.add(candidateId);
    return true;
  });
}
