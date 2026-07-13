// scripts/kb/multisource/adapters/papers-europepmc.mjs
//
// 学术论文适配器 · Europe PMC（EBI 开放获取镜像，替代被封禁的 NCBI）。
// 仅摄取 OPEN_ACCESS:Y 的指南/共识/综述全文；PDF 经 pdftotext 抽取，PMC 源可走 XML。
// 适配统一接口：search({query,max,disease}) → 候选[]；fetchFull(item) → 英文全文。
//
// 注意：本适配器只负责「取英文全文」，中文检索锚点由 lib/render-zh.mjs 注入，
// 以满足本库中文-centric 检索（详见编排器说明）。

import { tmpdir } from "node:os";
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const UA = { "User-Agent": "medical-kb-research/1.0 (open-access ingestion; contact: local)" };

export const sourceName = "Europe PMC (OA)";

// JATS XML → 纯文本：块级标签转换行，保留章节/段落结构供 outline 复用中文层级正则。
const BLOCK = "(p|sec|title|abstract|body|article|td|tr|li|h[1-6]|figcaption|boxed-text|fn)";
function jatsToText(xml) {
  return xml
    .replace(new RegExp(`<${BLOCK}[^>]*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\d+\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/** 在命中结果中筛出 OA 全文可用项，并归一化为候选形状。 */
export async function search({ query, max = 5, disease } = {}) {
  // 仅取 PMC 源（`SRC:PMC`）开放获取全文：PMC 源可经 JATS XML 直链取得，
  // 而 MED 源 OA 全文托管于被本环境封锁的 NCBI，无法摄取。故检索即限定源，
  // 确保后续 fetchFull 必然成功（避免无效 fetch）。权威等级由标题关键词客户端判定。
  const q = `(${query}) AND OPEN_ACCESS:Y AND SRC:PMC`;
  const url = `${EPMC}/search?query=${encodeURIComponent(q)}&format=json&pageSize=${max}&resultType=core`;
  const j = await (await fetch(url, { headers: UA })).json();
  const raw = j.resultList?.result || [];
  return raw.map((r) => {
    const urls = r.fullTextUrlList?.fullTextUrl || [];
    const oaPdf = urls.find((u) => u.availability === "Open access" && u.documentStyle === "pdf");
    const t = (r.title || "").toLowerCase();
    const authority = /guideline|consensus|recommendation|statement/i.test(t)
      ? "guideline"
      : /review|meta-analysis/i.test(t)
      ? "society"
      : "paper";
    return {
      id: r.id,
      source: r.source, // PMC / MED
      title: (r.title || "").trim(),
      year: r.pubYear ? Number(r.pubYear) : null,
      license: r.license || (r.isOpenAccess ? "open-access" : null),
      openAccess: !!r.isOpenAccess,
      authority,
      disease,
      doi: r.doi || null,
      url:
        (oaPdf && oaPdf.url) ||
        (urls.find((u) => u.availability === "Open access") || {}).url ||
        `https://europepmc.org/article/${r.source}/${r.id}`,
      fullTextUrls: urls,
    };
  });
}

/**
 * 取 OA 全文：
 *   1) 优先 JATS XML 直链 `${EPMC}/${id}/fullTextXML`（id 含 PMC 前缀，不经被封的 NCBI）；
 *   2) 回退 fullTextUrlList 中的 OA PDF，但排除 ncbi.nlm.nih.gov（本环境封锁域）。
 * @returns {Promise<string>} 英文纯文本
 */
export async function fetchFull(item) {
  // 1) JATS XML 直链（最稳，PMC 源可用，绕开 NCBI 封锁）
  try {
    const xr = await fetch(`${EPMC}/${item.id}/fullTextXML`, { headers: UA });
    if (xr.ok) {
      const xml = await xr.text();
      if (xml && xml.includes("<")) {
        const txt = jatsToText(xml);
        if (txt.length > 200) return txt;
      }
    }
  } catch {
    /* ignore，继续 PDF 回退 */
  }

  // 2) OA PDF 回退（排除 NCBI 封锁域）
  const pdfUrls = (item.fullTextUrls || [])
    .filter((u) => u.availability === "Open access" && u.documentStyle === "pdf" && !/ncbi\.nlm\.nih\.gov/i.test(u.url))
    .map((u) => u.url)
    .filter(Boolean);
  for (const u of pdfUrls) {
    try {
      const resp = await fetch(u, { headers: UA, redirect: "follow" });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1024) continue;
      const dir = mkdtempSync(join(tmpdir(), "kbpdf-"));
      const p = join(dir, "doc.pdf");
      writeFileSync(p, buf);
      const txt = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", p, "-"], {
        encoding: "utf-8",
        maxBuffer: 256 * 1024 * 1024,
      });
      if (txt && txt.trim().length > 100) return txt;
    } catch {
      continue;
    }
  }
  throw new Error(`无可用 OA 全文(已排除 NCBI 封锁域): ${item.source}/${item.id}`);
}
