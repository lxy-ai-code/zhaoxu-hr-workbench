import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export class ModelApiError extends Error {
  constructor(message, code, details = {}) { super(message); this.name = 'ModelApiError'; this.code = code; this.statusCode = 400; Object.assign(this, details); }
}
const problem = (message, code = 'invalid_model_settings', details) => new ModelApiError(message, code, details);
const localNames = new Set(['127.0.0.1', 'localhost']);

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) return /^[23]/i.test(address) && !/^2002:/i.test(address) && !/^3fff:/i.test(address) && !/^2001:0?db8:/i.test(address) && !/^2001:(?:0*:|0?2:|0?10:|0?20:)/i.test(address);
  return false;
}

export function validateModelSettings(input = {}) {
  if (typeof input.baseUrl !== 'string' || !input.baseUrl.trim() || typeof input.model !== 'string' || !input.model.trim()) throw problem('请先配置模型 Base URL 和模型名称。', 'not_configured');
  let url;
  try { url = new URL(input.baseUrl.trim()); } catch { throw problem('模型 Base URL 无效。'); }
  if (url.username || url.password || url.search || url.hash) throw problem('模型地址不能包含用户名、密码、查询参数或片段。');
  const rawAuthority = input.baseUrl.trim().match(/^https?:\/\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? '';
  const rawHost = rawAuthority.replace(/:\d+$/, '');
  const local = localNames.has(url.hostname) && localNames.has(rawHost);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !local)) throw problem('模型服务只允许 HTTPS 公网地址，或明确的 http://127.0.0.1 / http://localhost 本地模型。', 'unsafe_endpoint');
  if (localNames.has(url.hostname) && !local) throw problem('请使用明确的 127.0.0.1 或 localhost 地址。', 'unsafe_endpoint');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!local && ((isIP(host) && !isPublicAddress(host)) || /(?:^|\.)(?:local|localhost|internal|lan|home|intranet)$/.test(host) || !host.includes('.') || /^(?:metadata|instance-data)(?:\.|$)/.test(host))) throw problem('拒绝内网、保留地址或元数据服务地址。', 'unsafe_endpoint');
  const model = input.model.trim();
  if (model.length > 200 || /[\r\n\0]/.test(model)) throw problem('模型名称无效。');
  const temperature = Number(input.temperature ?? 0.2), maxTokens = Number(input.maxTokens ?? 2500), timeoutMs = Number(input.timeoutMs ?? 60000);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw problem('temperature 应为 0–2。');
  if (!Number.isInteger(maxTokens) || maxTokens < 32 || maxTokens > 32000) throw problem('maxTokens 应为 32–32000 的整数。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw problem('timeoutMs 应为 1000–180000 的整数。');
  if (input.jsonMode !== undefined && typeof input.jsonMode !== 'boolean') throw problem('jsonMode 应为布尔值。');
  const baseUrl = url.toString().replace(/\/+$/, '');
  const endpoint = /\/chat\/completions$/.test(url.pathname.replace(/\/+$/, '')) ? baseUrl : `${baseUrl}/chat/completions`;
  const tokenParameter = input.tokenParameter ?? 'max_tokens';
  if (!['max_tokens', 'max_completion_tokens'].includes(tokenParameter)) throw problem('不支持此 token 参数。');
  return { baseUrl, endpoint, model, temperature, maxTokens, timeoutMs, jsonMode: input.jsonMode ?? false, tokenParameter, isLocal: local };
}

async function checkedAddresses(settings, lookupImpl) {
  const url = new URL(settings.endpoint), host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1') return [{ address: host, family: 4 }];
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  const addresses = await lookupImpl(host, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length) throw problem('模型服务域名没有可用地址。', 'model_dns_error', { statusCode: 502 });
  if (addresses.some(item => settings.isLocal ? !['127.0.0.1', '::1'].includes(item.address) : !isPublicAddress(item.address))) throw problem('模型域名解析到内网、保留地址或元数据网络，已拒绝调用。', 'unsafe_endpoint');
  return addresses;
}

function nativeRequest(url, options, addresses) {
  return new Promise((resolve, reject) => {
    const lookup = (hostname, settings, callback) => {
      const filtered = addresses.filter(item => !settings.family || item.family === settings.family);
      const chosen = filtered.length ? filtered : addresses;
      if (settings.all) callback(null, chosen); else callback(null, chosen[0].address, chosen[0].family);
    };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: 'POST', headers: options.headers, lookup, signal: options.signal }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { res.destroy(); req.destroy(problem('模型响应超过 2 MB，已停止读取。', 'model_response_too_large', { statusCode: 502 })); } else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, url: url.toString(), redirected: false, text: async () => Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(options.body);
  });
}
function safeMessage(text, key) {
  let output = String(text ?? '模型服务返回错误。');
  if (key) { output = output.split(key).join('[REDACTED]'); output = output.split(encodeURIComponent(key)).join('[REDACTED]'); }
  return output.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/[\r\n]+/g, ' ').slice(0, 400);
}
function providerProblem(status, body, key) {
  const code = status === 401 || status === 403 ? 'model_auth_error' : status === 429 ? 'model_rate_limited' : 'model_http_error';
  const message = safeMessage(body?.error?.message ?? body?.message ?? `HTTP ${status}`, key);
  return problem(`模型服务返回 HTTP ${status}：${message}`, code, { statusCode: 502, providerStatus: status });
}

