// scripts/proxy/undici-proxy-init.mjs
// Node --import 预加载脚本：为 undici 全局注入代理（Node 原生 fetch 不走 HTTP_PROXY，
// 用 undici ProxyAgent 解决）。与 preload-fetch-proxy.mjs 同族（后者劫持 fetch 到本地
// provider 代理；本文件是让 undici 出网走系统代理，供模型下载等场景）。
//
// 用途：
//   1. Pi 模型数据 hydrate：node --import scripts/proxy/undici-proxy-init.mjs \
//        packages/ai/scripts/generate-models.ts --strict --data-only
//   2. 其他需要 Node fetch 走代理的构建/下载任务
//
// 用法：
//   node --import "file://$ROOT/scripts/proxy/undici-proxy-init.mjs" <script>
// 环境变量：
//   PROXY_URL  (默认 http://127.0.0.1:7897，verge-mihomo 本地代理)

import { setGlobalDispatcher, ProxyAgent } from "undici";
const proxy = process.env.PROXY_URL || "http://127.0.0.1:7897";
setGlobalDispatcher(new ProxyAgent(proxy));
console.log(`[proxy-init] undici 全局代理注入: ${proxy}`);
