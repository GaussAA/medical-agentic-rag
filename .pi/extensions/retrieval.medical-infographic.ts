// .pi/extensions/retrieval.medical-infographic.ts
//
// 医学信息图生成工具——调用 sensenova-u1-fast 免费图像模型（与文本模型独立配额），
// 将诊疗流程、药物对比、临床路径等转为信息图，返回本地保存的图片路径。
//
// 配额：5 小时 1500 次免费，与 sensenova-6.7-flash-lite/deepseek-v4-flash 额度隔离。
//
// 参考文档：https://platform.sensenova.cn/docs

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const IMG_DIR = join(process.cwd(), "data", "infographics");
const API_URL = "https://token.sensenova.cn/v1/images/generations";
const MODEL = "sensenova-u1-fast";
const FETCH_TIMEOUT_MS = 120_000; // 图像生成可能 60-120s

/**
 * 从环境变量获取 sensenova API Key（单 Key 或 Key 池均兼容）。
 */
function getApiKey(): string {
  const single = process.env.SENSENOVA_API_KEY;
  if (single) return single;
  const pool = (process.env.SENSENOVA_API_KEYS || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return pool[0] || "";
}

/**
 * 构建信息图 prompt：将 topic + style + guide_title 组装为 u1-fast 的
 * 自然语言描述。u1-fast 没有 chat 接口，prompt 即最终生成指令。
 */
function buildPrompt(
  topic: string,
  style: string,
  guideTitle: string,
): string {
  const styleMap: Record<string, string> = {
    flowchart: "流程图",
    comparison: "对比图",
    steps: "步骤图",
    infographic: "综合信息图",
    auto: "",
  };
  const styleZh = styleMap[style] || "";
  const styleHint = styleZh ? `（风格：${styleZh}）` : "";
  const guideHint = guideTitle ? `\n参考指南：${guideTitle}` : "";
  return `一张专业医疗信息图，展示「${topic}」${styleHint}。要求：清晰、结构化、中文标注，包含关键医学数据和步骤说明。${guideHint}`;
}

/** 从 API 响应中提取图片 URL（兼容 data[0].url 与 images[0].url）。 */
function extractImageUrl(data: any): string | null {
  if (data?.data?.[0]?.url) return data.data[0].url;
  if (data?.images?.[0]?.url) return data.images[0].url;
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_medical_infographic",
    label: "Generate Medical Infographic",
    description:
      "根据医学主题生成信息图（infographic），可视化疾病诊疗流程、药物对比、临床路径等。" +
      "调用 sensenova-u1-fast 免费图像模型，与文本模型额度隔离。支持流程图、对比图、步骤图等风格。",
    promptSnippet:
      "Generate infographic for medical topics (disease pathway / drug comparison / clinical algorithm)",
    promptGuidelines: [
      "当用户需要视觉化理解（流程图、步骤图、对比图、路径图）时调用此工具",
      "topic 简明概括要可视化的内容（如「糖尿病酮症酸中毒急救步骤」「高血压药物分类对照」）",
      "guide_title 可选，指定对应指南名称以丰富细节",
      "返回本地保存的图片路径，Agent 应直接引用路径展示给用户",
      "⚠️ 不消耗文本模型配额：u1-fast 独立免费配额（5h/1500次）",
      "不要替用户「画图」，仅当用户明确需要视觉辅助时才使用",
    ],
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "信息图主题——简要概括要可视化的内容（如「糖尿病酮症酸中毒急救步骤」「高血压药物分类对比」「脑卒中识别流程图」）",
        },
        guide_title: {
          type: "string",
          description:
            "关联的指南名称（可选），Agent 应尽量传入当前上下文中的指南名以丰富信息图内容",
        },
        style: {
          type: "string",
          enum: ["infographic", "flowchart", "comparison", "steps", "auto"],
          description:
            "信息图风格：infographic=综合信息图, flowchart=流程图, comparison=对比图, steps=步骤图, auto=自动选择（默认）",
        },
      },
      required: ["topic"],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      const topic = String(params.topic || "").trim();
      if (!topic) {
        return {
          content: [
            { type: "text" as const, text: "信息图生成失败：缺少主题描述（topic 参数）。" },
          ],
        };
      }
      const guideTitle = params.guide_title ? String(params.guide_title).trim() : "";
      const style = String(params.style || "auto");

      // —— 1. 凭证 ——
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: "信息图生成失败：未找到 SENSENOVA_API_KEY 或 SENSENOVA_API_KEYS 环境变量。",
            },
          ],
        };
      }

      // —— 2. 调用 sensenova-u1-fast ——
      const prompt = buildPrompt(topic, style, guideTitle);
      try {
        // 合并 Pi 框架外部 signal 与内部超时 controller，任一触发即终止
        const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            prompt,
            size: "2752x1536",
            n: 1,
          }),
          signal: combined,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }
        const raw = await res.json();
        const imageUrl = extractImageUrl(raw);
        if (!imageUrl) {
          throw new Error("API 返回数据中未找到图片 URL（字段兼容 data[0].url / images[0].url）");
        }

        // —— 3. 下载并持久化（u1-fast 返回的 URL 仅 1h 有效） ——
        await mkdir(IMG_DIR, { recursive: true });
        const timestamp = Date.now();
        const safeTopic = topic.replace(/[\\/:*?"<>|]/g, "_").slice(0, 30);
        const filename = `infographic_${safeTopic}_${timestamp}.png`;
        const filepath = join(IMG_DIR, filename);

        const imgRes = await fetch(imageUrl, { signal: combined });
        if (!imgRes.ok) {
          throw new Error(`下载图片失败: HTTP ${imgRes.status}`);
        }
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        await writeFile(filepath, buffer);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `✅ 信息图已生成：${topic}`,
                `📁 本地路径：${filepath}`,
                ``,
                `（sensenova-u1-fast 免费模型 · 与文本模型独立配额）`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `信息图生成失败：${msg}\n（可尝试简化 topic 或稍后重试）`,
            },
          ],
        };
      }
    },
  });
}
