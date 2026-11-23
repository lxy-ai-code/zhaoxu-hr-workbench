import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WORKSPACE_ROOT } from './runtime-config.mjs';

const appRoot = WORKSPACE_ROOT;
const cliRuntime = path.join(appRoot, 'data', 'runtime');

const secretKey = /^(?:authorization|cookie|set-cookie|password|app.?secret|client.?secret|access.?token|refresh.?token|tenant.?access.?token|user.?access.?token|__zp_stoken__|securityId)$/i;
export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, secretKey.test(key) ? '[REDACTED]' : sanitize(val)]));
  if (typeof value === 'string') return value.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]').replace(/((?:access_token|refresh_token|app_secret|appSecret|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  return value;
}

export class LarkCliError extends Error {
  constructor(message, details = {}) { super(sanitize(message)); this.name = 'LarkCliError'; Object.assign(this, sanitize(details)); }
}

export function parseCliOutput(stdout, stderr = '', exitCode = 0) {
  const parse = text => { try { return JSON.parse(text.trim()); } catch { return null; } };
  const result = parse(stdout);
  const errorResult = parse(stderr);
  if (exitCode === 0 && result && result.ok !== false) return sanitize(result);
  const error = errorResult?.error ?? result?.error ?? {};
  const type = error.subtype ?? error.type ?? 'cli_error';
  throw new LarkCliError(error.message || (stderr.trim() ? stderr.trim().slice(0, 700) : '飞书 CLI 未返回可识别的成功结果'), { code: type, exitCode, upstreamCode: error.code, hint: error.hint, missingScopes: error.missing_scopes, confirmationRequired: exitCode === 10 });
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
export async function locateLarkCli() {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const candidates = [];
  if (process.env.HR_LARK_CLI_PATH) candidates.push(process.env.HR_LARK_CLI_PATH);
  for (const entry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, `lark-cli${extension}`));
    if (process.platform === 'win32') candidates.push(path.join(entry, 'lark-cli.cmd'));
  }
  if (process.platform === 'win32') candidates.push(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'pnpm', 'bin', 'lark-cli.cmd'));
  for (const file of [...new Set(candidates)]) {
    if (!await exists(file)) continue;
    if (/\.cmd$/i.test(file)) {
      const launcher = await fs.readFile(file, 'utf8');
      const match = launcher.match(/"(%~dp0[^"\r\n]+\.js)"/i);
      if (!match) continue;
      const jsEntry = path.resolve(path.dirname(file), match[1].replace(/^%~dp0[\\/]?/, ''));
      const binary = path.resolve(path.dirname(jsEntry), '..', 'bin', `lark-cli${extension}`);
      if (await exists(binary)) return binary;
      continue;
    }
    if (process.platform !== 'win32' || /\.exe$/i.test(file)) return file;
  }
  throw new LarkCliError('未找到可执行的飞书 CLI；已检查 PATH 与用户 pnpm bin 目录。', { code: 'not_installed' });
}

export async function prepareLarkArguments(args, { cwd } = {}) {
  const prepared = [...args];
  const largeCommand = args.reduce((size, value) => size + value.length + 3, 0) > 12000;
  const indexes = args.flatMap((arg, index) => ['--json', '--fields'].includes(arg) && typeof args[index + 1] === 'string' && /^[\[{]/.test(args[index + 1].trim()) && (largeCommand || args[index + 1].length > 4096) ? [index + 1] : []);
  if (!indexes.length) return { args: prepared, cwd, files: [], cleanup: async () => {} };
  if (cwd && path.resolve(cwd).toLowerCase() !== path.resolve(appRoot).toLowerCase()) throw new LarkCliError('大型 JSON 请求需从工作台目录运行，不能与其他相对文件工作目录混用。', { code: 'invalid_cli_cwd' });
  await fs.mkdir(cliRuntime, { recursive: true });
  const directory = await fs.mkdtemp(path.join(cliRuntime, 'cli-payload-'));
  const files = [];
  const cleanup = async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(cliRuntime) || !path.basename(resolved).startsWith('cli-payload-')) throw new LarkCliError('临时请求目录校验失败。', { code: 'invalid_cleanup_path' });
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  try {
    for (const index of indexes) {
      const file = path.join(directory, `input-${index}.json`);
      await fs.writeFile(file, args[index], 'utf8');
      files.push(file);
      prepared[index] = '@./' + path.relative(appRoot, file).split(path.sep).join('/');
    }
    return { args: prepared, cwd: appRoot, files, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function runLark(args, { timeoutMs = 45000, cwd, stdinText, write = false } = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('CLI arguments must be strings without NUL.');
  const executable = await locateLarkCli();
  const prepared = await prepareLarkArguments(args, { cwd });
  let result;
  try {
    result = await new Promise((resolve, reject) => {
    const child = spawn(executable, prepared.args, { cwd: prepared.cwd, shell: false, windowsHide: true, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, oversized = false;
    const collect = (which, chunk) => {
      if (which === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 16 * 1024 * 1024) { oversized = true; child.kill(); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(new LarkCliError(error.message, { code: 'spawn_failed' })); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || oversized) return reject(new LarkCliError(timedOut ? '飞书请求超时，未自动重试。' : '飞书响应超出安全缓冲区，未自动重试。', { code: write ? 'unknown_delivery' : timedOut ? 'timeout' : 'response_too_large' }));
      try { resolve(parseCliOutput(stdout, stderr, code)); } catch (error) {
        if (write && (code === 0 || /network|timeout|transport|connection/.test(error.code ?? ''))) { error.originalCode = error.code; error.code = 'unknown_delivery'; }
        reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdinText);
    });
    return result;
  } finally {
    try { await prepared.cleanup(); }
    catch (error) {
      if (result) result.meta = { ...result.meta, local_cleanup_warning: '本地请求临时文件未能完全清理。' };
      else if (!write) throw error;
    }
  }
}
