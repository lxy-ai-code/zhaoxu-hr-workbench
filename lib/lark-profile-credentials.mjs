import { spawn } from 'node:child_process';
import { locateLarkCli, LarkCliError } from './lark-cli.mjs';
import { normalizeLarkConnection } from './lark-context.mjs';

const failure = (code, message, connection, details = {}) => new LarkCliError(message, { code, statusCode: 502, ...(connection ? { feishuConnection: connection } : {}), ...details });

/**
 * Store this named profile through the CLI in the calling service's credential
 * context. No secret enters argv, the environment, temporary files, or logs.
 * CLI v1.0.91 saveAsProfile preserves all other profiles and their ordering:
 * https://github.com/larksuite/cli/blob/v1.0.91/cmd/config/init.go#L193-L256
 * Nonzero exit can follow a successful save when the CLI's later probe fails;
 * callers must verify the resulting app identity and must not retry blindly.
 */
export async function configureLarkProfile({ connection, appSecret } = {}, { spawnImpl = spawn, locateCli = locateLarkCli, timeoutMs = 45000, maxOutputBytes = 1024 * 1024 } = {}) {
  const context = normalizeLarkConnection(connection);
  if (!context.profile || !context.appId) throw failure('invalid_connection', '请先选择独立飞书应用连接。', undefined, { statusCode: 400 });
  if (typeof appSecret !== 'string' || !appSecret.trim() || appSecret.length > 4096 || /[\r\n\0]/.test(appSecret)) throw failure('invalid_credentials', 'App Secret 必须是非空的单行文本。', context, { statusCode: 400 });
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(maxOutputBytes) || maxOutputBytes < 1) throw failure('invalid_request', '凭据配置请求参数无效。', context, { statusCode: 400 });
  let secretBytes = Buffer.from(appSecret.trim() + '\n', 'utf8');
  appSecret = '';
  let executable;
  try { executable = await locateCli(); }
  catch { secretBytes.fill(0); throw failure('profile_cli_unavailable', '无法找到本机飞书 CLI，尚未提交凭据配置。', context); }
  try {
    return await new Promise((resolve, reject) => {
      const args = ['config', 'init', '--name', context.profile, '--app-id', context.appId, '--brand', 'feishu', '--app-secret-stdin'];
      let child, timer, settled = false, outputBytes = 0;
      const changed = { configurationMayHaveChanged: true };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const stop = error => {
        try { child?.stdin?.destroy(); } catch {}
        try { child?.kill(); } catch {}
        finish(error);
      };
      try {
        child = spawnImpl(executable, args, {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
        });
      } catch { finish(failure('profile_spawn_failed', '无法启动飞书凭据配置，尚未确认保存。', context)); return; }
      child.once('error', () => finish(failure('profile_spawn_failed', '飞书凭据配置进程失败；请检查当前服务的 CLI 运行环境。', context, changed)));
      child.once('close', (code, signal) => {
        if (code === 0 && !signal) finish(null, { ok: true, status: 'configured', feishuConnection: context, needsVerification: true, message: '已提交独立飞书应用凭据配置，请继续验证应用身份。' });
        else finish(failure('profile_config_failed', '飞书凭据配置未完成验证；CLI 可能已保存配置，请重新检测应用身份。', context, changed));
      });
      // Drain both pipes without decoding or retaining their contents. Even an
      // unexpected CLI echo or error containing the secret cannot reach logs.
      const discard = chunk => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) stop(failure('profile_output_limit', '飞书凭据配置输出异常，已停止；请重新检测应用身份。', context, changed));
      };
      child.stdout?.on('data', discard);
      child.stderr?.on('data', discard);
      child.stdout?.on('error', () => stop(failure('profile_stream_failed', '飞书凭据配置通信中断，请重新检测应用身份。', context, changed)));
      child.stderr?.on('error', () => stop(failure('profile_stream_failed', '飞书凭据配置通信中断，请重新检测应用身份。', context, changed)));
      child.stdin?.on('error', () => stop(failure('profile_stdin_failed', '无法通过受控管道提交应用凭据，请重新检测应用身份。', context, changed)));
      timer = setTimeout(() => stop(failure('profile_config_timeout', '飞书凭据配置超时，未自动重试；请重新检测应用身份。', context, changed)), timeoutMs);
      if (!child.stdin) { stop(failure('profile_stdin_failed', '无法建立受控凭据输入管道。', context, changed)); return; }
      try { child.stdin.end(secretBytes); }
      catch { stop(failure('profile_stdin_failed', '无法通过受控管道提交应用凭据，请重新检测应用身份。', context, changed)); }
    });
  } finally { secretBytes.fill(0); secretBytes = null; }
}
