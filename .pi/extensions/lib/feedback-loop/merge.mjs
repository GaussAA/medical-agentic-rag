// feedback-loop/merge.mjs — Gold 派生 + 消费编排 + 受控并入

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readFeedbackQueue, loadResolved } from "./queue.mjs";

export function deriveGoldCandidates(queue, { existingIds = [] } = {}) {
  const hotspots = Array.isArray(queue) ? queue : queue?.hotspots || [];
  const idSet = new Set(existingIds);
  const cands = [];
  for (const h of hotspots) {
    const isGoldWorthy = h.type.startsWith("eval_low_") || h.type.startsWith("faithfulness_annotate") || h.type.startsWith("faithfulness_block");
    if (!isGoldWorthy) continue;
    const dept = (h.guides?.[0] || "na").replace(/[（(].*$/, "");
    const seed = h.guides?.map((g) => g.slice(0, 4)).join("_") || "na";
    const id = `CAND-${h.type}-${seed}`.replace(/[^A-Za-z0-9_-]/g, "");
    if (idSet.has(id)) continue;
    cands.push({ id, fromType: h.type, department: dept, guides: h.guides || [], severity: h.severity, count: h.count, rationale: h.suggestion, status: "candidate" });
  }
  return cands;
}

export function consumeFeedback({ queuePath, resolvedPath, existingIds = [] } = {}) {
  const queue = readFeedbackQueue(queuePath);
  if (!queue) return { consumed: false, reason: "no-queue", consumedAt: new Date().toISOString(), totalHotspots: 0, openHotspots: 0, resolvedSkipped: 0, goldCandidates: [] };
  const resolved = loadResolved(resolvedPath);
  const all = queue.hotspots || [];
  const open = all.filter((h) => { const key = `${h.type}::${[...(h.guides || [])].sort().join("|")}`; return !resolved.has(key); });
  return { consumed: true, consumedAt: new Date().toISOString(), totalHotspots: all.length, openHotspots: open.length, resolvedSkipped: all.length - open.length, goldCandidates: deriveGoldCandidates({ hotspots: open }, { existingIds }) };
}

export function writeConsumed(record, outPath) {
  const p = outPath || join(process.cwd(), "tests", "reports", "feedback-consumed.json");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2), "utf-8");
  return p;
}

export function mergeIntoGold(candidate, opts = {}) {
  const F = opts.fs || { existsSync, readFileSync, writeFileSync, mkdirSync };
  const enabled = opts.enabled === true || process.env.GOLD_AUTO_MERGE === "1";
  if (!enabled) return { merged: false, reason: "guard-off" };
  if (!candidate || typeof candidate !== "object" || !candidate.id) return { merged: false, reason: "bad-candidate" };
  if (!candidate.reviewedBy) return { merged: false, reason: "needs-review" };
  const goldPath = opts.goldPath || join(process.cwd(), "tests", "gold-answers.json");
  const candPath = opts.candidatesPath || join(process.cwd(), "tests", "reports", "gold-candidates.json");
  let candList = [];
  if (F.existsSync(candPath)) { try { candList = JSON.parse(F.readFileSync(candPath, "utf-8")); } catch { candList = []; } }
  if (!Array.isArray(candList) || !candList.some((c) => c.id === candidate.id)) return { merged: false, reason: "not-in-candidates" };
  let gold = [];
  if (F.existsSync(goldPath)) { try { gold = JSON.parse(F.readFileSync(goldPath, "utf-8")); } catch { gold = []; } }
  if (Array.isArray(gold) && gold.some((g) => g.id === candidate.id)) return { merged: false, reason: "already-exists" };
  gold.push(candidate);
  F.mkdirSync(join(goldPath, ".."), { recursive: true });
  F.writeFileSync(goldPath, JSON.stringify(gold, null, 2), "utf-8");
  return { merged: true, id: candidate.id, total: gold.length };
}
