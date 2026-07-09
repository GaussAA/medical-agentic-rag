// kb-sources.mjs
// 知识库来源登记与更新管理 —— 知识库扩展战役的核心纯函数库。
//
// 设计要点：
// 1. 来源登记表（kb-sources.json）：每项含 id/名称/类型(url或local)/地址/cadence/校验方式。
//    新增外部源只需登记一行，无需改代码——解决「无自动更新机制」根因。
// 2. 内容指纹（hash）：对来源内容求 sha256，hash 变化即视为有更新，触发重索引。
// 3. 版本快照 + 回滚：每次刷新前快照当前 registry 状态，刷新异常可回滚，保证可观测、可恢复。
// 4. staleness：距上次成功检查超 cadence 阈值即标记「过期待查」，供 /kb 命令与定时任务提醒。
// 5. 摄取（ingest）步骤留**可覆写钩子**：默认实现显式标记「未实现」，不假装完成——
//    外部源的真实抓取需凭证/网络，属手动提供认证数据的范畴（契合大帅爬虫规范）。
//
// 纯 JavaScript（.mjs）：既能被 Pi 的 jiti 加载（扩展内 import），
// 也能被原生 node 直接 import（scripts/kb-update.mjs 与单测）。

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const REGISTRY_FILE = join(process.cwd(), "kb-sources.json");
const SNAPSHOT_DIR = join(process.cwd(), ".pi", "kb-snapshots");

/** cadence（天）→ 毫秒阈值（容忍 1.5 倍漂移，避免网络抖动误报）。 */
function cadenceMs(cadenceDays) {
  return cadenceDays * 24 * 60 * 60 * 1000 * 1.5;
}

/**
 * 计算内容指纹（sha256 hex）。空内容返回固定哨兵，避免误判。
 */
export function contentHash(content) {
  if (content == null || content === "") return "EMPTY";
  return createHash("sha256").update(String(content), "utf-8").digest("hex");
}

/**
 * 读取来源登记表。文件不存在返回 { sources: [] }（不抛错，便于首次初始化）。
 */
export function loadRegistry(file = REGISTRY_FILE) {
  try {
    if (!existsSync(file))
      return { sources: [], meta: { lastFullCheck: null } };
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return {
      sources: data.sources || [],
      meta: data.meta || { lastFullCheck: null },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`来源登记表解析失败: ${msg}`);
  }
}

/**
 * 写回来源登记表（原子写：tmp + rename）。
 */
export function saveRegistry(registry, file = REGISTRY_FILE) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
  renameSync(tmp, file);
}

/**
 * 快照当前 registry 到 .pi/kb-snapshots/，返回快照路径。供回滚使用。
 */
export function snapshot(file = REGISTRY_FILE) {
  const registry = loadRegistry(file);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(SNAPSHOT_DIR, `kb-${ts}.json`);
  writeFileSync(path, JSON.stringify(registry, null, 2), "utf-8");
  return path;
}

/**
 * 从快照回滚 registry（恢复文件内容）。返回快照路径。
 */
export function rollback(snapshotPath) {
  if (!existsSync(snapshotPath)) throw new Error(`快照不存在: ${snapshotPath}`);
  const data = readFileSync(snapshotPath, "utf-8");
  writeFileSync(REGISTRY_FILE, data, "utf-8");
  return snapshotPath;
}

/**
 * 列出所有快照文件（按时间倒序）。
 */
export function listSnapshots() {
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith("kb-") && f.endsWith(".json"))
      .sort()
      .reverse();
    return files.map((f) => join(SNAPSHOT_DIR, f));
  } catch {
    return [];
  }
}

/**
 * 判定单项来源是否过期（距上次成功检查超 cadence 阈值）。
 */
export function isStale(source, now = Date.now()) {
  if (!source.lastChecked) return true;
  const threshold = cadenceMs(source.cadenceDays || 30);
  return now - new Date(source.lastChecked).getTime() > threshold;
}

/**
 * 计算登记表中所有来源的过期情况。
 * @returns {{stale:object[],fresh:object[]}}
 */
export function checkStaleness(registry = loadRegistry()) {
  const stale = [];
  const fresh = [];
  for (const s of registry.sources) {
    (isStale(s) ? stale : fresh).push(s);
  }
  return { stale, fresh };
}

/**
 * 摄取钩子（可覆写）。默认显式标记「未实现」，不假装完成——
 * 真实外部源抓取需凭证/网络，由手动提供认证数据后覆写本函数或调用外部管线。
 * 返回 { ingested:false, reason, hash } 供调用方记录。
 */
