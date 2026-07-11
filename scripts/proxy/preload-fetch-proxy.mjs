// scripts/proxy/preload-fetch-proxy.mjs
// Node.js --require 预加载脚本：劫持 globalThis.fetch，将 Pi 对 LLM Provider 的 API 请求
// 重定向到本地代理（provider-proxy），实现零运行时侵入的热切换。
//
// 用法：
//   set NODE_OPTIONS="--require %cd%\scripts\proxy\preload-fetch-proxy.mjs"
//   node start-pi.js
//
// 或 start.bat 中：
//   set NODE_OPTIONS=--require "C:\...\preload-fetch-proxy.mjs"
//   call node ...
//
// 劫持规则：
//   - api.deepseek.com → http://127.0.0.1:18880
//   - token.sensenova.cn → http://127.0.0.1:18880
//   - apihub.agnes-ai.com → http://127.0.0.1:18880
//   - 其他请求不修改

const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:18880";

// 需要劫持的 Provider 域名列表
const TARGET_HOSTS = new Set([
  "api.deepseek.com",
  "token.sensenova.cn",
  "apihub.agnes-ai.com",
]);

const originalFetch = globalThis.fetch;

globalThis.fetch = async function proxyFetch(url, opts = {}) {
  if (typeof url === "string") {
    try {
      const parsed = new URL(url);
      if (TARGET_HOSTS.has(parsed.hostname)) {
        const proxyUrl = url.replace(parsed.origin, PROXY_URL);
        // 注入原始目标 host header，供 proxy 识别
        const headers = { ...(opts.headers || {}), "X-Original-Host": parsed.host };
        return originalFetch(proxyUrl, { ...opts, headers });
      }
    } catch {
      // 非 URL 字符串（如 Request 对象），交给原始 fetch
    }
  }
  return originalFetch(url, opts);
};

// console.log(`[preload] fetch 已劫持: ${[...TARGET_HOSTS].join(", ")} → ${PROXY_URL}`);
