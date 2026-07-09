import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import { encryptJSON, decryptJSON, auditLog } from "./lib/phi-crypto.mjs";

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
    process.stderr.write(`[patient-profile] 画像解密失败: ${msg}\n`);
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
    execute: async (params) => {
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

  // 读端：每轮 LLM 调用前注入画像，抗 compaction 摘要丢失
  pi.on("context", async (event) => {
    try {
      const profile = await loadProfile();
      if (!hasData(profile)) return;
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
      process.stderr.write(`[patient-profile] 画像注入失败: ${msg}\n`);
      auditLog("patient_profile.inject_error", { error: msg });
      return;
    }
  });
}
