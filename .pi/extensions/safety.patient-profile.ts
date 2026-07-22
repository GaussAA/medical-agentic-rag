import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import { encryptJSON, decryptJSON, auditLog, secureWipeFile } from "./lib/phi-crypto.mjs";
// @ts-ignore —— 诊断统一出口，例程诊断落 logs/ 不污染终端
import { diag } from "./lib/diagnostic-log.mjs";

/**
 * 患者画像记忆扩展
 *
 * 解决医疗多轮对话两大缺口：
 *   1. Pi 无结构化实体记忆——患者年龄/过敏/病史/用药仅散落在历史文本中
 *   2. Pi compaction 摘要旧消息时，自由文本摘要可能丢失关键医学事实
 *
 * 方案（A+B 组合，无需改 Pi 源码）：
 *   - 写端 registerTool("remember_patient")：LLM 问诊获知信息后主动持久化到本地 JSON
 *   - 读端 pi.on("context")：每轮 LLM 调用前把画像注入消息列表开头
 *
 * 抗 compaction 原理：画像每轮重注入，即使历史被摘要，当前 context 仍含完整画像。
 * 这使关键事实（尤其过敏史）不依赖历史是否被保留，从根上化解摘要丢失风险。
 *
 * 合规加固（本役）：
 *   - PHI 静态加密：AES-256-GCM 密文落盘，明文绝不驻留磁盘（详见 lib/phi-crypto.mjs）
 *   - 旧明文自动迁移：读到历史明文时透明解析并回写为密文
 *   - 审计留痕：画像的写入/读取注入均记 logs/audit-*.ndjson（仅记字段名与动作，不记原值）
 *   - 被遗忘权：forget_patient 工具经 secureWipeFile 覆写+删除密文文件，彻底移除 PHI（须显式 confirm=true）
 *
 * 数据存储：.pi/patient-profile.json（密文，含 PHI，已加入 .gitignore）
 */
const PROFILE_FILE = join(process.cwd(), ".pi", "patient-profile.json");

interface PatientProfile {
  age?: string;
  gender?: string;
  allergies?: string[];
  medicalHistory?: string[];
  currentMedications?: string[];
  updatedAt?: string;
}

async function loadProfile(): Promise<PatientProfile> {
  let text: string;
  try {
    text = await readFile(PROFILE_FILE, "utf-8");
  } catch {
    // 文件不存在属正常首用，返回空画像
    return {};
  }
  try {
    const { data, migrated } = decryptJSON(text);
    if (migrated) {
      // 读到历史明文：透明回写为密文，完成一次性迁移
      await saveProfile(data as PatientProfile);
      auditLog("patient_profile.migrate_plaintext", {
        fields: Object.keys(data ?? {}),
      });
    }
    return data as PatientProfile;
  } catch (err) {
    // 解密/解析失败须显式暴露，避免用空画像静默覆盖真实病史（尤其过敏史）
    const msg = err instanceof Error ? err.message : String(err);
    diag.error("patient-profile", "画像解密失败: " + msg);
    auditLog("patient_profile.decrypt_error", { error: msg });
    throw new Error(`患者画像解密失败，拒绝以空画像继续: ${msg}`);
  }
}

async function saveProfile(profile: PatientProfile): Promise<void> {
  const dir = join(process.cwd(), ".pi");
  await mkdir(dir, { recursive: true });
  profile.updatedAt = new Date().toISOString();
  // AES-256-GCM 密文落盘，明文绝不驻留磁盘
  await writeFile(PROFILE_FILE, encryptJSON(profile), "utf-8");
}

function hasData(p: PatientProfile): boolean {
  return Boolean(
    p.age ||
    p.gender ||
    (p.allergies && p.allergies.length > 0) ||
    (p.medicalHistory && p.medicalHistory.length > 0) ||
    (p.currentMedications && p.currentMedications.length > 0),
  );
}

function mergeArray(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  const set = new Set([...(existing ?? []), ...incoming]);
  return Array.from(set);
}

function renderProfile(p: PatientProfile): string {
  const lines = [
    "【患者画像】（系统每轮自动注入，请始终据此判断，勿忽略）",
    `年龄: ${p.age || "未知"}`,
    `性别: ${p.gender || "未知"}`,
    `过敏史: ${p.allergies?.join("、") || "未知"}`,
    `既往病史: ${p.medicalHistory?.join("、") || "未知"}`,
    `当前用药: ${p.currentMedications?.join("、") || "未知"}`,
    "注意: 过敏药物绝对禁止推荐；用药须考虑与当前用药的相互作用；剂量须结合年龄调整。",
  ];
  return lines.join("\n");
}

