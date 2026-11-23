import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectWorkbench, stopWorkbench } from './background-service.mjs';

export const WINDOWS_TASK_NAME = 'ZhaoxuHR-Workbench';
const execute = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const xmlEscape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const xmlDecode = value => String(value).replace(/&(amp|lt|gt|quot|apos);/g, (all, key) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[key]));
const tag = (xml, name) => xmlDecode(xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] || '');
export function decodeWindowsTaskOutput(buffer) {
  if(!Buffer.isBuffer(buffer))return String(buffer || '');
  if(buffer[0]===255&&buffer[1]===254)return buffer.subarray(2).toString('utf16le');
  if(buffer[1]===0)return buffer.toString('utf16le');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer);}
  // This host's schtasks pipe uses CP936 even though its XML declares UTF-16.
  // Never replace undecodable path characters and then weaken ownership checks.
  catch{return new TextDecoder('gb18030',{fatal:true}).decode(buffer);}
}
const decode=decodeWindowsTaskOutput;
export function windowsTaskEnabled(xml) { const settings=xml?.match(/<Settings>([\s\S]*?)<\/Settings>/)?.[1]; return settings!==undefined && (tag(settings,'Enabled') || 'true') === 'true'; }

export function windowsTaskCommand({root,nodePath,powerShellPath}) {
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const command = `& ${quote(nodePath)} ${quote(path.join(root,'scripts/background-workbench.mjs'))} --supervise --windows-service; exit $LASTEXITCODE`;
  return {execute:powerShellPath,arguments:`-NoProfile -NonInteractive -WindowStyle Hidden -Command "${command}"`,workingDirectory:root};
}
export function buildWindowsTaskXml({root,nodePath,powerShellPath,userSid,startBoundary}) {
  if (!/^S-1-5-(?:\d+-)*\d+$/.test(userSid)) throw new Error('A verified current-user SID is required.');
  const action=windowsTaskCommand({root,nodePath,powerShellPath}),e=xmlEscape;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>${e(`Zhaoxu HR background supervisor. Source: ${root}`)}</Description></RegistrationInfo>
<Triggers><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${e(startBoundary)}</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Enabled>true</Enabled><UserId>${e(userSid)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${e(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>${e(action.execute)}</Command><Arguments>${e(action.arguments)}</Arguments><WorkingDirectory>${e(action.workingDirectory)}</WorkingDirectory></Exec></Actions></Task>`;
}
export function assertOwnedWindowsTask(xml,options) {
  const expected=windowsTaskCommand(options);
  // Native Task Scheduler export omits its default LeastPrivilege and Enabled=true.
  if(tag(xml,'Command')!==expected.execute || tag(xml,'Arguments')!==expected.arguments || tag(xml,'WorkingDirectory')!==expected.workingDirectory || tag(xml,'UserId')!==options.userSid || tag(xml,'LogonType')!=='InteractiveToken' || (tag(xml,'RunLevel') || 'LeastPrivilege')!=='LeastPrivilege') throw new Error('The existing Windows task is not owned by this workbench and current user; it was not changed.');
  return true;
}

/** Uses the native Task Scheduler CLI, without changing PowerShell script policy
 * or storing passwords. The task waits for its supervisor in the user's session. */
export async function manageWindowsService({root,action='Start',nodePath=process.execPath,env=process.env}={}) {
  if(process.platform!=='win32')throw new Error('Windows managed service is only available on this Windows host.');
  const system=path.join(env.WINDIR||'C:\\Windows','System32'),scheduler=path.join(system,'schtasks.exe'),powerShellPath=path.join(system,'WindowsPowerShell/v1.0/powershell.exe');
  const command=async(args,allowMissing=false)=>{
    try{return decode((await execute(scheduler,args,{windowsHide:true,timeout:20000,encoding:'buffer'})).stdout);}
    catch(error){if(allowMissing&&error.code===1)return null;throw new Error(`Windows Task Scheduler operation failed (${error.code || 'unknown'}). ${decode(error.stderr).slice(0,500)}`);}
  };
  const identity=await execute(path.join(system,'whoami.exe'),['/user','/fo','csv','/nh'],{windowsHide:true,encoding:'buffer'});
  const userSid=decode(identity.stdout).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
  if(!userSid)throw new Error('The current Windows user SID could not be verified.');
  const options={root,nodePath,powerShellPath,userSid};
  let existing=await command(['/Query','/TN',WINDOWS_TASK_NAME,'/XML'],true);
  if(existing)assertOwnedWindowsTask(existing,options);
  const runtime=path.join(root,'runtime');await fs.mkdir(runtime,{recursive:true});
  const save=async state=>fs.writeFile(path.join(runtime,'windows-service.json'),JSON.stringify({taskName:WINDOWS_TASK_NAME,host:'windows_task_scheduler',userSid,sourceRoot:root,nodePath,state,recoveryIntervalSeconds:60,checkedAt:new Date().toISOString()},null,2));
  const control=async enabled=>fs.writeFile(path.join(runtime,'windows-service-control.json'),JSON.stringify({enabled,updatedAt:new Date().toISOString()}),{mode:0o600});
  if(action==='Status')return {taskName:WINDOWS_TASK_NAME,status:existing?'installed':'not_installed',enabled:existing?windowsTaskEnabled(existing):false};
  if(action==='Stop'){
    await control(false);if(existing)await command(['/Change','/TN',WINDOWS_TASK_NAME,'/DISABLE']);
    try{await stopWorkbench(root);}catch{if(existing)await command(['/End','/TN',WINDOWS_TASK_NAME]);}
    await save('disabled');return {status:'stopped',host:'windows_task_scheduler',taskName:WINDOWS_TASK_NAME};
  }
  if(action!=='Start')throw new Error('Unknown Windows service action.');
  await inspectWorkbench(18787); // Reject a different HTTP service before changing the task.
  await control(true);
  if(!existing){
    const xmlFile=path.join(runtime,'windows-task.xml');
    const xml=buildWindowsTaskXml({...options,startBoundary:new Date(Date.now()+60000).toISOString()});
    await fs.writeFile(xmlFile,Buffer.concat([Buffer.from([255,254]),Buffer.from(xml,'utf16le')]),{mode:0o600});
    await command(['/Create','/TN',WINDOWS_TASK_NAME,'/XML',xmlFile]);
  }else await command(['/Change','/TN',WINDOWS_TASK_NAME,'/ENABLE']);
  await command(['/Run','/TN',WINDOWS_TASK_NAME]);
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){if(await inspectWorkbench(18787)){await save('running');return {status:'running',host:'windows_task_scheduler',taskName:WINDOWS_TASK_NAME,url:'http://127.0.0.1:18787'};}await delay(250);}
  await save('starting');throw new Error('The Windows task was registered but HR is not ready; check runtime/background-service.log and runtime/server.log.');
}
