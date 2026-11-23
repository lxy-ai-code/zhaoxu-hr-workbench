import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './store.mjs';
import { RESUME_ROOT, MAX_NATIVE_RESUME_BYTES, detectResumeType, safeResumeName } from './resumes.mjs';
import { isRetiredOnlineResume } from './resume-policy.mjs';

const array = value => Array.isArray(value) ? value : [];
const contained = (file, directory) => {
  const relative = path.relative(directory, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const fail = (message, code = 'invalid_reminder_attachment') => Object.assign(new Error(message), { code });

/** Only archived original attachments for this exact candidate/application.
 * Text parsing is not required for sharing an otherwise valid original file. */
export function selectReminderAttachments(input = {}) {
  const interview = input.interview || {}, candidateId = interview.candidateId || input.candidate?.id;
  if (!candidateId || !interview.applicationId || input.candidate?.id && input.candidate.id !== candidateId) return [];
  const seen = new Set();
  return array(input.resumes).filter(row => row?.candidateId === candidateId && (!row.applicationId || row.applicationId === interview.applicationId) && !isRetiredOnlineResume(row)
    && !/(?:^|[_\s-])ocr(?:$|[_\s-])/i.test([row.source, row.kind, row.materialKind, row.sourceMeta?.source, row.sourceMeta?.rendering].filter(Boolean).join(' '))
    && typeof row.filePath === 'string' && row.filePath && /^[a-f0-9]{64}$/i.test(row.sha256 || '') && row.id)
    .sort((a,b) => (Date.parse(b.capturedAt || b.createdAt) || 0) - (Date.parse(a.capturedAt || a.createdAt) || 0))
    .filter(row => { const hash=row.sha256.toLowerCase();if (seen.has(hash)) return false;seen.add(hash);return true; }).slice(0, 3)
    .map(row => ({ ...row, sha256:row.sha256.toLowerCase(), name: safeResumeName(row.name || path.basename(row.filePath)) }));
}

/** Verify original bytes before any side effect. No external URL or guessed
 * cloud link is ever substituted for an inaccessible local original. */
export async function prepareReminderAttachments(input, { root = ROOT, resumeRoot = RESUME_ROOT } = {}) {
  const selected = selectReminderAttachments(input), files = [], failures = [];
  for (const resume of selected) {
    try {
      const resolved = path.resolve(root, resume.filePath), directory = path.resolve(resumeRoot);
      if (!contained(resolved, directory)) throw fail('附件原文件不在简历归档目录。');
      const [realFile, realDirectory] = await Promise.all([fs.realpath(resolved), fs.realpath(directory)]);
      if (!contained(realFile, realDirectory)) throw fail('附件原文件的实际路径不在简历归档目录。');
      const stat = await fs.stat(realFile);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_NATIVE_RESUME_BYTES) throw fail('附件原文件为空、过大或不可读取。');
      const bytes = await fs.readFile(realFile);
      if (createHash('sha256').update(bytes).digest('hex') !== resume.sha256.toLowerCase()) throw fail('附件原文件与档案哈希不一致。', 'reminder_attachment_hash_mismatch');
      detectResumeType(bytes, resume.name, { native: true });
      const relative = path.relative(path.resolve(root), realFile);
      if (!contained(realFile, path.resolve(root))) throw fail('附件原文件不在工作台目录。');
      files.push({ ...resume, bytes, relativePath: './' + relative.split(path.sep).join('/') });
    } catch (error) {
      failures.push({ resumeId: resume.id, name: resume.name, sha256: resume.sha256, status: 'failed', error: { code: error.code || 'reminder_attachment_unreadable', message: '简历原文件校验未完成，未发送该附件。' } });
    }
  }
  return { files, failures };
}

/** Freeze the verified bytes for the CLI upload. A later change to the archive
 * cannot swap the file after its hash/ownership was checked. */
export async function stageReminderAttachments(prepared, { root = ROOT } = {}) {
  if (!prepared.files.length) return { ...prepared, cleanup: async()=>{} };
  const parent=path.resolve(root,'data','runtime'), files=[], failures=[...prepared.failures];
  let directory;
  const cleanup=async()=>{
    if(!directory)return;
    const resolved=path.resolve(directory);
    if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('interview-reminder-files-'))throw fail('附件临时目录校验未通过。');
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  };
  try {
    await fs.mkdir(parent,{recursive:true});
    directory=await fs.mkdtemp(path.join(parent,'interview-reminder-files-'));
    for(let i=0;i<prepared.files.length;i++) {
      const resume=prepared.files[i];
      try {
        const folder=path.join(directory,String(i));await fs.mkdir(folder);
        const destination=path.join(folder,resume.name);
        await fs.writeFile(destination,resume.bytes,{flag:'wx',mode:0o600});
        const {bytes,...metadata}=resume;
        files.push({...metadata,relativePath:'./'+path.relative(path.resolve(root),destination).split(path.sep).join('/')});
      }catch{
        failures.push({resumeId:resume.id,name:resume.name,sha256:resume.sha256,status:'failed',error:{code:'reminder_attachment_snapshot_failed',message:'附件原文件发送快照未完成，未发送该附件。'}});
      }
    }
    return {files,failures,cleanup};
  }catch{
    await cleanup();
    return {files:[],failures:[...failures,...prepared.files.map(resume=>({resumeId:resume.id,name:resume.name,sha256:resume.sha256,status:'failed',error:{code:'reminder_attachment_snapshot_failed',message:'附件原文件发送快照未完成，未发送该附件。'}}))],cleanup:async()=>{}};
  }
}
