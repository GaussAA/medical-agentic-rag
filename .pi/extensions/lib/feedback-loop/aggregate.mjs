// feedback-loop/aggregate.mjs — 热点聚合 + 建议生成

import { SEVERITY } from "./signal.mjs";

function rank(sev) { return { low: 0, medium: 1, high: 2 }[sev] || 0; }

export function aggregateHotspots(signals) {
  const map = new Map();
  for (const s of signals) {
    const gkey = [...(s.guides || [])].sort().join("|");
    const key = `${s.type}::${gkey}`;
    if (!map.has(key)) map.set(key, { type: s.type, src: s.src, guides: s.guides || [], count: 0, severity: SEVERITY.LOW });
    const h = map.get(key);
    h.count += 1;
    if (rank(s.severity) > rank(h.severity)) h.severity = s.severity;
  }
  return [...map.values()].sort((a, b) => b.count - a.count || rank(b.severity) - rank(a.severity));
}

export function buildSuggestions(hotspots) {
  return hotspots.map((h) => {
    let suggestion = "";
    const guides = h.guides?.length ? h.guides.join(" / ") : "（未关联具体指南）";
    if (h.type.startsWith("conflict_")) suggestion = `跨指南冲突热点（${guides}）：建议人工对齐差异或补录新版指南。`;
    else if (h.type.startsWith("faithfulness_block")) suggestion = `忠实度硬阻断热点：建议强化循证约束，复盘阻断根因。`;
    else if (h.type.startsWith("faithfulness_annotate")) suggestion = `忠实度标注热点：建议补充 gold 评测样例。`;
    else if (h.type.startsWith("eval_low_")) suggestion = `评测低分热点（${h.type.replace("eval_low_", "")}）：建议补充 gold 样例与知识库覆盖。`;
    else if (h.type === "phi_noncompliant") suggestion = `PHI 合规异常：排查脱敏/审计逻辑。`;
    else suggestion = `观察到 ${h.type} 信号，建议人工复盘。`;
    return { ...h, suggestion };
  });
}
