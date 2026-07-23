// conversation-state.ts
// 多轮对话状态跟踪扩展：维护已问问题 / 关键槽位 / 低置信澄清触发。
//
// 模式（同 patient-profile）：
//   写端 registerTool("update_conversation_state")：LLM 获知新信息后主动持久化
//   读端 pi.on("context")：每轮 LLM 调用前注入当前状态
//
// 关键槽位定义：
//   - chiefComplaint: 主诉（用户最关心的核心问题）
//   - bodyPart: 部位（如肝、肺、乳腺）
//   - population: 人群（儿童、老年、妊娠、成人）
//   - diseaseStage: 病程阶段（早期、晚期、转移、复发）
//   - yearVersion: 指南年版（如2024、2026，由用户显式指定）
//   - audience: 人群细化（婴幼儿、青少年、老年、孕妇等）
//
// 澄清规则：
//   1. guide_finder 返回多个置信接近的候选 → 反问以缩小范围
//   2. 缺失关键槽位（如部位不明确）+ 查询含多义疾病名 → 反问澄清
//   3. 已问过 → 不再重复提问
//   4. 连续澄清不超过 3 轮，避免用户反感

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore
import { compressConversation, estimateTokens } from "./lib/context-compressor.mjs";

const STATE_FILE = join(process.cwd(), ".pi", "conversation-state.json");

// Redis 连接状态（惰性初始化）
let redisCache: any = null;

async function getRedis() {
  if (redisCache !== null) return redisCache;
  const url = process.env.REDIS_URL;
  if (!url) { redisCache = null; return null; }
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url });
    client.on("error", () => { redisCache = null; });
    await client.connect();
    redisCache = client;
    return client;
  } catch {
    redisCache = null;
    return null;
  }
}

const REDIS_KEY = "rag:session:conversation-state";

interface ConversationState {
  // 核心槽位
  chiefComplaint?: string;
  bodyPart?: string;
  population?: string;
  diseaseStage?: string;
  yearVersion?: number;
  audience?: string;

  // 已回答的问题列表（用于去重）
  askedQuestions: string[];

  // 当前活跃的指南（如有）
  currentGuide?: string;

  // 澄清轮次计数（上限 3）
  clarificationCount: number;

  // 上次更新的时间戳
  updatedAt?: string;
}

function defaultState(): ConversationState {
  return {
    askedQuestions: [],
    clarificationCount: 0,
  };
}

