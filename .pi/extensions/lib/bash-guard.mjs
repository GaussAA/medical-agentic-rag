/**
 * bash 命令护栏 —— 纯函数库（P0 加固）
 *
 * 背景：2026-07-11 会话事故中，AI 检索失效后降级到 `bash`，执行
 *       `find / -maxdepth 5` 从根目录全盘扫描，悬停约 16 分钟直至用户手动终止。
 *       根因链见 docs/session-stall-analysis-2026-07-11.md。
 *
 * 本库提供三个纯函数，供 .pi/extensions/bash-guard.ts 组装护栏，
 * 同时可被原生 node 直接 import 做单测（双可测纪律）：
 *   - normalizeBashParams：兼容 对象 / JSON字符串 / 嵌套 arguments 三种入参形态
 *   - resolveTimeoutSec  ：未传→默认；超上限→夹紧。杜绝「无超时→无限卡死」
 *   - assessCommand      ：危险命令判定（全盘扫描 / 幻觉路径 / 根目录递归）
 *
 * 无副作用、无 I/O，可安全被 jiti(扩展) 与 node(单测) 双加载。
 */

// 模型未显式指定超时时的兜底值（秒）。agent 运行时 bash 应为轻量操作。
export const DEFAULT_TIMEOUT_SEC = 60;
// 允许的最大超时（秒）。防止模型传入超大值变相绕过护栏（事故是 960s）。
export const MAX_TIMEOUT_SEC = 300;

/**
 * 归一化工具入参。
 * Pi 在某些情况下会把参数传成 JSON 字符串或包在 { arguments } 里
 *（guide-finder 同源缺陷已验证），故此处统一抽取 { command, timeout }。
 * @param {unknown} params
 * @returns {{ command: string, timeout: unknown }}
 */
export function normalizeBashParams(params) {
  let p = params;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { p = { command: p }; }
  }
  if (p && typeof p === "object" && typeof p.arguments === "string") {
    try { p = JSON.parse(p.arguments); } catch { /* 保持原样 */ }
  } else if (p && typeof p === "object" && p.arguments && typeof p.arguments === "object") {
    p = p.arguments;
  }
  const command = ((p && p.command) || "").toString();
  const timeout = p && typeof p === "object" ? p.timeout : undefined;
  return { command, timeout };
}

/**
 * 解析最终超时（秒）。
 * @param {unknown} userTimeout 模型传入的 timeout（秒），可能为 undefined / 非法 / 超限
 * @returns {number} 有效超时秒数（DEFAULT_TIMEOUT_SEC ~ MAX_TIMEOUT_SEC）
 */
export function resolveTimeoutSec(userTimeout) {
  const n = Number(userTimeout);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  if (n > MAX_TIMEOUT_SEC) return MAX_TIMEOUT_SEC;
  return n;
}

/**
 * 危险命令判定。
 * 目标：杜绝 agent 降级到 shell 爬文件系统（尤其根/系统目录递归扫描），
 *       以及触碰模型幻觉路径。命中即拒绝执行。
 * @param {string} rawCommand
 * @returns {{ blocked: boolean, category?: string, reason?: string }}
 */
export function assessCommand(rawCommand) {
  const norm = (rawCommand || "").toString().replace(/\s+/g, " ").trim();
  if (!norm) return { blocked: false };

  /** @type {{category:string, re:RegExp, reason:string}[]} */
  const rules = [
    // 1) 从裸根 `/` 递归扫描 —— 16 分钟卡死的直接元凶
    {
      category: "fs-scan-root",
      re: /\bfind\s+\/(\s|$)/,
      reason: "禁止从根目录 `/` 递归扫描文件系统（find /）——会全盘遍历导致长时间卡死。",
    },
    // 2) 扫描系统级目录（/mnt、/usr、/etc 等）
    {
      category: "fs-scan-system",
      re: /\bfind\s+\/(mnt|usr|etc|sys|proc|dev|var|root|home|bin|lib|opt)(\b|\/)/,
      reason: "禁止递归扫描系统级目录（/mnt、/usr、/etc、/home 等）。",
    },
    // 3) 从盘符根（C:\ / c:/）递归扫描
    {
      category: "fs-scan-root",
      re: /\bfind\s+[a-zA-Z]:[\\/](\s|$)/,
      reason: "禁止从盘符根（如 C:\\）递归扫描整个磁盘。",
    },
    // 4) 从家目录 `~` 递归扫描
    {
      category: "fs-scan-home",
      re: /\bfind\s+~(\s|$|\/)/,
      reason: "禁止从家目录 `~` 递归全盘扫描。",
    },
    // 5) 幻觉路径（本环境不存在，模型编造，历史事故起点）
    {
      category: "phantom-path",
      re: /\/mnt\/data(\/|\b)/,
      reason: "路径 /mnt/data 在本环境不存在（模型幻觉路径）。请勿翻文件系统检索知识库。",
    },
    // 6) 对根目录递归 grep / ls
    {
      category: "fs-scan-root",
      re: /\bgrep\s+-[a-z]*r[a-z]*\b[^|;&]*\s\/(\s|$)/,
      reason: "禁止对根目录 `/` 递归 grep。",
    },
    {
      category: "fs-scan-root",
      re: /\bls\s+-[a-z]*R[a-z]*\b[^|;&]*\s\/(\s|$)/,
      reason: "禁止对根目录 `/` 递归 ls。",
    },
  ];

  for (const r of rules) {
    if (r.re.test(norm)) {
      return { blocked: true, category: r.category, reason: r.reason };
    }
  }
  return { blocked: false };
}
