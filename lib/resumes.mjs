import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, digest, now, uid } from './store.mjs';
import { isRetiredOnlineResume } from './resume-policy.mjs';
import { APP_ROOT, INSTALLED } from './runtime-config.mjs';

export const RESUME_ROOT = path.join(ROOT, 'data/resumes');
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const MAX_NATIVE_RESUME_BYTES = 20 * 1024 * 1024;
const developmentPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const pythonDefault = INSTALLED ? path.join(APP_ROOT, 'vendor/python/python.exe')
  : existsSync(developmentPython) ? developmentPython : process.platform === 'win32' ? 'python.exe' : 'python3';
const extractionScript = fileURLToPath(new URL('../scripts/extract-resume.py', import.meta.url));
export function safeResumeName(value) { return String(value || 'resume').split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 180) || 'resume'; }
export function detectResumeType(bytes, name, { native = false } = {}) {
  const limit = native ? MAX_NATIVE_RESUME_BYTES : MAX_RESUME_BYTES;
  if (bytes.length > limit || !bytes.length) throw Object.assign(new Error(`简历必须非空且不超过 ${limit / 1024 / 1024} MB。`), { statusCode: 400 });
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf' && bytes.subarray(0, 5).toString() === '%PDF-') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (ext === '.docx' && bytes.subarray(0, 2).toString() === 'PK') return { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  if (['.txt', '.md'].includes(ext) && !bytes.includes(0)) return { kind: 'text', mimeType: 'text/plain; charset=utf-8' };
  if (native && ext === '.doc' && bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) return { kind: 'doc', mimeType: 'application/msword' };
  if (native && ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { kind: 'image', mimeType: 'image/png' };
  if (native && ['.jpg','.jpeg'].includes(ext) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return { kind: 'image', mimeType: 'image/jpeg' };
  throw Object.assign(new Error('只接受内容格式有效的 PDF、DOCX 或纯文本简历；不执行文件或宏。'), { statusCode: 400 });
}
export async function extractResumeText(file, kind, { pythonPath = process.env.HR_PYTHON || pythonDefault } = {}) {
  if (kind === 'image') return { text: '', textStatus: 'needs_ocr', truncated: false };
  if (kind === 'doc') return { text: '', textStatus: 'needs_conversion', truncated: false };
  if (kind === 'text') { const bytes = await fs.readFile(file); let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gb18030').decode(bytes); } return { text: text.slice(0, 200000), textStatus: text.trim() ? 'parsed' : 'empty', truncated: text.length > 200000 }; }
  return new Promise(resolve => {
    const child = spawn(pythonPath, [extractionScript, file, kind], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, timer; const failed = () => resolve({ text: '', textStatus: 'parser_unavailable', message: '原始文件已保留，文本解析器暂不可用；可补充文字版后初筛。' });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill(); else chunks.push(chunk); }); child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); failed(); });
    child.on('close', () => { clearTimeout(timer); try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve({ text: result.text || '', textStatus: result.textStatus || 'parse_failed', truncated: result.truncated || false }); } catch { failed(); } });
    timer = setTimeout(() => { child.kill(); failed(); }, 30000);
  });
}
export async function archiveResumeBytes({ candidateId, applicationId, name, bytes, source = 'manual_upload', kind, existing = [] }, options = {}) {
  if (kind === 'online' || source === 'boss_online') throw Object.assign(new Error('在线简历采集已移除，请使用可下载的简历附件。'), { statusCode: 410 });
  const fileName = safeResumeName(name), type = detectResumeType(bytes, fileName, { native: source === 'boss_download' });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const duplicate = existing.find(row => !isRetiredOnlineResume(row) && row.candidateId === candidateId && (row.applicationId || null) === (applicationId || null) && row.sha256 === sha256);
  if (duplicate) return { ...duplicate, deduplicated: true };
  const safeCandidate = digest(candidateId).slice(0, 20), directory = path.join(RESUME_ROOT, safeCandidate);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${sha256.slice(0, 20)}-${fileName}`);
  if (!path.resolve(file).startsWith(path.resolve(RESUME_ROOT) + path.sep)) throw new Error('简历路径不在归档目录内。');
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const parsed = await extractResumeText(file, type.kind, options);
  return { id: uid('resume'), candidateId, applicationId: applicationId || null, name: fileName, kind: kind || type.kind, fileFormat: type.kind, mimeType: type.mimeType, size: bytes.length, sha256, source, filePath: path.relative(ROOT, file), text: parsed.text, textStatus: parsed.textStatus, truncated: parsed.truncated || false, createdAt: now() };
}
export async function archiveDownloadedResume(result, input, options = {}) {
  if (!result.file?.path) throw new Error('BOSS 未返回可归档的原始文件。');
  const resolved = path.resolve(result.file.path);
  if (!resolved.startsWith(path.resolve(RESUME_ROOT) + path.sep)) throw new Error('BOSS 文件不在受控简历目录中，未归档。');
  return { ...await archiveResumeBytes({ ...input, bytes: await fs.readFile(resolved), name: result.file.name, source: 'boss_download', kind: result.file.kind }, options), sourceMeta: safeResumeSourceMeta(result.meta), coverage: result.meta?.coverage || 'native_attachment', capturedAt: result.meta?.capturedAt || now(), lastCheckedAt: result.meta?.capturedAt || now(), acquiredFrom: 'boss_download' };
}

const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, structuredClone(object[key])]));
export function safeResumeSourceMeta(meta = {}) {
  return { ...pick(meta, ['accountKey', 'source', 'coverage', 'capturedAt', 'endpoint', 'readOnly', 'unreadStateUnchanged', 'mechanism', 'sourceVersion', 'notes']), sourceIdentity: pick(meta.sourceIdentity, ['candidateExternalId','conversationId','peerId']) };
}
export function resumeDownloadPath(resume) { const file = path.resolve(ROOT, resume.filePath || ''); if (!file.startsWith(path.resolve(RESUME_ROOT) + path.sep)) throw new Error('无效的简历文件路径。'); return file; }
