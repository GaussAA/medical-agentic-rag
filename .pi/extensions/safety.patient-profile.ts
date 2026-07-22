import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
// @ts-ignore
import { encryptJSON, decryptJSON, auditLog, secureWipeFile } from "./lib/phi-crypto.mjs";
// @ts-ignore
import { diag } from "./lib/diagnostic-log.mjs";

const PROFILE_FILE = join(process.cwd(), ".pi", "patient-profile.json");
const DEFAULT_PATIENT_ID = "default";

interface PatientProfile {
  age?: string;
  gender?: string;
  allergies?: string[];
  medicalHistory?: string[];
  currentMedications?: string[];
  relationship?: string;
  updatedAt?: string;
}

interface ProfileContainer {
  currentId: string;
  patients: Record<string, PatientProfile>;
}

function defaultContainer(): ProfileContainer {
  return { currentId: DEFAULT_PATIENT_ID, patients: {} };
}

async function loadContainer(): Promise<ProfileContainer> {
  try {
    const text = await readFile(PROFILE_FILE, "utf-8");
    const { data } = decryptJSON(text) as any;
    if (data && !data.patients) {
      const migrated: ProfileContainer = {
        currentId: DEFAULT_PATIENT_ID,
        patients: { [DEFAULT_PATIENT_ID]: data },
      };
      await saveContainer(migrated);
      auditLog("patient_profile.migrate_v1_to_v2", { fields: Object.keys(data) });
      return migrated;
    }
    return { ...defaultContainer(), ...data };
  } catch {
    return defaultContainer();
  }
}

async function saveContainer(container: ProfileContainer): Promise<void> {
  const dir = join(process.cwd(), ".pi");
  await mkdir(dir, { recursive: true });
  await writeFile(PROFILE_FILE, encryptJSON(container), "utf-8");
}

function getCurrentProfile(container: ProfileContainer): PatientProfile {
  return container.patients[container.currentId] || {};
}

function hasData(p: PatientProfile): boolean {
  return Boolean(
    p.age || p.gender ||
    (p.allergies && p.allergies.length > 0) ||
    (p.medicalHistory && p.medicalHistory.length > 0) ||
    (p.currentMedications && p.currentMedications.length > 0),
  );
}

function mergeArray(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  return Array.from(new Set([...(existing ?? []), ...incoming]));
}

// Auto-extraction patterns
const AGE_PAT = /(\d{1,3})\s*岁/;
const ALLERGY_PATS = [/对(.+?)过敏/g, /过敏药物[：:]\s*(.+?)[。；\n]/];
const HISTORY_PATS = [/有(.+?)病史/g, /患(?:了)?(.+?)[。，；\n]/];
const MED_PATS = [/在(?:吃|用|服用)(.+?)[。，；\n]/g, /口服(.+?)[。，；\n]/];
const RELATION_PATS = [/我(父亲|母亲|妈妈|爸爸|儿子|女儿|孩子|爷爷|奶奶|外公|外婆)/, /我家(老人|小孩)/];

function extractProfileFromText(text: string): Partial<PatientProfile> & { relation?: string } {
  const result: any = {};
  const ageMatch = text.match(AGE_PAT);
  if (ageMatch) result.age = ageMatch[1] + "岁";
  for (const pat of RELATION_PATS) {
    const m = text.match(pat);
    if (m) { result.relation = m[1]; break; }
  }
  for (const pat of ALLERGY_PATS) {
    const matches = text.matchAll(pat);
    for (const m of matches) {
      const items = m[1].split(/[、，,]/).map((s: string) => s.trim()).filter(Boolean);
      if (items.length) result.allergies = [...(result.allergies || []), ...items];
    }
  }
  for (const pat of HISTORY_PATS) {
    const matches = text.matchAll(pat);
    for (const m of matches) {
      const items = m[1].split(/[、，,]/).map((s: string) => s.trim()).filter(Boolean);
      if (items.length) result.medicalHistory = [...(result.medicalHistory || []), ...items];
    }
  }
  for (const pat of MED_PATS) {
    const matches = text.matchAll(pat);
    for (const m of matches) {
      const items = m[1].split(/[、，,]/).map((s: string) => s.trim()).filter(Boolean);
      if (items.length) result.currentMedications = [...(result.currentMedications || []), ...items];
    }
  }
  return result;
}