// ── 通用 vs 个人查询模式检测（防画像跨会话污染）──
const GENERAL_QUERY_PATTERNS = [
  /有哪些特征/, /如何识别/, /如何治疗/, /什么是/,
  /诊断标准/, /临床表现/, /并发症/, /病因/,
  /预防/, /筛查/, /注意事项/, /饮食/,
  /指南/, /共识/, /专家建议/,
  /特征/, /症状/, /治疗/, /用药/,
  /分类/, /分型/, /分期/, /预后/,
  /检查/, /诊断/, /鉴别/,
];
const PERSONAL_QUERY_PATTERNS = [
  /我(的|有|是|得|患了|吃了|在)/, /我的(情况|病情|症状|病|检查)/,
  /给我/, /帮我看/, /我这/, /我这种/,
  /我该/, /我应该/, /我能/,
  /父亲|母亲|家人/, /孩子/, /老人/,
  /适合我/, /对我/, /我的药/,
];

function extractMessageText(msg: any): string {
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join(" ");
  }
  return "";
}

function isGeneralKnowledgeQuery(text: string): boolean {
  return GENERAL_QUERY_PATTERNS.some((p) => p.test(text));
}

function isPersonalQuery(text: string): boolean {
  return PERSONAL_QUERY_PATTERNS.some((p) => p.test(text));
}

