import { createHash } from 'node:crypto';
import { LarkCliError } from './lark-cli.mjs';

// An omitted connection preserves the original user adapter for existing callers.
// An explicitly configured connection must be complete and never falls back.
export function normalizeLarkConnection(connection) {
  if (connection === undefined) return { identity: 'user' };
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new LarkCliError('飞书连接配置无效。', { code: 'invalid_connection', statusCode: 400 });
  const profile = typeof connection.profile === 'string' ? connection.profile.trim() : '';
  const appId = typeof connection.appId === 'string' ? connection.appId.trim() : '';
  const identity = connection.identity;
  const tenantKey = typeof connection.tenantKey === 'string' ? connection.tenantKey.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile) || !/^cli_[A-Za-z0-9]+$/.test(appId) || !['bot', 'user'].includes(identity) || (tenantKey && !/^[A-Za-z0-9_-]{1,200}$/.test(tenantKey))) throw new LarkCliError('飞书连接必须包含有效的独立 profile、应用 ID 和明确的 bot/user 身份。', { code: 'invalid_connection', statusCode: 400 });
  return { profile, identity, appId, ...(tenantKey ? { tenantKey } : {}) };
}

export function sameLarkConnection(left, right) {
  const legacy = value => value?.identity === 'user' && !value.profile && !value.appId && !value.tenantKey;
  try {
    const a = normalizeLarkConnection(legacy(left) ? undefined : left), b = normalizeLarkConnection(legacy(right) ? undefined : right);
    return ['profile', 'identity', 'appId', 'tenantKey'].every(key => (a[key] ?? '') === (b[key] ?? ''));
  } catch (error) { if (error.code === 'invalid_connection') return false; throw error; }
}

export function larkConnectionKey(connection) {
  return createHash('sha256').update(JSON.stringify(normalizeLarkConnection(connection))).digest('hex').slice(0, 24);
}

export function larkArguments(args, connection, { identity = true } = {}) {
  const context = normalizeLarkConnection(connection);
  if (args.some(arg => arg === '--profile' || arg.startsWith('--profile=') || arg === '--as' || arg.startsWith('--as='))) throw new LarkCliError('飞书调用身份只能由当前工作台连接配置指定。', { code: 'connection_argument_conflict' });
  return [...args, ...(context.profile ? ['--profile', context.profile] : []), ...(identity ? ['--as', context.identity] : [])];
}

export function larkErrorStatus(error) {
  const code = String(error?.code ?? '').toLowerCase();
  if (/scope/.test(code) || error?.missingScopes?.length) return 'permission_required';
  if (/permission|forbidden|access_denied|resource_access/.test(code)) return 'resource_forbidden';
  if (/unsupported.*identity|identity.*unsupported/.test(code)) return 'identity_unsupported';
  if (/auth|token|credential/.test(code)) return 'need_auth';
  if (['not_installed', 'invalid_connection'].includes(code)) return 'not_configured';
  return 'error';
}

export function withLarkErrorContext(error, connection) {
  if (error && typeof error === 'object') {
    const status = larkErrorStatus(error);
    if (!error.status && status !== 'error') error.status = status;
    error.feishuConnection = normalizeLarkConnection(connection);
  }
  return error;
}
