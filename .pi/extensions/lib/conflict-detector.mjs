// conflict-detector.mjs
// 跨指南冲突检测（方案 C · 先 B 后 A 的 B 部分）：生成后校验钩子的判定内核。
//
// 设计（与 faithfulness-guard 同源、零新基础设施）：
//   Layer 1（零成本·确定）：利用 guide-index.json 的 deprecated / supersededBy 字段，
//           对回答引用的指南做「版本冲突」硬提示（废止版 vs 现行版），不烧 LLM。
//   Layer 2（免费 LLM·内容冲突）：同一 query 命中 ≥2 份不同指南时，取各指南 top chunk
//           送给免费 LLM 判「针对该问题，不同指南的推荐意见是否相左」，相左则批注分歧摘要。
//
// 复用 lib/llm-judge 的 callLLM（sensenova 免费池 → deepseek 兜底），严守「免费优先」单一真相源，
// 不在此文件自写任何 fetch 端点（杜绝双口径 / 硬编码凭证）。
//
// 双可测：search / loadGuideIndex / judge / isAvailable 全部依赖注入；纯 .mjs 供 .ts 扩展
// （jiti）与原生 node 单测共用。
//
// 失败哲学：任何环节（无 DB / 无 guide-index / LLM 抛错 / 超时）一律降级为 pass（不拦截），
// 仅记录 reason，绝不因护栏自身故障阻断回答（无静默失败，但也不误伤）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callLLM, isLLMAvailable as defaultIsLLMAvailable } from "./llm-judge.mjs";
import { searchKnowledge } from "./retrieval-router.mjs";
import { diag } from "./diagnostic-log.mjs";

// ---------- 指南名归一 ----------
/** 去 .md 后缀，取 basename。 */
export function baseName(filePath) {
  const f = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
  return f.replace(/\.md$/i, "").trim();
}

/**
 * 在 guideMap 中匹配指南元数据（双向包含兼容文件名截断 / 标点差异）。
 * @returns {{deprecated:boolean, supersededBy:string|null, version:*, disease:string}|null}
 */
export function matchGuideMeta(guideName, guideMap) {
  if (!guideMap || !guideName) return null;
  const name = baseName(guideName);
  if (guideMap[name]) return guideMap[name];
  const keys = Object.keys(guideMap);
  let hit = keys.find((k) => k.includes(name) || name.includes(k));
  if (hit) return guideMap[hit];
  // 去掉前缀序号（"1.xxx" → "xxx"）再试
  const stripped = name.replace(/^\d+[.．、\s]*/, "");
  if (stripped && stripped !== name) {
    hit = keys.find((k) => k.includes(stripped) || stripped.includes(k));
    if (hit) return guideMap[hit];
  }
  return null;
}

// ---------- Layer 1：版本冲突（零成本） ----------
/**
 * 收集回答涉及的多份指南（去重、去 .md）。
 * @param {Array} results searchKnowledge 返回的 [{file_path,...}]
 */
export function collectGuideNames(results) {
  const set = new Set();
  for (const r of results || []) {
    if (r && r.file_path) set.add(baseName(r.file_path));
  }
  return [...set];
}

/**
 * 版本冲突检测：任一批注指南被标记为 deprecated 或存在 supersededBy → 版本冲突。
 * @returns {Array<{type:'version', guide:string, deprecated:boolean, supersededBy:string|null}>}
 */
export function detectVersionConflicts(guideNames, guideMap) {
  const out = [];
  for (const g of guideNames) {
    const meta = matchGuideMeta(g, guideMap);
    if (!meta) continue;
    if (meta.deprecated || meta.supersededBy) {
      out.push({
        type: "version",
        guide: g,
        deprecated: !!meta.deprecated,
        supersededBy: meta.supersededBy || null,
      });
    }
  }
  return out;
}

// ---------- 检索期版本冲突前置标注（A 层增强复用内核） ----------
/**
 * 供 rag_search 在检索期（生成前）调用：从检索命中结果提取版本冲突提示文本。
 * 纯函数、可注入 guideMap，零成本查 guide-index，不烧 LLM；与 message_end 的
 * 事后 content-conflict 批注互补（事前预防 > 事后补救）。
 * 任何异常（无 guideMap / 解析失败）一律降级返回 ""（不阻断检索）。
 * @param {Array} results searchKnowledge / engine 返回的 [{file_path,...}]
 * @param {object|null} guideMap guide-index 的 guideMap（注入便于单测；默认 null）
 */