async function loadState(): Promise<ConversationState> {
  // Redis 优先
  try {
    const r = await getRedis();
    if (r) {
      const raw = await r.get(REDIS_KEY);
      if (raw) return { ...defaultState(), ...JSON.parse(raw) };
    }
  } catch { /* fallback */ }

  // 文件回退
  try {
    if (!existsSync(STATE_FILE)) return defaultState();
    const raw = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

async function saveState(state: ConversationState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const json = JSON.stringify(state);

  // Redis
  try {
    const r = await getRedis();
    if (r) await r.setEx(REDIS_KEY, 86400, json); // 24h TTL
  } catch { /* ignore */ }

  // 文件（双重保险）
  await mkdir(join(process.cwd(), ".pi"), { recursive: true });
  await writeFile(STATE_FILE, json, "utf-8");
}

/** 格式化状态为可读文本，注入 context。 */
function formatState(state: ConversationState): string {
  const lines: string[] = ["## 对话状态"];

  if (state.chiefComplaint) lines.push(`- 主诉: ${state.chiefComplaint}`);
  if (state.bodyPart) lines.push(`- 部位: ${state.bodyPart}`);
  if (state.population) lines.push(`- 人群: ${state.population}`);
  if (state.audience) lines.push(`- 人群细化: ${state.audience}`);
  if (state.diseaseStage) lines.push(`- 病程阶段: ${state.diseaseStage}`);
  if (state.yearVersion) lines.push(`- 指南年版: ${state.yearVersion} 版`);
  if (state.currentGuide) lines.push(`- 当前活跃指南: ${state.currentGuide}`);

  if (state.askedQuestions.length > 0) {
    lines.push(
      `- 已问过的问题 (${state.askedQuestions.length} 项)：`,
      ...state.askedQuestions.map((q) => `  · ${q}`),
    );
  }

  if (state.clarificationCount > 0) {
    lines.push(`- 本轮澄清轮次: ${state.clarificationCount}/3`);
  }

  return lines.join("\n");
}

export default function factory(pi: ExtensionAPI) {
  // ---------- 写端：registerTool ----------
  pi.registerTool({
    name: "update_conversation_state",
    description:
      "更新对话状态槽位。获知新的关键信息时（主诉、部位、人群、病程阶段、指南年版）调用此工具持久化，避免 compaction 丢失。",
    promptSnippet: `## update_conversation_state 工具

更新对话状态槽位。当用户在对话中新提供了以下任一信息时，应调用此工具持久化：

- **chiefComplaint**: 主诉（用户最关心的核心病症问题）
- **bodyPart**: 部位（肝、肺、乳腺、胃等）
- **population**: 人群（儿童、老年、成人、妊娠等）
- **audience**: 人群细化（婴幼儿、青少年、孕妇等）
- **diseaseStage**: 病程阶段（早期、晚期、转移、复发、慢性）
- **yearVersion**: 指南年版（如 2024、2026，仅当用户显式指定时）
- **currentGuide**: 当前活跃指南完整标题
- **askedQuestions**: 当前已回答完毕的问题（追加到数组末尾）

清理规则：不要重复添加相同的问题；yearVersion 仅在用户显式指定时设置，不要自行推断。`,
    parameters: {
      type: "object",
      properties: {
        chiefComplaint: {
          type: "string",
          description: "主诉，用户最关心的核心问题描述",
        },
        bodyPart: {
          type: "string",
          description: "病变部位，如 肝、肺、乳腺、胃、胰腺 等",
        },
        population: {
          type: "string",
          description: "适用人群分类：儿童、老年、成人、妊娠、围产期",
        },
        audience: {
          type: "string",
          description: "人群细化：婴幼儿、青少年、孕妇、老年、成年 等",
        },
        diseaseStage: {
          type: "string",
          description: "病程阶段：早期、晚期、转移、复发、慢性、急性",
        },
        yearVersion: {
          type: "number",
          description: "指南年版数字，仅当用户显式指定时设置",
        },
        currentGuide: {
          type: "string",
          description: "当前正在参考的指南完整标题",
        },
        askedQuestion: {
          type: "string",
          description: "已回答完毕的问题的简述（追加到历史记录）",
        },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const state = await loadState();

        if (typeof params.chiefComplaint === "string")
          state.chiefComplaint = params.chiefComplaint;
        if (typeof params.bodyPart === "string")
          state.bodyPart = params.bodyPart;
        if (typeof params.population === "string")
          state.population = params.population;
        if (typeof params.audience === "string")
          state.audience = params.audience;
        if (typeof params.diseaseStage === "string")
          state.diseaseStage = params.diseaseStage;
        if (typeof params.yearVersion === "number")
          state.yearVersion = params.yearVersion;
        if (typeof params.currentGuide === "string")
          state.currentGuide = params.currentGuide;
        if (typeof params.askedQuestion === "string") {
          if (!state.askedQuestions.includes(params.askedQuestion)) {
            state.askedQuestions.push(params.askedQuestion);
          }
        }

        await saveState(state);
        return {
          content: [
            {
              type: "text" as const,
              text: `对话状态已更新。当前已问 ${state.askedQuestions.length} 个问题，澄清轮次 ${state.clarificationCount}/3。`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `状态更新失败: ${msg}` }],
        };
      }
    },
  });

  // ---------- 辅助工具：重置澄清计数（用于多轮对话重启时） ----------
  pi.registerTool({
    name: "reset_clarification_count",
    description:
      "重置本轮澄清轮次计数。当用户主动提供了新信息（如指出具体部位/人群），可调用此工具允许继续澄清（不超过 3 轮/会话）。",
    promptSnippet:
      "## reset_clarification_count\n\n重置澄清轮次计数。在用户主动提供了关键信息后可调用。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const state = await loadState();
      state.clarificationCount = 0;
      await saveState(state);
      return {
        content: [
          { type: "text" as const, text: "澄清轮次已重置。可继续提问。" },
        ],
      };
    },
  });

  // ---------- 澄清反问工具：代码层强制 ≤3 轮上限（B1 硬化） ----------
  // 背景：原 clarificationCount 仅有 reset_clarification_count 置零 + formatState 渲染，
  // 全代码路径无自增 → 「连续澄清≤3轮」仅写于注释/prompt，运行时永不约束（死代码）。
  // 现改为：反问必须走本工具，由代码在调用点自增并硬卡上限，
  // 与项目「代码层强制护栏（非 LLM 依赖）」原则一致——LLM 无法用文字反问绕过上限。
  pi.registerTool({
    name: "ask_clarification",
    description:
      "向用户提出澄清问题（多轮对话专用）。每次准备反问用户以缩小范围时**必须**调用此工具，而非仅用文字反问。系统自动累计澄清轮次，达 3 轮上限时强制停止澄清。",
    promptSnippet:
      "## ask_clarification\n\n需要反问用户以澄清（多候选歧义 / 部位模糊 / 人群缺失 / 版本冲突）时，**必须**调用此工具提出问题，而非仅用文字反问。达 3 轮上限后工具返回「已达上限」，此时停止追问，基于现有信息作答并标注局限性，或坦诚告知知识库可能未收录该主题专项指南。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "向用户提出的澄清问题" },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const state = await loadState();
        if (state.clarificationCount >= 3) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "⚠️ 澄清轮次已达上限（3/3）。请停止追问，基于现有信息作答并标注局限性，或坦诚告知知识库可能未收录该主题专项指南。",
              },
            ],
          };
        }
        state.clarificationCount += 1;
        const q = typeof params.question === "string" ? params.question : "";
        if (q && !state.askedQuestions.includes(q)) {
          state.askedQuestions.push(q);
        }
        await saveState(state);
        return {
          content: [
            {
              type: "text" as const,
              text: `已记录澄清问题（第 ${state.clarificationCount}/3 轮）：${q}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `澄清记录失败: ${msg}` }],
        };
      }
    },
  });

  // ---------- 读端：on("context") 每轮注入 ----------
  pi.on("context", async (event) => {
    try {
      const state = await loadState();

      // ── 对话状态陈旧门控 ──
      // 若状态超过 30 分钟未更新，且当前问题未引用前序主诉，
      // 视为"新话题"，重置为默认状态（不清除已问列表，保留对话连贯性）
      const now = Date.now();
      const stateAge = state.updatedAt ? now - new Date(state.updatedAt).getTime() : 0;
      if (stateAge > 30 * 60 * 1000 && state.chiefComplaint) {
        // 检查当前用户问题是否引用前序主诉
        const msgs: any[] = (event && event.messages) || [];
        const lastUserMsg = msgs.slice().reverse().find((m) => m.role === "user");
        const userText = lastUserMsg
          ? (typeof lastUserMsg.content === "string"
              ? lastUserMsg.content
              : Array.isArray(lastUserMsg.content)
                ? lastUserMsg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
                : "")
          : "";

        // 用户问题未显式提到前序主诉关键词 → 视为新话题
        const prevComplaint = state.chiefComplaint;
        const stillRelevant = prevComplaint.length > 0 && userText.includes(prevComplaint.slice(0, 6));
        if (!stillRelevant) {
          // 重置但保留 askedQuestions（部分跨话题仍相关）
          state.chiefComplaint = undefined;
          state.bodyPart = undefined;
          state.population = undefined;
          state.diseaseStage = undefined;
          state.yearVersion = undefined;
          state.currentGuide = undefined;
          state.audience = undefined;
          // 持久化重置
          try { await saveState(state); } catch { /* 静默 */ }
        }
      }

      // ── 上下文压缩（长对话时自动触发）──
      // Pi 框架内置了 compaction 系统（enabled=true 默认开启），在 session 层做结构化摘要。
      // 我们的自定义压缩器作为补充：当 Pi compaction 未产生摘要（或预算仍超限）时触发。
      // 检测方式：查找历史消息中是否已有 Pi 生成的 compaction 摘要标记
      let compressedMessages: any[] | undefined;
      let compressionStats: any = null;
      try {
        const msgs = event.messages || [];
        // 检查 Pi 是否已经做了 compaction（通过查找 session entry 中的 compaction 标记）
        // 由于扩展层无法直接访问 SessionManager，间接判断：如果历史消息中包含
        // "Context checkpoint" 或 "Previous conversation" 等 compaction 特有标记，则跳过
        const historyText = msgs.map((m: any) => (typeof m.content === "string" ? m.content : "")).join(" ");
        const hasPiCompaction = /context checkpoint|previous summar|compaction|【前序对话摘要\]/.test(historyText);

        if (!hasPiCompaction) {
          const stateText = formatState(state);
          const result = await compressConversation(msgs, {
            totalBudget: parseInt(process.env.CONTEXT_BUDGET_TOKENS || "12000"),
            stateContext: stateText,
            fullTurns: 2,
          });
          if (result.compressed && result.messages.length > 0) {
            compressedMessages = result.messages;
            compressionStats = result.stats;
          }
        }
      } catch {
        // 压缩失败不影响主流程
      }

      const injected = formatState(state);
      // 当无状态且未压缩时跳过注入
      if (!injected && !compressedMessages) return;

      // ── 构造注入消息 ──
      // 若有压缩，使用压缩后的历史
      const baseMessages = compressedMessages || event.messages;

      // 若注入状态不为空，拼接状态 + 历史
      if (injected) {
        return {
          messages: [
            {
              role: "user" as const,
              content: injected,
              timestamp: Date.now(),
            },
            ...baseMessages,
          ],
        };
      }

      // 仅有压缩（无状态注入）：也返回压缩后的历史
      if (compressedMessages) {
        return { messages: compressedMessages };
      }

      return;
    } catch {
      // 注入失败不影响主流程
      return;
    }
  });
}
