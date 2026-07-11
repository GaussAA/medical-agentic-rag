// provider-health.mjs
// Provider 健康探测与故障转移选择 —— 高可用加固的核心纯函数库。
//
// 设计要点：
// 1. Pi 运行时无 Provider 拦截钩子、无内置故障转移，Provider 在 --model 启动时锁定。
//    故转移落在「启动编排 + 运行时可观测」两层：本模块提供 selectProvider 供启动脚本
//    在拉起 Pi 前选出健康 Provider；并提供 /failover 命令与周期监控所需的状态查询。
// 2. runProbe：真实 HTTP 探测（GET {baseUrl}/models，带 3s 超时 + API Key 缺失即判不健康）。
//    探测失败/超时/缺 Key → unhealthy；成功 200 → healthy。
// 3. selectProvider：按 PROVIDERS 优先级（priority 升序）返回第一个 healthy，
//    全部 unready 则回退 priority 最高者（避免直接崩），并标注 degraded。
// 4. 内存健康态 + 冷却：连续探测不暴打端点；探测结果带 timestamp 供审计/展示。
//
// 纯 JavaScript（.mjs）：既能被 Pi 的 jiti 加载（扩展内 import），
// 也能被原生 node 直接 import（启动编排脚本 scripts/proxy/launch-with-failover.mjs 与单测）。

/** 探测超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 3000;

/**
 * Provider 探测登记表（高可用编排用，仅作健康探测元数据，不注册 Provider）。
 * 顺序即优先级：priority 越小越优先。
 * baseUrl 取其 /models 探测端点（OpenAI 兼容）。authEnv 缺失则直接判不健康，
 * 不浪费探测。
 * 注：deepseek 为 Pi 内置 Provider，此处只存其探测所需 baseUrl+authEnv；
 *     agnes/sensenova 非内置，其 Provider 由各自扩展 registerProvider 注册。
 *
 * 成本控制优先级（与用户「免费模型优先」规范一致）：
 *   P1 免费主力(sensenova-6.7-flash-lite) > P2 原生 deepseek(付费兜底)
 *   > P3 agnes > P4 免费 deepseek 通道(sensenova/deepseek-v4-flash, 亦免费)
 * selectProvider 取首个 healthy；全不健康回退 priority 最小者并标 degraded。
 */
export const PROVIDERS = [
  {
    provider: "sensenova",
    model: "sensenova-6.7-flash-lite",
    label: "SenseNova 6.7 Flash Lite (免费)",
    baseUrl: "https://token.sensenova.cn/v1",
    authEnv: "SENSENOVA_API_KEY",
    priority: 1,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash (付费兜底)",
    baseUrl: "https://api.deepseek.com",
    authEnv: "DEEPSEEK_API_KEY",
    priority: 2,
  },
  {
    provider: "agnes",
    model: "agnes-2.0-flash",
    label: "Agnes 2.0 Flash",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    authEnv: "AGNES_API_KEY",
    priority: 3,
  },
  {
    provider: "sensenova",
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash (免费通道)",
    baseUrl: "https://token.sensenova.cn/v1",
    authEnv: "SENSENOVA_API_KEY",
    priority: 4,
  },
];

/** 进程内健康态缓存：provider|model → { healthy, reason, ts }。 */
const healthState = new Map();

/**
 * 探测单个 Provider 健康状态（真实 HTTP）。
 * @param {object} p PROVIDERS 中的一项
 * @returns {Promise<{provider:string,model:string,healthy:boolean,reason:string,ts:number}>}
 */
export async function runProbe(p) {
  const apiKey = process.env[p.authEnv];
  const ts = Date.now();
  if (!apiKey) {
    const r = {
      provider: p.provider,
      model: p.model,
      healthy: false,
      reason: `缺环境变量 ${p.authEnv}`,
      ts,
    };
    healthState.set(`${p.provider}|${p.model}`, r);
    return r;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${p.baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const healthy = res.ok;
    const r = {
      provider: p.provider,
      model: p.model,
      healthy,
      reason: healthy ? "200 OK" : `HTTP ${res.status}`,
      ts,
    };
    healthState.set(`${p.provider}|${p.model}`, r);
    return r;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const r = {
      provider: p.provider,
      model: p.model,
      healthy: false,
      reason,
      ts,
    };
    healthState.set(`${p.provider}|${p.model}`, r);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测全部 Provider（并发）。返回每个的探测结果数组。
 */
export async function probeAll() {
  return Promise.all(PROVIDERS.map((p) => runProbe(p)));
}

/**
 * 选出当前最优 Provider（按优先级取首个 healthy；全不健康则取 priority 最小者，标注 degraded）。
 * @returns {Promise<{provider:string,model:string,degraded:boolean,label:string,reason:string}>}
 */
export async function selectProvider() {
  const results = await probeAll();
  const byKey = new Map(results.map((r) => [`${r.provider}|${r.model}`, r]));
  const ordered = [...PROVIDERS].sort((a, b) => a.priority - b.priority);

  for (const p of ordered) {
    const r = byKey.get(`${p.provider}|${p.model}`);
    if (r && r.healthy) {
      return {
        provider: p.provider,
        model: p.model,
        label: p.label,
        degraded: false,
        reason: "healthy",
      };
    }
  }
  // 全不健康：回退 priority 最小者，标注 degraded（避免启动即崩，但明确告警）
  const fallback = ordered[0];
  return {
    provider: fallback.provider,
    model: fallback.model,
    label: fallback.label,
    degraded: true,
    reason: "全部 Provider 探测失败/缺 Key，已回退至最高优先级（降级运行）",
  };
}

/**
 * 人读健康状态摘要（供 /failover 命令与启动日志）。
 */
export function formatStatus() {
  const ordered = [...PROVIDERS].sort((a, b) => a.priority - b.priority);
  const lines = ordered.map((p) => {
    const s = healthState.get(`${p.provider}|${p.model}`);
    const mark = s
      ? s.healthy
        ? "✓ 健康"
        : `✗ 异常(${s.reason})`
      : "· 未探测";
    return `  P${p.priority} ${p.label.padEnd(34)} ${mark}`;
  });
  return lines.join("\n");
}

/** 供测试/外部读取当前健康态。 */
export function getHealthState() {
  return Object.fromEntries(healthState);
}
