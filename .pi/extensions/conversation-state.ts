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

const STATE_FILE = join(process.cwd(), ".pi", "conversation-state.json");

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
  await mkdir(join(process.cwd(), ".pi"), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
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
    execute: async (params: Record<string, unknown>) => {
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

  // ---------- 读端：on("context") 每轮注入 ----------
  pi.on("context", async (event) => {
    try {
      const state = await loadState();
      const injected = formatState(state);
      if (!injected) return; // 无状态不注入

      return {
        messages: [
          {
            role: "user" as const,
            content: injected,
            timestamp: Date.now(),
          },
          ...event.messages,
        ],
      };
    } catch {
      // 注入失败不影响主流程
      return;
    }
  });
}
