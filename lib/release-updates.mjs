import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const stableVersion = /^(?:0|[1-9]\d{0,6})(?:\.(?:0|[1-9]\d{0,6})){2}$/;
const repositoryName = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i;
const CHECK_INTERVAL = 5 * 60_000;

function isNewer(latest, current) {
  const parts = current.split('.').map(Number);
  const difference = latest.split('.').map((part, index) => Number(part) - parts[index]).find(value => value !== 0);
  return difference > 0;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function releaseVersion(release, repository, current) {
  const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
  if (!stableVersion.test(version) || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('Invalid release metadata');
  }
  if (!isNewer(version, current)) return '';
  const name = `ZhaoxuHR-v${version}-windows-x64.zip`;
  for (const [file, maxBytes] of [[name, 500 * 1024 * 1024], [`${name}.sha256`, 1024]]) {
    const matches = release.assets.filter(asset => asset.name === file);
    const asset = matches[0];
    if (matches.length !== 1 || asset.state !== 'uploaded' || !Number.isInteger(asset.size) || asset.size < 1 || asset.size > maxBytes ||
      asset.browser_download_url !== `https://github.com/${repository}/releases/download/v${version}/${file}`) {
      throw new Error('Invalid release asset metadata');
    }
  }
  return version;
}

export async function runWindowsUpdate(home, version) {
  if (process.platform !== 'win32' || !stableVersion.test(version || '')) throw new Error('Invalid Windows update request.');
  const script = path.join(home, 'Update.ps1');
  const runtime = path.join(home, 'runtime');
  const statusFile = path.join(runtime, 'update-status.json');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await fs.mkdir(runtime, { recursive: true });
  const log = await fs.open(path.join(runtime, 'update.log'), 'w', 0o600);
  try {
    const worker = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-InstallRoot', home, '-ExpectedVersion', version, '-StatusFile', statusFile], { windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    const [code] = await once(worker, 'exit');
    return code ?? 1;
  } finally { await log.close(); }
}

export function createReleaseUpdater({ appRoot, home, version, installed, fetcher = fetch, spawnProcess = spawn, clock = Date.now, isRunning = processIsRunning }) {
  const statusFile = path.join(home, 'runtime', 'update-status.json');
  const script = path.join(home, 'Update.ps1');
  const unsupported = { status: 'unsupported', currentVersion: version };
  const unavailable = { status: 'unavailable', currentVersion: version, message: '暂时无法检查更新，可继续使用当前版本。' };
  let launching, child, cached, cacheUntil = 0, pendingCheck, resultWithoutReceipt;
  let channel;

  async function repository() {
    if (!installed || !stableVersion.test(version)) return '';
    channel ??= Promise.all([readJson(path.join(appRoot, 'package-info.json')), fs.access(script)])
      .then(([info]) => info.version === version && typeof info.repository === 'string' &&
        repositoryName.test(info.repository) && !['.', '..'].includes(info.repository.split('/')[1]) ? info.repository : '')
      .catch(() => '');
    return channel;
  }

  async function readStatus() {
    const entry = await readJson(statusFile).catch(() => null);
    if (child || launching) return { status: 'running', currentVersion: version, latestVersion: launching || child.version };
    if (resultWithoutReceipt && !(Date.parse(entry?.updatedAt) >= resultWithoutReceipt.startedAt)) {
      return { status: 'failed', currentVersion: version, latestVersion: resultWithoutReceipt.version, message: '更新程序未完成，请重试。' };
    }
    if (typeof entry?.version !== 'string' || !stableVersion.test(entry.version)) return null;
    const base = { currentVersion: version, latestVersion: entry.version };
    const running = entry.status === 'running' && Date.parse(entry.updatedAt) >= clock() - 30 * 60_000 && isRunning(entry.processId);
    if (running) return { status: 'running', ...base };
    if (!isNewer(entry.version, version) && entry.status === 'succeeded') return { status: 'succeeded', ...base };
    if (isNewer(entry.version, version) && ['failed', 'running'].includes(entry.status)) {
      const message = entry.error === 'workbench_busy' ? '工作台正在处理任务，请稍后再更新。' : '更新未完成，请稍后重试。';
      return { status: 'failed', ...base, message };
    }
    return null;
  }

  async function checkLatest(repo) {
    if (cached && clock() < cacheUntil) return cached;
    if (pendingCheck) return pendingCheck;
    pendingCheck = (async () => {
      try {
        const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'ZhaoxuHR-Update' },
          redirect: 'error', signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Release lookup failed');
        const latestVersion = releaseVersion(await response.json(), repo, version);
        cached = latestVersion ? { status: 'available', currentVersion: version, latestVersion } : { status: 'current', currentVersion: version };
      } catch { cached = unavailable; }
      cacheUntil = clock() + (cached.status === 'unavailable' ? 30_000 : CHECK_INTERVAL);
      return cached;
    })();
    try { return await pendingCheck; }
    finally { pendingCheck = null; }
  }

  async function check({ statusOnly = false } = {}) {
    const repo = await repository();
    if (!repo) return unsupported;
    const receipt = await readStatus();
    if (statusOnly || receipt?.status === 'running') return receipt ?? { status: 'current', currentVersion: version };
    return checkLatest(repo);
  }

  async function install(requestedVersion) {
    const repo = await repository();
    if (!repo) throw Object.assign(new Error('当前工作台不支持自动更新。'), { statusCode: 409 });
    if (typeof requestedVersion !== 'string' || !stableVersion.test(requestedVersion)) {
      throw Object.assign(new Error('更新版本无效。'), { statusCode: 400 });
    }
    const update = await checkLatest(repo);
    if (update.status !== 'available' || update.latestVersion !== requestedVersion) {
      throw Object.assign(new Error('新版已变化，请重新检查更新。'), { statusCode: 409 });
    }
    const receipt = await readStatus();
    if (launching || child || receipt?.status === 'running') return readStatus();
    launching = requestedVersion;
    const startedAt = clock();
    try {
      // A detached Node process survives the workbench restart. It keeps the
      // PowerShell installer attached because PowerShell needs a console context.
      const worker = spawnProcess(process.execPath, [path.join(appRoot, 'scripts', 'background-workbench.mjs'),
        '--run-update', requestedVersion], { detached: true, windowsHide: true, stdio: 'ignore' });
      worker.once('exit', () => {
        child = null;
        cacheUntil = 0;
        resultWithoutReceipt = { startedAt, version: requestedVersion };
      });
      await once(worker, 'spawn');
      child = { version: requestedVersion };
      resultWithoutReceipt = null;
      worker.unref();
    } catch {
      throw Object.assign(new Error('未能启动更新程序。'), { statusCode: 503 });
    } finally { launching = null; }
    return { status: 'running', currentVersion: version, latestVersion: requestedVersion };
  }

  return { check, install };
}
