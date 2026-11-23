import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const readJson = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export async function inspectWorkbench(port, fetcher = fetch) {
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
    const body = await response.json().catch(() => null);
    const installId = process.env.HR_HOME ? process.env.HR_INSTALL_ID : undefined;
    if (response.ok && body?.ok === true && body.service === '招序 HR' && (!installId || body.installId === installId)) return true;
    throw new Error(`端口 ${port} 有其他响应，未启动或停止该端口的进程。`);
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') return false;
    throw error;
  }
}

export async function acquireServiceLock(runtimeDir, { pid = process.pid, isAlive = alive } = {}) {
  await fs.mkdir(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, 'background-service.lock.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      const owner = { pid, nonce: randomUUID(), startedAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(owner)); await handle.close();
      return { ...owner, async release() { const current = await readJson(file); if (current?.nonce === owner.nonce) await fs.unlink(file); } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another starter may still be writing its short lock record.
      let previous; try { previous = await readJson(file); } catch { await delay(100); return null; }
      if (!previous || isAlive(previous.pid)) return null;
      await fs.unlink(file);
    }
  }
  return null;
}

export async function superviseWorkbench({ root, runtimeDir = path.join(root, 'runtime'), port = 18787, serverFile = path.join(root, 'server.mjs'), restartDelayMs = 3000, pollMs = 1000, ensureDependencies } = {}) {
  const lock = await acquireServiceLock(runtimeDir); if (!lock) return;
  const stopFile = path.join(runtimeDir, 'background-stop.json'), statusFile = path.join(runtimeDir, 'background-service.json');
  let child = null, stopping = false, restarts = 0, timer, polling = false, dependencyPending = null, dependencyError = '', finalState = 'stopped';
  const log = async event => fs.appendFile(path.join(runtimeDir, 'background-service.log'), `${new Date().toISOString()} ${event}\n`);
  let statusTail=Promise.resolve();
  const status = state => {
    const snapshot=JSON.stringify({supervisorPid:process.pid,childPid:child?.pid||null,port,state,restarts,dependencyError:dependencyError||null,checkedAt:new Date().toISOString()},null,2);
    statusTail=statusTail.catch(()=>{}).then(async()=>{const temporary=`${statusFile}.${process.pid}.${randomUUID()}.tmp`;try{await fs.writeFile(temporary,snapshot,{mode:0o600});await fs.rename(temporary,statusFile);}finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}});
    return statusTail;
  };
  // Dependency recovery is best effort: a missing browser must not take the
  // HTTP workbench down. The loop and timer share one check to avoid opening
  // several dependency processes while a slow recovery is still in progress.
  const checkDependencies = () => {
    if (typeof ensureDependencies !== 'function' || stopping) return Promise.resolve();
    if (dependencyPending) return dependencyPending;
    dependencyPending = Promise.resolve().then(() => ensureDependencies({ root, port })).then(async () => {
      if (dependencyError) await log('dependency_recovered');
      dependencyError = '';
    }).catch(async error => {
      const detail = String(error?.message || 'Dependency check failed').slice(0, 1000);
      if (detail !== dependencyError) {
        dependencyError = detail;
        console.error(`后台依赖恢复未完成：${detail}`);
        await log(`dependency_error ${JSON.stringify({ message: detail })}`).catch(() => {});
      }
    }).finally(() => { dependencyPending = null; });
    return dependencyPending;
  };
  const stop = () => { stopping = true; if (child) child.kill(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  timer = setInterval(async () => {
    if (polling) return; polling = true;
    try { const request = await readJson(stopFile); if (request?.nonce === lock.nonce) stop(); if (!stopping) await checkDependencies(); if (child && !stopping) await status(await inspectWorkbench(port) ? 'running' : 'starting'); }
    catch {} finally { polling = false; }
  }, pollMs);
  try {
    await log('supervisor_started');
    while (!stopping) {
      await checkDependencies();
      if (stopping) break;
      if (await inspectWorkbench(port)) { await status('existing_service'); await delay(pollMs); continue; }
      const out = openSync(path.join(runtimeDir, 'server.log'), 'a', 0o600);
      try { child = spawn(process.execPath, [serverFile], { cwd: root, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, HR_PORT: String(port) } }); } finally { closeSync(out); }
      const exited = new Promise(resolve => { child.once('error', error => resolve({ error: error.code || error.message })); child.once('exit', (code, signal) => resolve({ code, signal })); });
      await status('starting');
      const exit = await exited;
      child = null;
      await log(`server_exit ${JSON.stringify(exit)}`);
      if (!stopping) { restarts++; await status('restarting'); await delay(restartDelayMs); }
    }
  } catch (error) {
    finalState = 'failed';
    const detail = String(error?.message || 'Supervisor failed').slice(0, 1000);
    console.error(`后台守护退出：${detail}`);
    await log(`supervisor_error ${JSON.stringify({ message: detail, code: error?.code || null })}`).catch(() => {});
    throw error;
  } finally {
    clearInterval(timer); if (child) child.kill();
    await status(finalState).catch(error => console.error(`后台状态写入失败：${error.message}`));
    await log(`supervisor_${finalState}`).catch(error => console.error(`后台日志写入失败：${error.message}`));
    await lock.release();
    const request = await readJson(stopFile); if (request?.nonce === lock.nonce) await fs.unlink(stopFile);
  }
}

export async function launchWorkbench({ root, scriptFile, port = 18787, waitMs = 15000 } = {}) {
  const runtimeDir = path.join(root, 'runtime'); await fs.mkdir(runtimeDir, { recursive: true });
  if (await inspectWorkbench(port)) return { status: 'running', url: `http://127.0.0.1:${port}` };
  const out = openSync(path.join(runtimeDir, 'background-service.log'), 'a', 0o600);
  let processHandle;
  try { processHandle = spawn(process.execPath, [scriptFile, '--supervise'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, HR_PORT: String(port) } }); } finally { closeSync(out); }
  let launchError; processHandle.once('error', error => { launchError = error; }); processHandle.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (await inspectWorkbench(port)) return { status: 'started', url: `http://127.0.0.1:${port}` };
    await delay(250);
  }
  throw new Error('后台未在预期时间内就绪，请检查 runtime/server.log 与 runtime/background-service.log。');
}

export async function stopWorkbench(root) {
  const runtimeDir = path.join(root, 'runtime'), file = path.join(runtimeDir, 'background-service.lock.json');
  const owner = await readJson(file); if (!owner || !alive(owner.pid)) return { status: 'not_running' };
  await fs.writeFile(path.join(runtimeDir, 'background-stop.json'), JSON.stringify({ nonce: owner.nonce, requestedAt: new Date().toISOString() }), { mode: 0o600 });
  for (let i = 0; i < 60; i++) { if (!(await readJson(file))) return { status: 'stopped' }; await delay(250); }
  throw new Error('后台尚未停止，请检查运行日志。');
}
