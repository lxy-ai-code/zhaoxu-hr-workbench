import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_CDP_PORT, INSTALLED } from './runtime-config.mjs';

const TARGET = 'https://www.zhipin.com/web/chat/index';
const PROFILE_NAME = '.chrome-cdp-9222'; // Existing login profile; its name is historical.
const MIN_COOLDOWN_MS = 30000;
const configuredRuntimes = new Map();
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function chromeLocations(env) {
  return [...new Set([
    env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files',
    env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
    env.LOCALAPPDATA,
  ].filter(Boolean).map(base => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')))];
}

async function probeVersion(port, fetcher) {
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
    const data = await response.json().catch(() => null);
    let debuggerUrl;
    try { debuggerUrl = new URL(data?.webSocketDebuggerUrl); } catch {}
    if (response.ok && /^(?:Headless)?Chrome\/\d/.test(data?.Browser || '') &&
      debuggerUrl?.protocol === 'ws:' && debuggerUrl.hostname === '127.0.0.1' &&
      Number(debuggerUrl.port) === port && !debuggerUrl.username && !debuggerUrl.password &&
      !debuggerUrl.search && !debuggerUrl.hash && /^\/devtools\/browser\/[a-z0-9-]+$/i.test(debuggerUrl.pathname)) {
      return { status: 'connected', browser: data.Browser, port };
    }
    return { status: 'unavailable', reason: 'port_conflict', port, message: '专用端口返回的不是可确认的 Chrome 调试服务，未启动其他浏览器或停止该端口进程。' };
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') return { status: 'closed', port };
    return { status: 'unavailable', reason: 'probe_failed', port, message: '无法确认专用浏览器端口状态，未按端口空闲处理或重复启动。' };
  }
}

/** Only restores the already-authorized, dedicated Windows Chrome profile.
 * It does not inspect credentials, sign in, solve challenges, or create profiles.
 * Dependency injection is for contract tests; production uses the real local OS.
 */
export function createBossBrowserRuntime({ root, cdpPort = DEFAULT_CDP_PORT, chromePath,
  fetcher = fetch, spawnImpl = spawn, stat = fs.stat, realpath = fs.realpath,
  platform = process.platform, env = process.env, clock = Date.now, cooldownMs = MIN_COOLDOWN_MS } = {}) {
  let current = null, lastAttemptAt = null, launched = null, observedConnection = false;
  const port = Number(cdpPort), cooldown = Math.max(MIN_COOLDOWN_MS, Number(cooldownMs) || MIN_COOLDOWN_MS);
  const unavailable = (reason, message) => ({ status: 'unavailable', reason, port, message });
  async function execute() {
    if (platform !== 'win32') return unavailable('unsupported_platform', 'BOSS 专用浏览器自动恢复仅适用于当前 Windows 主机。');
    if (port !== DEFAULT_CDP_PORT) return unavailable('unsupported_port', `自动恢复仅使用专用端口 ${DEFAULT_CDP_PORT}，不操作其他浏览器配置。`);
    if (typeof root !== 'string' || !path.isAbsolute(root)) return unavailable('invalid_root', '缺少明确的工作台绝对目录，未启动浏览器。');
    const result = await probeVersion(port, fetcher);
    if (result.status === 'connected') { observedConnection = true; launched = null; return result; }
    if (result.status !== 'closed') return result;
    // A launch is not proof of a ready/logged-in browser. Avoid repeatedly
    // opening tabs if Chrome forwarded into a profile already open elsewhere.
    if (launched && launched.exitCode === null && launched.signalCode == null) return { status: 'starting', reason: 'awaiting_devtools', port, message: '专用浏览器已启动，等待调试端口就绪；未再次启动。' };
    if (launched && launched.exitCode === 0 && !observedConnection) return unavailable('launch_not_ready', 'Chrome 启动进程已结束但专用调试端口未就绪，请检查该已有资料目录是否在其他浏览器进程中使用。');
    if (lastAttemptAt !== null && clock() - lastAttemptAt < cooldown) return { status: 'starting', reason: 'cooldown', port, message: '浏览器恢复正在冷却，未重复启动。' };
    const profilePath = INSTALLED ? path.resolve(root, 'boss-chrome') : path.resolve(root, '..', PROFILE_NAME);
    try {
      if (!(await stat(profilePath)).isDirectory() || !samePath(await realpath(profilePath), profilePath)) return unavailable('profile_unavailable', '现有 BOSS 登录资料目录不是可确认的原目录，未创建或替换资料目录。');
    } catch { return unavailable('profile_unavailable', '现有 BOSS 登录资料目录不存在或不可访问，未创建新身份。'); }
    const locations = chromeLocations(env);
    if (chromePath && (!path.isAbsolute(chromePath) || !locations.some(candidate => samePath(candidate, chromePath)))) return unavailable('unrecognized_chrome', 'Chrome 路径不属于本机正式安装位置，未运行该文件。');
    let executable;
    for (const candidate of chromePath ? [chromePath] : locations) {
      try { if ((await stat(candidate)).isFile() && samePath(await realpath(candidate), candidate)) { executable = candidate; break; } } catch {}
    }
    if (!executable) return unavailable('chrome_unavailable', '未找到可确认的本机 Chrome 正式安装文件。');
    lastAttemptAt = clock(); observedConnection = false;
    try {
      const child = spawnImpl(executable, [
        '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
        `--user-data-dir=${profilePath}`, '--no-first-run', '--no-default-browser-check', '--start-minimized', TARGET,
      ], { cwd: path.resolve(root), windowsHide: true, stdio: 'ignore', shell: false });
      launched = child;
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref?.();
      return { status: 'starting', reason: 'launched', port, message: '已恢复专用 BOSS 浏览器，沿用已有登录目录；登录状态和页面验证仍以 BOSS 为准。' };
    } catch { launched = null; return unavailable('launch_failed', '专用浏览器未能启动，保留冷却并等待后续恢复。'); }
  }
  return { ensure() { if (!current) current = execute().finally(() => { current = null; }); return current; } };
}

export function ensureBossBrowser(options = {}) {
  const key = `${typeof options.root === 'string' ? path.resolve(options.root) : ''}:${Number(options.cdpPort ?? DEFAULT_CDP_PORT)}:${options.chromePath || ''}`;
  if (!configuredRuntimes.has(key)) configuredRuntimes.set(key, createBossBrowserRuntime(options));
  return configuredRuntimes.get(key).ensure();
}