export function buildVersionConflictHint(results, guideMap) {
  if (!guideMap) return "";
  try {
    const guideNames = collectGuideNames(results);
    if (guideNames.length === 0) return "";
    const vcs = detectVersionConflicts(guideNames, guideMap);
    if (vcs.length === 0) return "";
    return (
      "⚠️ 版本冲突提示：" +
      vcs
        .map((c) => {
          const v = c.deprecated ? "已废止" : "有更新版";
          const sup = c.supersededBy ? `（建议优先《${c.supersededBy}》）` : "";
          return `《${c.guide}》${v}${sup}`;
        })
        .join("；")
    );
  } catch {
    return "";
  }
}

// ---------- Layer 2：内容冲突（免费 LLM） ----------
/**
 * 默认 LLM 判定器：判断两份指南片段对给定问题是否意见相左。
 * 复用 callLLM（免费优先）。失败 / 解析异常 → 保守返回 {conflict:false}（不误报）。
 */
async function defaultJudgeConflict({ question, guideA, snippetA, guideB, snippetB }) {
  const messages = [
    {
      role: "system",
      content:
        "你是医疗指南一致性审查。对比两份指南片段针对同一问题的推荐意见，" +
        "仅返回 JSON：{\"conflict\":true|false,\"summary\":\"一句中文简述分歧点（若 conflict=false 则为空串）\"}。" +
        "conflict=true 当且仅当两者对同一临床命题（用药/剂量/适应症/禁忌/流程）给出明确相左的推荐。",
    },
    {
      role: "user",
      content:
        `问题：${question}\n\n` +
        `【指南A：${guideA}】\n${snippetA}\n\n` +
        `【指南B：${guideB}】\n${snippetB}`,
    },
  ];
  try {
    const text = await callLLM(messages, { temperature: 0, maxTokens: 1024 });
    const m = text.match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : {};
    return { conflict: o.conflict === true, summary: typeof o.summary === "string" ? o.summary : "" };
  } catch {
    return { conflict: false, summary: "" };
  }
}

/**
 * 内容冲突检测：多指南命中时两两比对（取每指南首条 snippet）。
 * 仅当 isAvailable() 为 true 且指南数 ≥2 且非全 deprecated 时执行。
 * @returns {Promise<Array<{type:'content', guides:[string,string], summary:string}>>}
 */
export async function detectContentConflicts({ question, results, judge = defaultJudgeConflict, isAvailable = defaultIsLLMAvailable }) {
  const guideNames = collectGuideNames(results);
  if (guideNames.length < 2 || !isAvailable()) return [];

  // 按指南分组，取每指南首条 snippet
  const byGuide = new Map();
  for (const r of results || []) {
    const g = baseName(r.file_path);
    if (!byGuide.has(g)) byGuide.set(g, (r.snippet || "").slice(0, 400));
  }
  const guides = [...byGuide.entries()];
  const pairs = [];
  for (let i = 0; i < guides.length; i++) {
    for (let j = i + 1; j < guides.length; j++) {
      pairs.push([guides[i], guides[j]]);
    }
  }
  if (pairs.length === 0) return [];

  const found = [];
  for (const [[ga, sa], [gb, sb]] of pairs) {
    const r = await judge({ question, guideA: ga, snippetA: sa, guideB: gb, snippetB: sb });
    if (r && r.conflict) {
      found.push({ type: "content", guides: [ga, gb], summary: r.summary || "" });
    }
  }
  return found;
}

// ---------- 编排入口 ----------
/**
 * 跨指南冲突检测主入口。
 * @param {object} args
 * @param {string} args.question  用户问题（用于 Layer2 比对上下文）
 * @param {string} args.answer    生成的回答（当前仅作存在性校验，冲突以检索命中为准）
 * @param {function} [args.search] 检索函数（默认 searchKnowledge），注入便于测试
 * @param {function} [args.loadGuideIndex] 返回 guideMap 或 null（默认读项目 guide-index）
 * @param {function} [args.judge] 内容冲突 LLM 判定器（默认 defaultJudgeConflict）
 * @param {function} [args.isAvailable] LLM 可用性（默认 llm-judge.isLLMAvailable）
 * @returns {Promise<{action:'pass'|'annotate', conflicts:Array, annotation?:string, reason?:string}>}
 */