export async function ingest(source, opts = {}) {
  if (opts.ingestOverride) {
    return opts.ingestOverride(source);
  }
  if (source.type === "local" && source.localPath) {
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(source.localPath)) {
        return {
          source: source.id,
          type: source.type,
          ingested: false,
          hash: "MISSING",
          error: true,
          reason: `本地文件缺失: ${source.localPath}`,
        };
      }
      const buf = readFileSync(source.localPath, "utf-8");
      return {
        source: source.id,
        type: source.type,
        ingested: true,
        hash: contentHash(buf),
        reason: `内容指纹已更新 (${buf.length} 字节)`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        source: source.id,
        type: source.type,
        ingested: false,
        hash: "ERROR",
        error: true,
        reason: `读取失败: ${msg}`,
      };
    }
  }
  return {
    source: source.id,
    type: source.type || "unknown",
    ingested: false,
    reason:
      "默认摄取未实现：外部源需凭证/网络，请手动提供认证数据后覆写 ingest 或调用外部管线",
    hash: contentHash(source.url || source.localPath || ""),
  };
}

/**
 * 刷新流程（可编排）：快照 → 逐项 ingest → 更新 lastChecked/hash → 回写。
 * 注意：默认 ingest 不实际抓取内容，故 hash 基于 source 元信息；真实内容抓取须由
 * ingestOverride 提供。异常时回滚至快照。
 * @returns {{ok:boolean, snapshot:string, results:object[], rolledBack:boolean}}
 */