export default function (pi: ExtensionAPI) {
  // 写端：LLM 在问诊中获知患者信息后主动记录
  pi.registerTool({
    name: "remember_patient",
    description:
      "记录或更新患者画像信息（年龄/性别/过敏史/既往病史/当前用药）。" +
      "在问诊中获知患者信息时调用，画像会每轮自动注入对话上下文，确保关键事实不丢失。" +
      "数组字段为增量合并（去重），字符串字段为覆盖更新。",
    promptSnippet: "Persist patient demographic/clinical facts to profile",
    parameters: {
      type: "object",
      properties: {
        age: { type: "string", description: "患者年龄，如 65岁 或 3岁" },
        gender: { type: "string", description: "性别，如 男/女" },
        allergies: {
          type: "array",
          items: { type: "string" },
          description: "过敏史（药物/食物等），增量合并去重",
        },
        medicalHistory: {
          type: "array",
          items: { type: "string" },
          description: "既往病史，增量合并去重",
        },
        currentMedications: {
          type: "array",
          items: { type: "string" },
          description: "当前用药，增量合并去重",
        },
      },
    },
    execute: async (_toolCallId: string, params) => {
      try {
        const profile = await loadProfile();
        if (params.age) profile.age = params.age;
        if (params.gender) profile.gender = params.gender;
        if (params.allergies)
          profile.allergies = mergeArray(profile.allergies, params.allergies);
        if (params.medicalHistory)
          profile.medicalHistory = mergeArray(
            profile.medicalHistory,
            params.medicalHistory,
          );
        if (params.currentMedications)
          profile.currentMedications = mergeArray(
            profile.currentMedications,
            params.currentMedications,
          );
        await saveProfile(profile);
        // 审计：仅记录被更新的字段名，绝不记录字段原值（PHI）
        auditLog("patient_profile.write", {
          fields: Object.keys(params).filter(
            (k) => (params as Record<string, unknown>)[k] != null,
          ),
        });
        return {
          content: [
            {
              type: "text",
              text:
                `患者画像已更新并加密持久化（AES-256-GCM）:\n${JSON.stringify(profile, null, 2)}\n` +
                `该画像将在后续每轮对话自动注入上下文。`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditLog("patient_profile.write_error", { error: msg });
        return {
          content: [{ type: "text", text: `患者画像更新失败: ${msg}` }],
        };
      }
    },
  });

  // 被遗忘权：安全擦除本地患者画像（密文文件覆写随机字节后删除）
  pi.registerTool({
    name: "forget_patient",
    description:
      "【被遗忘权】安全擦除本地患者画像（AES-256-GCM 密文文件覆写随机字节后删除），" +
      "彻底移除患者 PHI。仅当用户明确行使被遗忘权时调用，须显式传 confirm=true，防止误触发。",
    promptSnippet: "Erase patient PHI profile (right to be forgotten)",
    parameters: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description: "须显式传 true 方执行擦除，防止误触发",
        },
      },
      required: ["confirm"],
    },
    execute: async (_toolCallId: string, params) => {
      if (params.confirm !== true) {
        // 未确认 → 中止并留痕，绝不静默擦除
        auditLog("patient_profile.forget_denied", { reason: "confirm!=true" });
        return {
          content: [
            {
              type: "text",
              text: "未确认，已中止擦除。行使被遗忘权须显式 confirm=true。",
            },
          ],
        };
      }
      const res = secureWipeFile(PROFILE_FILE);
      if (!res.wiped) {
        auditLog("patient_profile.forget_error", { error: res.reason });
        return {
          content: [{ type: "text", text: `患者画像擦除失败: ${res.reason}` }],
        };
      }
      // 审计：仅记动作，不记 PHI 原值
      auditLog("patient_profile.forget", { action: "secure_wipe", wiped: true });
      return {
        content: [
          {
            type: "text",
            text: "患者画像已安全擦除（覆写+删除），本地 PHI 已彻底移除。后续对话将不再注入该画像。",
          },
        ],
      };
    },
  });

  // 读端：每轮 LLM 调用前注入画像，抗 compaction 摘要丢失
  pi.on("context", async (event) => {
    try {
      const profile = await loadProfile();
      if (!hasData(profile)) return;

      // ── 会话新鲜度门控：跨天画像不自动注入 ──
      // 若画像超过 1 小时未更新且当前查询非个人性质，视为"陈旧会话"跳过注入
      const now = Date.now();
      const profileAge = profile.updatedAt ? now - profile.updatedAt : 0;
      if (profileAge > 3600_000) {
        // 画像超过 1 小时 → 检查当前问题类型
        const msgsForGate: any[] = (event && event.messages) || [];
        const lastUserMsg = msgsForGate.slice().reverse().find((m) => m.role === "user");
        const gateText = extractMessageText(lastUserMsg);
        if (gateText && !isPersonalQuery(gateText)) {
          diag.info("patient-profile", `画像陈旧门控触发（${Math.round(profileAge / 60000)}分钟），跳过注入`);
          auditLog("patient_profile.skip_inject_stale", { profileAgeMin: Math.round(profileAge / 60000) });
          return;
        }
      }

      // ── 通用知识问答门控：防止画像跨会话污染 ──
      // 检测当前用户问题类型：若为通用知识问答而非个人诊疗咨询，跳过画像注入
      const msgs: any[] = (event && event.messages) || [];
      const latestUserMsg = msgs.slice().reverse().find((m) => m.role === "user");
      const userText = extractMessageText(latestUserMsg);

      if (userText) {
        const isGeneral = isGeneralKnowledgeQuery(userText);
        const isPersonal = isPersonalQuery(userText);

        // 通用知识问答（科普/自学类）且 非个人咨询 → 跳过画像注入
        // 个人咨询 → 保留画像注入（即使问的是常见问题，但结合个人背景才有意义）
        // 模式不明确 → 保留画像注入（宁可错留，不可误漏，安全优先）
        if (isGeneral && !isPersonal) {
          diag.info("patient-profile", `通用问答门控触发，跳过画像注入: "${userText.slice(0, 40)}"`);
          auditLog("patient_profile.skip_inject_general_query", {
            queryPreview: userText.slice(0, 40),
          });
          return; // ← 不注入，继续正常流程
        }
      }

      const injected = {
        role: "user" as const,
        content: renderProfile(profile),
        timestamp: Date.now(),
      };
      // 审计：记录画像被读取注入（仅记动作，不记内容）
      auditLog("patient_profile.read_inject", {
        fields: Object.keys(profile).filter((k) => k !== "updatedAt"),
      });
      return { messages: [injected, ...event.messages] };
    } catch (err) {
      // 不再静默：注入失败会导致过敏史等关键事实缺席，须留痕
      const msg = err instanceof Error ? err.message : String(err);
      diag.error("patient-profile", "画像注入失败: " + msg);
      auditLog("patient_profile.inject_error", { error: msg });
      return;
    }
  });
}
