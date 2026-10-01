/**
 * Provider 错误人话化 —— 把服务商 HTTP 错误 / 超时 / 网络失败映射成用户能看懂的
 * 中文 message + 稳定的 errorCode 枚举，供 llm-service / vision-service（及 SW 连接测试）共用。
 *
 * errorCode 枚举（与展示端 content/options 的 i18n 文案表对齐）：
 *   config · auth(401/403) · pay(402) · rate(429) · notFound(404) · timeout · network · server(5xx) · noVlm
 * 展示端按 code 取本地化文案；未知/无 code 时回退显示本 message。
 * 原始响应体 / 底层异常降级到 console.warn，保留排障能力。
 */

/** errorCode → 人话中文 message（单一真值）。 */
const MESSAGES = {
  config: '服务商配置不完整，请到设置检查 API 密钥、模型和 Base URL。',
  auth: 'API 密钥无效或已过期，请到设置检查当前服务商的密钥。',
  pay: '服务商余额不足或账户受限，请检查服务商账户。',
  rate: '请求过于频繁或触发服务商限流，请稍后重试。',
  notFound: '模型不存在或接口地址不对，请到设置检查模型名与 Base URL。',
  server: '服务商服务异常，请稍后重试。',
  timeout: '请求超时，请检查网络后重试。',
  network: '网络连接失败，请检查网络后重试。',
  noVlm: '当前服务商未配置视觉模型：图像/视频反推需要在 API 管理器为它添加视觉（VLM）模型。'
};

/** 本地 provider 配置缺失时的统一 Error（.code='config'）。 */
export function configError(message = MESSAGES.config) {
  const e = new Error(message);
  e.code = 'config';
  return e;
}

/** HTTP 状态码 → errorCode。未命中且 <500 返回 undefined（展示端回退到 message）。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'pay';
  if (status === 429) return 'rate';
  if (status === 404) return 'notFound';
  if (status >= 500) return 'server';
  return undefined;
}

/**
 * 由 HTTP 响应状态构造人话 Error（挂 .code）。原始响应体降级 console.warn，不进 message。
 * @param {number} status HTTP 状态码
 * @param {string} [rawText] 原始响应体（仅用于调试日志）
 * @param {string} [label] 日志前缀（如 'provider' / 'vision provider'）
 * @returns {Error}
 */
export function httpStatusError(status, rawText = '', label = 'provider') {
  console.warn('[HyperPrompt] ' + label + ' error', status, rawText);
  const code = codeForStatus(status);
  const e = new Error(MESSAGES[code] || '请求失败，请检查设置或稍后重试。');
  if (code) e.code = code;
  e.status = status;
  return e;
}

/**
 * 归一化请求异常（fetch catch 用）：
 *   - AbortError（超时中止）→ timeout
 *   - fetch TypeError（DNS / 断网 / 连接被拒）→ network
 *   - 其余（含已带 .code 的 httpStatusError / noVlmError）→ 原样返回，保留其 code
 * @param {any} error
 * @returns {Error}
 */
export function normalizeRequestError(error) {
  if (error && error.name === 'AbortError') {
    const e = new Error(MESSAGES.timeout);
    e.code = 'timeout';
    return e;
  }
  if (error instanceof TypeError) {
    console.warn('[HyperPrompt] network error', error && error.message);
    const e = new Error(MESSAGES.network);
    e.code = 'network';
    return e;
  }
  return error;
}

/** 未配置视觉模型（VLM）时的统一 Error（.code='noVlm'）。 */
export function noVlmError() {
  const e = new Error(MESSAGES.noVlm);
  e.code = 'noVlm';
  return e;
}
