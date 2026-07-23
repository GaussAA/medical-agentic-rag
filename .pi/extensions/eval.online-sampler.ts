/**
 * eval.online-sampler.ts — 在线评估采样
 *
 * 生产流量 5% 异步采样：透明记录 user_query + retrieved_chunks + llm_response，
 * 异步调用 LLM-Judge 做四维评分（faithfulness / relevance / clinical / safety），
 * 写入 NDJSON 日志供 Grafana 面板消费。
 *
 * 设计要点：
 *   · 采样率 5%（每第 20 次调用采样一次），env 可调
 *   · 异步执行，不阻塞用户响应流（fire-and-forget）
 *   · 无 API Key 时优雅跳过
 *   · 写入路径: .pi/logs/online-eval-YYYY-MM-DD.ndjson
 *   · 数据保留不超 30 天（依赖外部日志轮转策略）
 *
 * 依赖: lib/llm-judge.mjs（四维评分）、lib/diagnostic-log.mjs
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "./lib/diagnostic-log.mjs";

// ── 配置（env 可覆盖）──
const SAMPLE_RATE = parseFloat(process.env.ONLINE_EVAL_SAMPLE_RATE || "0.05"); // 5%
const LOG_DIR = process.env.ONLINE_EVAL_LOG_DIR || join(process.cwd(), ".pi", "logs");

// ── 采样计数器（进程级别；多实例各计，采样率不变）──
let callCounter = 0;

/**
 * 判断当前调用是否应被采样（近似 SAMPLE_RATE 概率）。
 * 使用计数器取模而非 random()，保证确定性与可复现。
 */
function shouldSample(): boolean {
  callCounter++;
  const interval = Math.max(1, Math.round(1 / SAMPLE_RATE));
  return callCounter % interval === 0;
}

/**
 * 异步写入在线评估记录到 NDJSON。
 * fire-and-forget：不 await（不阻塞主线程），失败仅走 diag 日志。
 */
async function writeOnlineEval(record: Record<string, unknown>) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      event: "online_eval",
      ...record,
    }) + "\n";
    await appendFile(join(LOG_DIR, `online-eval-${date}.ndjson`), entry, "utf-8");
  } catch (e: any) {
    diag.warn("online-sampler", `NDJSON 写入失败: ${e?.message || e}`);
  }
}

export default function (pi: ExtensionAPI) {
  // ── 采样率 0 时直接禁用 ──
  if (SAMPLE_RATE <= 0) {
    diag.info("online-sampler", "采样率=0，在线评估已禁用");
    return;
  }

  diag.info("online-sampler", `在线评估采样率=${(SAMPLE_RATE * 100).toFixed(1)}%`);

  // ── 使用 message_end 钩子捕获每一轮问答 ──
  // message_end 事件包含 user prompt（event.prompt）和 LLM 回复（event.response）
  pi.on("message_end", async (event: any, ctx: any) => {
    // 采样过滤
    if (!shouldSample()) return;

    const userQuery = (event?.messages || [])
      .filter((m: any) => m.role === "user")
      .map((m: any) => (typeof m.content === "string" ? m.content : ""))
      .filter(Boolean)
      .pop() || "";

    const llmResponse = typeof event?.reply === "string"
      ? event.reply
      : event?.response
        ? (typeof event.response === "string" ? event.response : JSON.stringify(event.response))
        : "";

    // 跳过空查询/空回复的采样
    if (!userQuery || !llmResponse || llmResponse.length < 20) return;

    // 立即写一条采样记录（不含 LLM-Judge 结果，先记录关键上下文）
    const sampleId = `online-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sampleRecord = {
      sampleId,
      userQuery: userQuery.slice(0, 200),    // 截断防 PII 过长
      responseLength: llmResponse.length,
      hasRetrieved: llmResponse.includes("检索报告") || llmResponse.includes("evidence"),
      sessionId: ctx?.sessionId || "",
    };

    // fire-and-forget: 写采样记录（不 await，不等 NDJSON 落盘再往下走）
    writeOnlineEval(sampleRecord).catch(() => {});

    // 异步调用 LLM-Judge（fire-and-forget）
    // 不阻塞主线程、不 catch 阻止后续流程
    (async () => {
      try {
        const { judgeAnswer, isLLMAvailable } = await import("./lib/llm-judge.mjs");
        if (!isLLMAvailable || !isLLMAvailable()) {
          diag.info("online-sampler", `[${sampleId}] LLM 不可用，跳过在线评分`);
          await writeOnlineEval({ ...sampleRecord, skipped: true, reason: "LLM unavailable" });
          return;
        }

        const t0 = performance.now();
        const judgeResult = await judgeAnswer(userQuery, llmResponse, {
          timeoutMs: 15000,
        });
        const latencyMs = Math.round(performance.now() - t0);

        if (judgeResult) {
          await writeOnlineEval({
            ...sampleRecord,
            judged: true,
            latencyMs,
            faithfulness: judgeResult.faithfulness,
            answerRelevance: judgeResult.answerRelevance,
            clinicalCorrectness: judgeResult.clinicalCorrectness,
            safety: judgeResult.safety,
            reasons: judgeResult.reasons?.slice(0, 200),
          });

          // 低分告警：faithfulness < 0.6 时写 alert-log（生产可配置为 P0 告警）
          if (typeof judgeResult.faithfulness === "number" && judgeResult.faithfulness < 0.6) {
            diag.warn("online-sampler",
              `[${sampleId}] 低忠实度检测: faithfulness=${judgeResult.faithfulness.toFixed(3)}`
            );
          }
        }
      } catch (e: any) {
        diag.warn("online-sampler", `在线评分失败: ${e?.message?.slice(0, 100) || e}`);
        await writeOnlineEval({ ...sampleRecord, judged: false, error: e?.message?.slice(0, 100) });
      }
    })();
  });
}
