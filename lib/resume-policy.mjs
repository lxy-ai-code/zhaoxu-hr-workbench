export const RESUME_SOURCE_POLICY_VERSION = 'attachment_only_v1';
export const RESUME_SOURCE_POLICY_INSTRUCTIONS = '简历来源政策：本次只采用已下载或手工上传的附件解析原文。在线简历、网页截图、画布OCR及其历史快照已停用，不得引用为简历证据，不得从旧面试包恢复这些正文。BOSS资料卡仅为职业摘要，不能替代附件正文；没有可解析附件时明确材料不足，保留待补事项。';

export function isRetiredOnlineResume(row) {
  if (!row || typeof row !== 'object') return false;
  const source = [row.kind, row.materialKind, row.source, row.sourceMeta?.source].filter(Boolean).join(' ');
  const coverage = [row.coverage, row.sourceMeta?.coverage, row.sourceMeta?.rendering].filter(Boolean).join(' ');
  return /(?:^|\s)(?:online(?:_resume|_ocr)?|boss_online(?:_\w+)?)(?:\s|$)/i.test(source)
    || /online_resume|wasm_canvas|canvas_ocr/i.test(coverage)
    || Boolean(row.onlineData);
}

export const isUsableAttachmentResume = row => Boolean(row && !isRetiredOnlineResume(row) && row.textStatus === 'parsed' && typeof row.text === 'string' && row.text.trim());
export const excludedOnlineResumeMetadata = rows => (Array.isArray(rows) ? rows : []).filter(isRetiredOnlineResume).map(row => ({ id: row.id, reason: 'online_resume_retired' }));
export function usesRetiredOnlineResume(document) {
  const content = document?.content;
  return Boolean(content && ((content.resumeSources || []).some(isRetiredOnlineResume)
    || (content.evidence || []).some(row => isRetiredOnlineResume(row) || /在线简历|在线详情|画布文字识别/.test(row?.label || ''))));
}
