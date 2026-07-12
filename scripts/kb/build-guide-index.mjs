import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheClear } from "../../.pi/extensions/lib/retrieval-cache.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", ".."); // 仓库根目录（scripts/kb 上两级）
const KB_DIR = join(ROOT, "medical-knowlegde-base");

async function main() {
  const outline = JSON.parse(
    await readFile(join(KB_DIR, ".outline.json"), "utf-8")
  );

  let kg = { entities: [] };
  try {
    kg = JSON.parse(
      await readFile(join(KB_DIR, ".knowledge-graph.json"), "utf-8")
    );
  } catch { /* optional */ }

  const guideMap = {};

  // 括号归一化映射：全角→半角，避免同文异号重复（如高血压(2024年修订版) vs （2024年修订版））
  const BRACKET_PAIRS = [
    { from: "（", to: "(" }, { from: "）", to: ")" },
    { from: "〔", to: "[" }, { from: "〕", to: "]" },
    { from: "【", to: "[" }, { from: "】", to: "]" },
  ];
  function normalizeBrackets(s) {
    let r = s;
    for (const { from, to } of BRACKET_PAIRS) {
      r = r.split(from).join(to);
    }
    return r;
  }

  // 先用 Map 去重：括号归一化的标题 → guide 条目
  const deduped = new Map();
  for (const guide of outline.guides) {
    const norm = normalizeBrackets(guide.title);
    // 若已存在同归一标题且版本也一致，属重复，跳过
    const existing = deduped.get(norm);
    if (existing) continue;
    deduped.set(norm, guide);
  }
  console.log(`  outline 原 ${outline.guides.length} 条，去重后 ${deduped.size} 条`);

  for (const guide of deduped.values()) {
    // 用括号归一化后的标题做疾病名提取
    const normTitle = normalizeBrackets(guide.title);
    let disease = normTitle
      .replace(/诊疗指南.*$/, "")
      .replace(/诊疗方案.*$/, "")
      .replace(/诊治指南.*$/, "")
      .replace(/诊疗与管理指南.*$/, "")
      .replace(/风险评估指标.*$/, "")
      .replace(/风险筛查项目.*$/, "")
      .replace(/工作指南.*$/, "")
      .replace(/\(.*?\)/g, "")
      .trim();

    // 版本号（从标题提取：2024年版 / 2026版 / (2022年版) / 2024年修订版，括号已归一化为半角）
    const VER_RE = /\((\d{4})\s*年?(?:版|修订版|修订本|本)\)/;
    const verMatch = normTitle.match(VER_RE);
    const version = verMatch ? Number(verMatch[1]) : null;

    // 归一名（去机构/年版/修订版/指南规范后缀）：同名多版本消歧主键
    const normalizedDisease = disease
      .replace(/\(\d{4}\s*年?(?:版|修订版|修订本|本)\)/g, "")
      .replace(/(中国抗癌协会|中华医学会|国家卫健委|国家卫生健康委|国家卫生健康委员会)/g, "")
      .replace(/(诊治指南与规范|指南与规范|诊疗规范)/g, "")
      .trim();

    // 适用人群（儿童/老年/妊娠…）：同名多指南按人群消歧
    const AUD_RE = /(儿童|老年|妊娠|围产期|新生儿|婴幼儿|青少年|孕妇|胎儿|男性|女性|成年)/;
    const audMatch = guide.title.match(AUD_RE);
    const audience = audMatch ? audMatch[1] : null;

    // 发布机构
    const ORG_RE = /(中国抗癌协会|中华医学会|国家卫健委|国家卫生健康委|国家卫生健康委员会)/;
    const orgMatch = guide.title.match(ORG_RE);
    const org = orgMatch ? orgMatch[1] : null;

    const keywords = new Set();
    keywords.add(guide.title);
    keywords.add(disease);

    function walkSections(sections, depth) {
      for (const sec of sections) {
        if (sec.title) {
          const title = sec.title.replace(/^[一二三四五六七八九十、（）()\s]+/, "");
          if (title.length > 2 && title.length < 30) {
            keywords.add(title);
          }
        }
        if (sec.children) walkSections(sec.children, depth + 1);
      }
    }
    walkSections(guide.hierarchy, 0);

    const relatedEntities = kg.entities.filter(
      (e) => e.source === guide.title
    );

    for (const e of relatedEntities) {
      keywords.add(e.disease);
      keywords.add(e.entityName);
    }

    // 废弃标记：guide-router 据此降权，检索时提示用户新版
    const deprecated = false;
    const supersededBy = null;

    guideMap[guide.title] = {
      id: guide.id,
      disease,
      version,
      normalizedDisease,
      audience,
      org,
      deprecated,
      supersededBy,
      keywords: Array.from(keywords).filter((k) => k.length > 1).slice(0, 50),
      sectionCount: guide.sectionCount,
      keyParagraphCount: guide.keyParagraphCount,
    };
  }

  // 后处理：自动检测同名归一化疾病的多版本，标记 old 版本为已废止
  const byNorm = {};
  for (const [t, info] of Object.entries(guideMap)) {
    const norm = info.normalizedDisease;
    if (!norm) continue;
    if (!byNorm[norm]) byNorm[norm] = [];
    byNorm[norm].push({ title: t, info });
  }
  for (const [norm, entries] of Object.entries(byNorm)) {
    const withVer = entries.filter(e => e.info.version != null);
    if (withVer.length < 2) continue;
    // 仅当同机构（或机构均空）且同人群时才标记废弃
    const orgs = new Set(withVer.map(e => e.info.org || ""));
    if (orgs.size > 1) continue; // 不同机构（如乳腺癌）双方保留
    const auds = new Set(withVer.map(e => e.info.audience || ""));
    if (auds.size > 1) continue;
    // 按版本排序，旧版→新版
    withVer.sort((a, b) => (a.info.version || 0) - (b.info.version || 0));
    const newest = withVer[withVer.length - 1];
    for (let i = 0; i < withVer.length - 1; i++) {
      const old = withVer[i];
      guideMap[old.title].deprecated = true;
      guideMap[old.title].supersededBy = newest.title;
      console.log(`  ⚠ 标记废止: [${old.info.version}] ${old.title} → 被 [${newest.info.version}] ${newest.title} 取代`);
    }
  }

  const keywordIndex = {};
  for (const [guideTitle, info] of Object.entries(guideMap)) {
    const entry = info;
    for (const kw of entry.keywords) {
      if (!keywordIndex[kw]) keywordIndex[kw] = [];
      if (!keywordIndex[kw].includes(guideTitle)) {
        keywordIndex[kw].push(guideTitle);
      }
    }
  }

  const index = {
    generatedAt: new Date().toISOString(),
    totalGuides: Object.keys(guideMap).length,
    totalKeywords: Object.keys(keywordIndex).length,
    guideMap,
    keywordIndex,
  };

  await writeFile(
    join(KB_DIR, ".guide-index.json"),
    JSON.stringify(index, null, 2),
    "utf-8"
  );

  console.log(`指南索引已生成:`);
  console.log(`  指南数: ${index.totalGuides}`);
  console.log(`  关键词数: ${index.totalKeywords}`);
  console.log(`\n示例 - "肝癌" 关联的指南:`);
  const matches = keywordIndex["肝癌"] || keywordIndex["原发性肝癌"] || [];
  for (const m of matches) console.log(`  → ${m}`);

  // 根因修复（P2 后续）：指南路由结果经 retrieval-cache 持久化缓存（仅 TTL 失效，不随索引重建失效）。
  // 索引重生后若不清缓存，最长 10 分钟内路由仍返回旧候选集 → 新指南被姊妹篇"截胡"、永不浮现。
  // 故索引落地即清路由缓存，强制下次查询重算路由。
  try {
    cacheClear();
    console.log("已清空路由缓存（retrieval-cache），避免陈旧路由遮蔽新指南");
  } catch (e) {
    console.error("清空路由缓存失败（非致命）:", e?.message || e);
  }
}

main().catch(console.error);