function renderProfile(p: PatientProfile, label: string): string {
  return [
    "[患者画像: " + label + "] (系统每轮自动注入)",
    "  年龄: " + (p.age || "未知"),
    "  性别: " + (p.gender || "未知"),
    "  过敏史: " + (p.allergies?.join("、") || "未知"),
    "  既往病史: " + (p.medicalHistory?.join("、") || "未知"),
    "  当前用药: " + (p.currentMedications?.join("、") || "未知"),
    "  注意: 过敏药物绝对禁止推荐; 用药须考虑相互作用; 剂量须结合年龄调整。",
  ].join("\n");
}

function extractMessageText(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ");
  return "";
}

const GENERAL_PATTERNS = [
  /有哪些特征/, /如何识别/, /如何治疗/, /什么是/,
  /诊断标准/, /临床表现/, /并发症/, /病因/,
  /预防/, /筛查/, /注意事项/, /饮食/,
  /指南/, /共识/, /专家建议/,
  /特征/, /症状/, /分类/, /分型/, /分期/,
  /检查/, /诊断/, /鉴别/,
];
const PERSONAL_PATTERNS = [
  /我(的|有|是|得|患了|吃了|在)/, /我的(情况|病情|症状|病|检查)/,
  /给我/, /帮我看/, /我这/, /我这种/,
  /我该/, /我应该/, /我能/,
  /父亲|母亲|家人/, /孩子/, /老人/,
  /适合我/, /对我/, /我的药/,
];

function isGeneralQuery(text: string): boolean {
  return GENERAL_PATTERNS.some((p) => p.test(text));
}
function isPersonalQuery(text: string): boolean {
  return PERSONAL_PATTERNS.some((p) => p.test(text));
}

