// GM_* 能力薄封装(把脚本对 GM API 的依赖收口, 便于将来替换/测试)。
// 运行时若某 GM API 缺失(如非油猴环境调试), 提供降级或明确报错。

// node/单元测试里没有 window: 用 globalThis 兜底, 保证本模块可被纯逻辑模块 import 而不炸
const G = typeof globalThis !== "undefined" ? globalThis : {};
const safeWin = () => {
  try {
    return typeof window !== "undefined" ? window : G.window || {};
  } catch (e) {
    return {};
  }
};

export const gm = {
  xmlhttpRequest: typeof GM_xmlhttpRequest !== "undefined" ? GM_xmlhttpRequest : null,
  getValue: typeof GM_getValue !== "undefined" ? GM_getValue : null,
  setValue: typeof GM_setValue !== "undefined" ? GM_setValue : null,
  getResourceText: typeof GM_getResourceText !== "undefined" ? GM_getResourceText : null,
  info: typeof GM_info !== "undefined" ? GM_info : null,
  addStyle: typeof GM_addStyle !== "undefined" ? GM_addStyle : null,
  setClipboard: typeof GM_setClipboard !== "undefined" ? GM_setClipboard : null,
  unsafeWindow: typeof unsafeWindow !== "undefined" ? unsafeWindow : safeWin(),
};

/**
 * 基于 GM_xmlhttpRequest 的请求(Promise 化), 返回响应原文。
 * 没有 GM_xmlhttpRequest 时(调试注入 / 管理器不给这个 API)退回 fetch:
 * 127.0.0.1 属"可信来源", https 页面直接 fetch 不会被混合内容拦(2026-11-10 实测)。
 * 讨论区要读 HTML 页面(拿 urlToken)和 urlencoded 回包, 所以拆出这一层; JSON 走 gmFetchJson。
 * @returns {Promise<string>} 响应文本
 */
export function gmFetchText(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!gm.xmlhttpRequest) {
    const timeout = options.timeout || 15000;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
    return fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: ctl ? ctl.signal : undefined,
    })
      .then((r) => r.text())
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }
  return new Promise((resolve, reject) => {
    gm.xmlhttpRequest({
      url,
      method: options.method || "GET",
      headers,
      data: options.body,
      timeout: options.timeout || 15000,
      onload: (response) => resolve(String(response.responseText || "")),
      onerror: () => reject(new Error(`请求失败: ${url}`)),
      ontimeout: () => reject(new Error(`请求超时: ${url}`)),
    });
  });
}

/**
 * 同上, 但把响应解析成 JSON。
 * @returns {Promise<any>} 解析后的 JSON
 */
export function gmFetchJson(url, options = {}) {
  return gmFetchText(url, options).then((text) => {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`非 JSON 响应: ${String(text).slice(0, 80)}`);
    }
  });
}

/** sleep 毫秒 */
export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取用户设置(GM 存 JSON), 无则默认 */
export function readSetting(key, fallback) {
  try {
    if (!gm.getValue) return fallback;
    const raw = gm.getValue(key);
    return raw === undefined || raw === null || raw === "" ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

/** 写用户设置 */
export function writeSetting(key, value) {
  try {
    if (gm.setValue) gm.setValue(key, JSON.stringify(value));
  } catch (e) {
    /* ignore */
  }
}