export async function refreshAll(opts = {}) {
  const snap = snapshot();
  const registry = loadRegistry();
  const results = [];
  let failed = false;
  try {
    for (const s of registry.sources) {
      const r = await ingest(s, opts);
      results.push(r);
      if (r.error) {
        failed = true;
      } else {
        s.lastChecked = new Date().toISOString();
        s.lastHash = r.hash;
      }
    }
    registry.meta = registry.meta || {};
    registry.meta.lastFullCheck = new Date().toISOString();
    if (!failed) {
      saveRegistry(registry);
    } else {
      rollback(snap); // 任一项失败即回滚，保证 registry 不处于半更新态
    }
    return { ok: !failed, snapshot: snap, results, rolledBack: failed };
  } catch (err) {
    rollback(snap);
    return {
      ok: false,
      snapshot: snap,
      results,
      rolledBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================
// 覆盖度分析（偏科缓解核心能力）
// ============================================================

/**
 * 依据指南名称推断专科归属。用于新登记源自动归类与既有源缺省补偿。
 * 规则按关键词优先级匹配，未命中归入「其他内科」。
 */
export function inferDepartment(name) {
  // 人群/场景优先：儿科、急诊先于具体病种，避免儿童白血病误归血液、急危重症漏归急诊
  if (anyIn(name, ["儿童", "小儿", "婴幼儿"])) return "儿科";
  if (anyIn(name, ["急诊", "急救", "急危", "复苏", "中毒"])) return "急诊";
  if (anyIn(name, ["癌", "瘤", "淋巴瘤", "白血病", "骨髓", "黑色素瘤", "肾细胞", "前列腺", "卵巢", "宫颈", "子宫内膜", "肝原发", "食管", "胃", "胰腺", "膀胱", "脑胶质"]))
    return "肿瘤";
  if (anyIn(name, ["溶血", "血友", "骨髓增生"])) return "血液";
  if (anyIn(name, ["肺炎", "支原体", "流感"])) return "呼吸/感染";
  if (anyIn(name, ["髋部", "骨折", "转诊", "中医药"])) return "外科/综合";
  if (anyIn(name, ["肥胖", "慢性"])) return "慢病/代谢";
  if (anyIn(name, ["妊娠", "分娩", "产科", "孕"])) return "产科";
  if (anyIn(name, ["冠心病", "高血压", "心衰", "心律失常", "心"])) return "心血管";
  if (anyIn(name, ["卒中", "脑梗", "癫痫", "帕金森", "痴呆"])) return "神经";
  if (anyIn(name, ["肝", "胃", "肠", "消化"])) return "消化";
  if (anyIn(name, ["肾", "透析"])) return "肾内";
  if (anyIn(name, ["糖", "甲状腺", "内分泌"])) return "内分泌";
  if (anyIn(name, ["风湿", "狼疮", "关节炎"])) return "风湿免疫";
  if (anyIn(name, ["精神", "抑郁", "焦虑"])) return "精神";
  return "其他内科";
}

function anyIn(s, arr) {
  return arr.some((k) => s.includes(k));
}

/**
 * 目标覆盖专科（理想应均有非零指南）。低于阈值的视为偏科缺口。
 */
export const TARGET_DEPARTMENTS = [
  "肿瘤", "血液", "呼吸/感染", "外科/综合", "慢病/代谢",
  "儿科", "急诊", "产科", "心血管", "神经",
  "消化", "肾内", "内分泌", "风湿免疫", "精神", "其他内科",
];

/**
 * 计算来源登记的专科覆盖度。
 * @returns {{
 *   total:number, byDept:Array<{dept:string, count:number, pct:number}>,
 *   gaps:string[], imbalance:number, top3:Array<{dept:string,pct:number}>
 * }}
 * - byDept: 各专科计数与占比（降序）
 * - gaps: 占比为 0 或低于阈值(5%)的专科
 * - imbalance: 偏科指数 = 最大专科占比（0~1，越高越偏）
 * - top3: 占比最高的三个专科
 */
export function computeCoverage(registry = loadRegistry()) {
  const sources = registry.sources || [];
  const total = sources.length;
  const counter = new Map();
  for (const s of sources) {
    const dept = s.department || inferDepartment(s.name || s.id || "");
    counter.set(dept, (counter.get(dept) || 0) + 1);
  }
  const byDept = [...counter.entries()]
    .map(([dept, count]) => ({ dept, count, pct: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);

  const gaps = TARGET_DEPARTMENTS.filter(
    (d) => !counter.has(d) || counter.get(d) / total < 0.05,
  );
  const top1 = byDept[0]?.pct || 0;
  const top3 = byDept.slice(0, 3);
  return { total, byDept, gaps, imbalance: top1, top3 };
}

/**
 * 缺口候选目录：卫健委已发布、当前知识库缺失的高价值指南。
 * 仅作「候选登记」元数据，ingest 标未实现——真实内容须经认证抓取或用户提供，
 * 绝不杜撰。待大帅提供认证后由 kb-update 管线落地。
 */
export const GAP_CATALOG = [
  { dept: "儿科", name: "儿童急性淋巴细胞白血病诊疗规范", hint: "国家卫健委官网 / 中国儿科血液病协作网" },
  { dept: "儿科", name: "小儿社区获得性肺炎诊疗规范", hint: "卫健委基层司" },
  { dept: "急诊", name: "常见急危重症诊疗规范（急诊科）", hint: "国家急诊医学质控中心" },
  { dept: "急诊", name: "急性 ST 段抬高型心肌梗死溶栓/急救流程", hint: "胸痛中心认证标准" },
  { dept: "产科", name: "妊娠期高血压疾病诊疗指南", hint: "中华医学会围产医学分会" },
  { dept: "产科", name: "产后出血预防与处理指南", hint: "国家产科质控中心" },
  { dept: "心血管", name: "高血压基层诊疗指南", hint: "国家心血管病中心" },
  { dept: "心血管", name: "冠心病稳定型心绞痛诊疗指南", hint: "中华医学会心血管病学分会" },
  { dept: "神经", name: "缺血性脑卒中急性期诊疗指南", hint: "国家神经系统疾病质控中心" },
  { dept: "神经", name: "癫痫诊疗指南", hint: "中国抗癫痫协会" },
  { dept: "消化", name: "幽门螺杆菌感染处理共识/指南", hint: "中华医学会消化病学分会" },
  { dept: "消化", name: "肝硬化诊疗指南", hint: "国家消化系统疾病临床医学研究中心" },
  { dept: "肾内", name: "慢性肾脏病诊疗指南", hint: "国家肾脏病临床医学研究中心" },
  { dept: "内分泌", name: "2 型糖尿病基层诊疗指南", hint: "国家代谢性疾病临床医学研究中心" },
  { dept: "内分泌", name: "甲状腺功能亢进症诊疗指南", hint: "中华医学会内分泌学分会" },
  { dept: "风湿免疫", name: "系统性红斑狼疮诊疗规范", hint: "国家风湿病数据中心" },
  { dept: "呼吸/感染", name: "社区获得性肺炎诊疗指南", hint: "中华医学会呼吸病学分会" },
  { dept: "精神", name: "抑郁症诊疗指南", hint: "国家精神心理疾病临床医学研究中心" },
];

