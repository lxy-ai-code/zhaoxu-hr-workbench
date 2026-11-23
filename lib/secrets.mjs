import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './store.mjs';

const DEFAULT_FILE = path.join(ROOT, 'data/secrets/model-key.dpapi');
function protectWithWindows(value, decrypt = false) {
  if (process.platform !== 'win32') throw Object.assign(new Error('当前系统请通过 HR_MODEL_API_KEY 环境变量提供密钥；不落盘明文。'), { code: 'secret_storage_unavailable' });
  // Use DPAPI directly: this also works when PowerShell's optional Security
  // cmdlet module cannot autoload in the desktop app's inherited environment.
  const bootstrap = "$ErrorActionPreference='Stop';$null=[Reflection.Assembly]::LoadWithPartialName('System.Security');[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$v=[Console]::In.ReadToEnd();";
  const command = bootstrap + (decrypt
    ? '$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))'
    : '$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($b))');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let timer;
    const fail = () => reject(Object.assign(new Error('无法使用当前 Windows 用户解锁模型密钥，请在原桌面用户环境运行或重新填写密钥。'), { code: 'secret_storage_unavailable' }));
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); fail(); });
    child.on('close', code => { clearTimeout(timer); code === 0 && output.trim() ? resolve(output.trim()) : fail(); });
    timer = setTimeout(() => { child.kill(); fail(); }, 15000);
    child.stdin.on('error', () => {}); child.stdin.end(value);
  });
}

export class SecretStore {
  constructor(file = DEFAULT_FILE, { protect = value => protectWithWindows(value), unprotect = value => protectWithWindows(value, true), environmentKey = () => process.env.HR_MODEL_API_KEY || '' } = {}) { this.file = file; this.protect = protect; this.unprotect = unprotect; this.environmentKey = environmentKey; }
  async saveModelKey(key, baseUrl = '') {
    if (typeof key !== 'string' || !key.trim() || key.length > 12000 || /[\r\n\0]/.test(key)) throw new Error('模型密钥格式无效。');
    const encrypted = await this.protect(JSON.stringify({ key: key.trim(), baseUrl: String(baseUrl).replace(/\/+$/, '') }));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, encrypted, { mode: 0o600 });
  }
  async keyStatus() { let keyStored = false; try { keyStored = (await fs.stat(this.file)).isFile(); } catch {} return { keyStored, environmentKey: Boolean(this.environmentKey()), configured: keyStored || Boolean(this.environmentKey()) }; }
  async getModelKey(baseUrl) { try { const clear = await this.unprotect(await fs.readFile(this.file, 'utf8')); const stored = JSON.parse(clear); if (typeof stored.key !== 'string') throw new Error(); if (baseUrl && stored.baseUrl && stored.baseUrl !== String(baseUrl).replace(/\/+$/, '')) throw Object.assign(new Error('模型服务地址已变化，请重新填写该服务对应的密钥。'), { code: 'model_key_endpoint_mismatch', statusCode: 400 }); return stored.key; } catch (error) { if (error.code === 'ENOENT') return this.environmentKey(); if (error.code === 'model_key_endpoint_mismatch') throw error; throw Object.assign(new Error('当前用户无法解锁已保存的模型密钥，请重新填写。'), { code: 'secret_storage_unavailable', statusCode: 400 }); } }
  async removeModelKey() { await fs.unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return this.keyStatus(); }
}

export async function publicModelSettings(settings, secrets = new SecretStore()) {
  const source = settings.model || {};
  const status = await secrets.keyStatus(); let local = false; try { local = ['127.0.0.1', 'localhost'].includes(new URL(source.baseUrl).hostname); } catch {}
  return { baseUrl: source.baseUrl || '', model: source.model || '', temperature: source.temperature ?? 0.2, maxTokens: source.maxTokens ?? 2500, timeoutMs: source.timeoutMs ?? 60000, jsonMode: source.jsonMode ?? false, tokenParameter: source.tokenParameter || 'max_tokens', ...status, configured: Boolean(source.baseUrl && source.model && (status.configured || local)) };
}