export async function callModel({ settings, apiKey = '', systemPrompt, userPrompt, fetchImpl, lookupImpl = dns.lookup } = {}) {
  const config = validateModelSettings(settings);
  if (typeof apiKey !== 'string' || /[\r\n\0]/.test(apiKey)) throw problem('API Key 格式无效。', 'invalid_api_key');
  const key = apiKey.trim();
  if (!key && !config.isLocal) throw problem('请先配置此模型服务的 API Key。', 'not_configured');
  if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string' || !systemPrompt.trim() || !userPrompt.trim()) throw problem('模型分析缺少系统提示词或输入材料。', 'invalid_prompt');
  if (systemPrompt.length + userPrompt.length > 250000) throw problem('本次模型输入超过 250000 字符，请先缩小材料范围。', 'input_too_large');
  const controller = new AbortController();
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(problem('模型调用超时，未自动重试。', 'model_timeout', { statusCode: 504 })); }, config.timeoutMs);
  try {
    return await Promise.race([timeout, (async () => {
      const addresses = await checkedAddresses(config, lookupImpl);
      if (controller.signal.aborted) throw problem('模型调用超时。', 'model_timeout', { statusCode: 504 });
      const body = { model: config.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: config.temperature, [config.tokenParameter]: config.maxTokens, stream: false };
      if (config.jsonMode) body.response_format = { type: 'json_object' };
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
      const requestOptions = { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal };
      const url = new URL(config.endpoint);
      const response = fetchImpl ? await fetchImpl(config.endpoint, requestOptions) : await nativeRequest(url, requestOptions, addresses);
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && new URL(response.url).origin !== url.origin)) throw problem('模型服务发生重定向，已停止，未转发认证信息。', 'model_redirect_rejected', { statusCode: 502 });
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw problem('模型响应超过 2 MB。', 'model_response_too_large', { statusCode: 502 });
      let parsed;
      try { parsed = JSON.parse(raw); } catch { if (!response.ok) throw providerProblem(response.status, null, key); throw problem('模型服务返回的内容不是有效 JSON 响应。', 'model_invalid_response', { statusCode: 502 }); }
      if (!response.ok) throw providerProblem(response.status, parsed, key);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw problem('模型服务返回的 JSON 不是 Chat Completions 对象。', 'model_invalid_response', { statusCode: 502 });
      if (parsed.error || (parsed.code !== undefined && ![0, '0', 200, '200'].includes(parsed.code))) throw problem(`模型服务业务错误：${safeMessage(parsed.error?.message ?? parsed.message, key)}`, 'model_business_error', { statusCode: 502 });
      const choice = parsed.choices?.[0];
      if (choice?.message?.refusal) throw problem('模型拒绝生成本次内容；没有把它标记为已完成分析。', 'model_refused', { statusCode: 502 });
      if (['length', 'content_filter'].includes(choice?.finish_reason)) throw problem('模型输出被截断或过滤，不能当作完整分析。', 'model_incomplete', { statusCode: 502 });
      const content = typeof choice?.message?.content === 'string' ? choice.message.content : Array.isArray(choice?.message?.content) ? choice.message.content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';
      if (!content.trim()) throw problem('模型服务没有返回可读取的消息正文。', 'model_invalid_response', { statusCode: 502 });
      if (config.jsonMode) { try { JSON.parse(content); } catch { throw problem('模型 JSON 模式返回了无效 JSON 内容。', 'model_invalid_json', { statusCode: 502 }); } }
      const usage = parsed.usage && typeof parsed.usage === 'object' ? Object.fromEntries(Object.entries(parsed.usage).filter(([name, value]) => ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens'].includes(name) && Number.isFinite(value))) : undefined;
      const safeContent = key ? content.split(key).join('[REDACTED]') : content;
      return { content: safeContent, model: typeof parsed.model === 'string' ? safeMessage(parsed.model, key).slice(0, 200) : config.model, usage };
    })()]);
  } catch (error) {
    if (error instanceof ModelApiError) throw error;
    if (controller.signal.aborted) throw problem('模型调用超时，未自动重试。', 'model_timeout', { statusCode: 504 });
    throw problem('连接模型服务失败；请检查地址、网络与服务状态。', 'model_network_error', { statusCode: 502 });
  } finally { clearTimeout(timer); }
}

export async function testModelConnection(options = {}) {
  const response = await callModel({ ...options, systemPrompt: '连接测试。只输出 JSON 对象 {"ok":true}，不包含其他内容。', userPrompt: '请返回 JSON 连接测试结果。' });
  return { status: 'connected', message: '模型接口已返回有效消息；连接测试成功。', model: response.model, usage: response.usage };
}