export default function (pi: ExtensionAPI) {
  // remember_patient tool (v2 with multi-patient support)
  pi.registerTool({
    name: "remember_patient",
    description: "Record or update patient profile. Supports multiple patients via patientId parameter. Array fields merge deduplicated.",
    promptSnippet: "Persist patient clinical facts",
    parameters: {
      type: "object",
      properties: {
        patientId: { type: "string", description: "Patient identifier. Defaults to current patient. Example: father" },
        age: { type: "string" },
        gender: { type: "string" },
        allergies: { type: "array", items: { type: "string" } },
        medicalHistory: { type: "array", items: { type: "string" } },
        currentMedications: { type: "array", items: { type: "string" } },
        relationship: { type: "string", description: "Relationship: self/father/mother/child etc" },
      },
    },
    execute: async (_toolCallId: string, params) => {
      try {
        const container = await loadContainer();
        const patientId = (params.patientId as string) || container.currentId;
        if (!container.patients[patientId]) container.patients[patientId] = {};
        const profile = container.patients[patientId];
        if (params.age) profile.age = params.age;
        if (params.gender) profile.gender = params.gender;
        if (params.relationship) profile.relationship = params.relationship;
        if (params.allergies) profile.allergies = mergeArray(profile.allergies, params.allergies);
        if (params.medicalHistory) profile.medicalHistory = mergeArray(profile.medicalHistory, params.medicalHistory);
        if (params.currentMedications) profile.currentMedications = mergeArray(profile.currentMedications, params.currentMedications);
        await saveContainer(container);
        auditLog("patient_profile.write", { patientId, fields: Object.keys(params).filter((k) => (params as any)[k] != null) });
        return { content: [{ type: "text", text: "Patient " + patientId + " profile updated and encrypted." }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: "Update failed: " + err.message }] };
      }
    },
  });

  // switch_patient tool
  pi.registerTool({
    name: "switch_patient",
    description: "Switch active patient. Subsequent profile injections will use this patient. Patient must already exist (use remember_patient first).",
    promptSnippet: "Switch active patient",
    parameters: {
      type: "object",
      properties: {
        patientId: { type: "string", description: "Patient identifier" },
      },
      required: ["patientId"],
    },
    execute: async (_toolCallId: string, params) => {
      const patientId = params.patientId as string;
      const container = await loadContainer();
      if (!container.patients[patientId]) {
        container.patients[patientId] = {};
      }
      container.currentId = patientId;
      await saveContainer(container);
      auditLog("patient_profile.switch", { patientId });
      return { content: [{ type: "text", text: "Switched to patient: " + patientId }] };
    },
  });

  // list_patients tool
  pi.registerTool({
    name: "list_patients",
    description: "List all recorded patient profiles (summary only, no PHI details).",
    promptSnippet: "List all patients",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const container = await loadContainer();
      const ids = Object.keys(container.patients);
      if (!ids.length) return { content: [{ type: "text", text: "No patients recorded." }] };
      const lines = ids.map((id) => {
        const p = container.patients[id];
        const rel = p.relationship ? "(" + p.relationship + ")" : "";
        const has = [p.age && "age " + p.age, p.allergies?.length && "allergies " + p.allergies.length, p.medicalHistory?.length && "history " + p.medicalHistory.length, p.currentMedications?.length && "meds " + p.currentMedications.length].filter(Boolean).join(", ");
        return (id === container.currentId ? "> " : "  ") + id + " " + rel + ": " + (has || "no data");
      });
      return { content: [{ type: "text", text: "Patients:\n" + lines.join("\n") }] };
    },
  });

  // forget_patient tool (v2)
  pi.registerTool({
    name: "forget_patient",
    description: "Securely erase patient profile(s). Specify patientId for single patient, omit for all. Requires confirm=true.",
    promptSnippet: "Erase patient PHI",
    parameters: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "Must be true to proceed" },
        patientId: { type: "string", description: "Patient to erase. Omit to erase all." },
      },
      required: ["confirm"],
    },
    execute: async (_toolCallId: string, params) => {
      if (params.confirm !== true) {
        return { content: [{ type: "text", text: "Not confirmed. Must pass confirm=true." }] };
      }
      if (params.patientId) {
        const container = await loadContainer();
        delete container.patients[params.patientId as string];
        if (container.currentId === params.patientId) container.currentId = DEFAULT_PATIENT_ID;
        await saveContainer(container);
        auditLog("patient_profile.forget_one", { patientId: params.patientId });
        return { content: [{ type: "text", text: "Patient " + params.patientId + " erased." }] };
      }
      const res = secureWipeFile(PROFILE_FILE);
      if (!res.wiped) return { content: [{ type: "text", text: "Erase failed: " + res.reason }] };
      auditLog("patient_profile.forget_all", { wiped: true });
      return { content: [{ type: "text", text: "All patient profiles erased." }] };
    },
  });

  // Read side: on("context") injection + auto-extraction
  pi.on("context", async (event) => {
    try {
      const msgs: any[] = (event && event.messages) || [];
      const lastUserMsg = msgs.slice().reverse().find((m) => m.role === "user");
      const userText = extractMessageText(lastUserMsg);
      if (!userText) return;

      // Step 1: Auto-extract (system level, does not depend on LLM)
      const extracted = extractProfileFromText(userText);
      if (extracted.age || extracted.allergies?.length || extracted.medicalHistory?.length || extracted.currentMedications?.length) {
        const container = await loadContainer();
        const targetId = extracted.relation ? ("family-" + extracted.relation) : container.currentId;
        if (!container.patients[targetId]) container.patients[targetId] = {};
        const p = container.patients[targetId];
        if (extracted.age && !p.age) p.age = extracted.age;
        if (extracted.relation && !p.relationship) p.relationship = extracted.relation;
        if (extracted.allergies?.length) p.allergies = mergeArray(p.allergies, extracted.allergies);
        if (extracted.medicalHistory?.length) p.medicalHistory = mergeArray(p.medicalHistory, extracted.medicalHistory);
        if (extracted.currentMedications?.length) p.currentMedications = mergeArray(p.currentMedications, extracted.currentMedications);
        if (extracted.relation && targetId !== container.currentId) {
          container.currentId = targetId;
        }
        await saveContainer(container);
        diag.info("patient-profile", "Auto-extracted: " + (extracted.age ? "age " : "") + (extracted.allergies?.length ? "allergies " : "") + (extracted.medicalHistory?.length ? "history " : "") + (extracted.currentMedications?.length ? "meds " : ""));
      }

      // Step 2: Smart injection
      const isGeneral = isGeneralQuery(userText);
      const isPersonal = isPersonalQuery(userText);
      if (isGeneral && !isPersonal) {
        return; // General knowledge question, skip injection
      }

      const container = await loadContainer();
      const profile = getCurrentProfile(container);
      if (!hasData(profile)) return;

      // Staleness gate: skip if >1h old and not personal
      const now = Date.now();
      const age = profile.updatedAt ? now - new Date(profile.updatedAt).getTime() : 0;
      if (age > 3600_000 && !isPersonal) {
        diag.info("patient-profile", "Staleness gate: " + Math.round(age / 60000) + "min");
        return;
      }

      const label = container.currentId === DEFAULT_PATIENT_ID ? "self" : (profile.relationship || container.currentId);
      const injected = {
        role: "user" as const,
        content: renderProfile(profile, label),
        timestamp: Date.now(),
      };
      return { messages: [injected, ...event.messages] };
    } catch (err: any) {
      diag.error("patient-profile", "Inject failed: " + err.message);
      return;
    }
  });
}
