import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR = join(__dirname, "..", "medical-knowlegde-base");

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

  for (const guide of outline.guides) {
    let disease = guide.title
      .replace(/诊疗指南.*$/, "")
      .replace(/诊疗方案.*$/, "")
      .replace(/诊治指南.*$/, "")
      .replace(/诊疗与管理指南.*$/, "")
      .replace(/风险评估指标.*$/, "")
      .replace(/风险筛查项目.*$/, "")
      .replace(/工作指南.*$/, "")
      .replace(/\(.*?\)/g, "")
      .replace(/（.*?）/g, "")
      .trim();

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

    guideMap[guide.title] = {
      id: guide.id,
      disease,
      keywords: Array.from(keywords).filter((k) => k.length > 1).slice(0, 50),
      sectionCount: guide.sectionCount,
      keyParagraphCount: guide.keyParagraphCount,
    };
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
}

main().catch(console.error);
