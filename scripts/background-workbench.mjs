import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWorkbench, superviseWorkbench, stopWorkbench } from '../lib/background-service.mjs';
import { APP_ROOT, DEFAULT_CDP_PORT, DEFAULT_WEB_PORT, INSTALLED, WORKSPACE_ROOT as root } from '../lib/runtime-config.mjs';
import fs from 'node:fs/promises';
import { ensureBossBrowser } from '../lib/boss-browser-runtime.mjs';
import { manageWindowsService } from '../lib/windows-task-service.mjs';
import { runWindowsUpdate } from '../lib/release-updates.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const port = Number(process.env.HR_PORT || DEFAULT_WEB_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port >= 9222 && port <= 9266 || [7788, 19222, 19223].includes(port)) throw new Error('HR_PORT 不可占用店铺控制台或浏览器调试端口。');
try {
  if (INSTALLED && process.argv[2] === '--run-update') {
    process.exitCode = await runWindowsUpdate(root, process.argv[3]);
  } else if (INSTALLED && process.argv.includes('--open-boss')) {
    await fs.mkdir(path.join(root, 'boss-chrome'), { recursive: true });
    const result = await ensureBossBrowser({ root, cdpPort: DEFAULT_CDP_PORT });
    if (result.status === 'unavailable') throw new Error(result.message);
    console.log(JSON.stringify(result));
  } else if (process.argv.includes('--supervise')) {
    if (process.argv.includes('--windows-service')) {
      const control=JSON.parse((await fs.readFile(path.join(root,'runtime/windows-service-control.json'),'utf8')).replace(/^\uFEFF/,''));
      if (control.enabled===false) process.exit(0);
    }
    const ensureDependencies=async()=>{
      const state=JSON.parse(await fs.readFile(path.join(root,'data/workspace.json'),'utf8'));
      if (state.settings?.bossOfflineMode===true || state.settings?.inboxAutomation?.enabled===false) return;
      const result=await ensureBossBrowser({root,cdpPort:state.settings?.cdpPort});
      if (result.status==='unavailable') throw new Error(result.message||'BOSS browser unavailable');
    };
    await superviseWorkbench({ root, port, serverFile: path.join(APP_ROOT, 'server.mjs'), ensureDependencies });
  }
  else if (process.argv.includes('--stop-supervisor')) console.log(JSON.stringify(await stopWorkbench(root)));
  else if (INSTALLED && process.argv.includes('--local-service')) {
    console.log(JSON.stringify(process.argv.includes('--stop') ? await stopWorkbench(root) : await launchWorkbench({ root, scriptFile, port })));
  }
  else if (process.platform==='win32') {
    if (INSTALLED) throw new Error('Use the installed launcher to start this copy.');
    if (port!==DEFAULT_WEB_PORT) throw new Error('Windows managed service uses the dedicated HR port 18787.');
    console.log(JSON.stringify(await manageWindowsService({root,action:process.argv.includes('--stop')?'Stop':process.argv.includes('--status')?'Status':'Start'})));
  }
  else if (process.argv.includes('--stop')) console.log(JSON.stringify(await stopWorkbench(root)));
  else console.log(JSON.stringify(await launchWorkbench({ root, scriptFile, port })));
} catch (error) { console.error(error.message); process.exitCode = 1; }
