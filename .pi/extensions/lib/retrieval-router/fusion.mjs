// retrieval-router/fusion.mjs — RRF 结果融合

const RRF_K = 60;

export function rrfFusion(lists, k = RRF_K, topK = 8) {
  if (!Array.isArray(lists) || lists.length === 0) return [];
  if (lists.length === 1) return (lists[0] || []).slice(0, topK);
  const fused = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (!item || !item.file_path) continue;
      const prev = fused.get(item.file_path);
      if (prev) { prev.score += 1 / (k + rank); if (item.score > (prev.item.score || 0)) prev.item = item; }
      else { fused.set(item.file_path, { score: 1 / (k + rank), item: { ...item } }); }
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK).map((entry) => ({ ...entry.item, rrfScore: Number(entry.score.toFixed(4)) }));
}