export async function detectConflicts({
  question,
  answer,
  search = searchKnowledge,
  loadGuideIndex = defaultLoadGuideIndex,
  judge = defaultJudgeConflict,
  isAvailable = defaultIsLLMAvailable,
}) {
  if (process.env.CONFLICT_DETECT === "off") {
    return { action: "pass", conflicts: [], reason: "disabled" };
  }
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return { action: "pass", conflicts: [], reason: "empty_answer" };
  }

  // 1) 检索命中（BM25 免费）
  let results = [];
  try {
    const out = await search(question, { limit: 12 });
    results = (out && out.results) || [];
  } catch (e) {
    return { action: "pass", conflicts: [], reason: "search_failed:" + (e?.message || String(e)) };
  }
  const guideNames = collectGuideNames(results);
  if (guideNames.length < 2) {
    return { action: "pass", conflicts: [], reason: "single_guide_hit" };
  }

  // 2) Layer 1 版本冲突（零成本，独立于 LLM 可用性）
  let guideMap = null;
  try {
    guideMap = loadGuideIndex();
  } catch (e) {
    diag.error("conflict-detector", "指南索引加载失败，版本冲突检测降级关闭: " + (e?.message || e));
    guideMap = null;
  }
  const versionConflicts = guideMap ? detectVersionConflicts(guideNames, guideMap) : [];

  // 3) Layer 2 内容冲突（免费 LLM）
  let contentConflicts = [];
  try {
    contentConflicts = await detectContentConflicts({ question, results, judge, isAvailable });
  } catch (e) {
    contentConflicts = [];
    // 降级：仅记 reason，不阻断
    diag.warn("conflict-detector", "Layer2 失败，降级 pass: " + (e?.message || e));
  }

  const conflicts = [...versionConflicts, ...contentConflicts];
  if (conflicts.length === 0) {
    return { action: "pass", conflicts: [], reason: "no_conflict" };
  }
  return { action: "annotate", conflicts, annotation: buildAnnotation(conflicts) };
}

// ---------- 批注生成 ----------
function fmtGuides(arr) {
  return arr.map((g) => `《${g}》`).join("、");
}

/** 将冲突列表渲染为回答末尾批注（不阻断，提示以主诊医师判断为准）。 */
export function buildAnnotation(conflicts) {
  const lines = ["⚠️ 跨指南提示：以下指南对该问题存在版本差异或意见分歧，请以主诊医师临床判断为准："];
  for (const c of conflicts) {
    if (c.type === "version") {
      const v = c.deprecated ? "已标记为废止" : "存在更新版本";
      const sup = c.supersededBy ? `（现行版：《${c.supersededBy}》）` : "";
      lines.push(`- 版本差异：《${c.guide}》${v}${sup}`);
    } else if (c.type === "content") {
      lines.push(`- 意见分歧：${fmtGuides(c.guides)} — ${c.summary || "推荐意见相左"}`);
    }
  }
  return lines.join("\n");
}

// ---------- 默认 guide-index 加载 ----------
export function defaultLoadGuideIndex(baseDir = process.cwd()) {
  const p = join(baseDir, "data", "kb", ".guide-index.json");
  if (!existsSync(p)) return null;
  const data = JSON.parse(readFileSync(p, "utf-8"));
  return data.guideMap || null;
}

/** 从 content（string | [{type,text}] | other）抽取纯文本（与 faithfulness 同构，独立避免跨文件耦合）。 */
function msgText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && p.type === "text" ? p.text || "" : "")).join("\n");
  }
  return "";
}

/**
 * 将冲突检测 res 转为 Pi message_end 的替换消息（纯函数，可单测，零 LLM）。
 * 仅 action==="annotate" 且含 annotation 时返回 { role:"assistant", content }，
 * 其余（pass / 无批注）→ 返回 undefined（调用方据此放行，不替换消息）。
 * 约束：replacement 必须保持同 role（Pi 框架要求），故恒为 "assistant"。
 */
export function buildReplacementMessage(msg, res) {
  if (!res || res.action !== "annotate" || !res.annotation) return undefined;
  const text = msgText(msg?.content);
  const sep = "\n\n";
  if (typeof msg?.content === "string") {
    return { role: "assistant", content: text + sep + res.annotation };
  }
  const base = Array.isArray(msg?.content) ? msg.content : [{ type: "text", text }];
  return {
    role: "assistant",
    content: [...base, { type: "text", text: sep + res.annotation }],
  };
}
