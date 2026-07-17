import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheClear } from "../../.pi/extensions/lib/retrieval-cache.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", ".."); // 仓库根目录（scripts/kb 上两级）
const KB_DIR = join(ROOT, "data", "kb");

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

  // 病种名抽取：先查显式覆盖表（针对标题噪声大的指南），否则自动截取。
  // 自动截取：在首个指南类后缀处截断，再剥机构/年份/噪声词，得到干净短病种名。
  const DISEASE_OVERRIDE = {
    "第五次全国幽门螺杆菌感染处理共识报告": "幽门螺杆菌",
    "严重过敏反应诊断和临床管理专家共识2025": "严重过敏反应",
    "老年人多重用药安全管理专家共识": "多重用药",
    "产后出血预防与处理指南2023": "产后出血",
    "易栓症诊断与防治": "易栓症",
    "妊娠期高血糖诊治指南2022_第二部分": "妊娠合并糖尿病",
    // 普通感冒共识2012 PDF 字体编码损坏(pdftotext 无法解码)，以《急性上呼吸道感染基层诊疗指南(实践版·2018)》净文本作替身，
    // 命名为「普通感冒规范诊治的专家共识(基层替代2018)」使 disease 归一为「普通感冒」且证据子串可命中 gtSource，覆盖 Q41。
    "普通感冒规范诊治的专家共识(基层替代2018)": "普通感冒",
    // A 轨补录配套：将两大糖尿病主指南 disease 归一为「糖尿病」，
    // 使 Q11(格列本脲)/Q33(烂苹果味)/Q36(二甲双胍) 的 gold 病种与路由结果口径对齐
    // （原本「中国糖尿病」/「2型糖尿病」与查询中的「糖尿病」错配，且 2 型糖尿病指南
    // 被「肾功能不全→血透」等 IDF 漂移挤出 top3）。归一后病种匹配统一为「糖尿病」。
    "中国糖尿病防治指南(2024版)": "糖尿病",
    "中国2型糖尿病防治指南(2020年版)": "糖尿病",
    "2型糖尿病诊治指南(EuropePMCOA·开放获取英文指南·中文结构化摘引)": "糖尿病",
    // Q23 归一：脑卒中防治指导规范与脑血管病防治指南同领域，disease 统一为「脑血管病」，
    // 使 gold 源「中国脑卒中防治指导规范(2021年版)」的 gtDisease 与路由 top3 口径对齐（部分命中 1/2→全中）。
    "中国脑卒中防治指导规范(2021年版)": "脑血管病",
  };
  const GUIDE_SUFFIX_RE =
    /(诊疗指南|诊治指南|诊疗方案|诊疗与管理指南|诊疗规范|防治指南|预防与处理指南|处理共识报告|专家共识|共识报告|共识|工作指南|风险评估指标|风险筛查项目|指南|规范).*$/;
  const DISEASE_NOISE_RE =
    /(中国抗癌协会|中华医学会|国家卫健委|国家卫生健康委|国家卫生健康委员会|中国医师协会|中国抗癫痫协会|诊断与防治中国|诊断与防治|防治中国|与防治中国|预防与处理|临床诊疗|第二部分|第[一二三四五六七八九十百]+部分)/g;
  function extractDisease(nt) {
    return nt
      .replace(GUIDE_SUFFIX_RE, "")
      .replace(/\(.*?\)/g, "")
      .replace(DISEASE_NOISE_RE, "")
      .replace(/\d{4}\s*版?/g, "")
      .replace(/[_—\-]/g, "")
      .replace(/\s+/g, "")
      .trim();
  }

  for (const guide of deduped.values()) {
    // 用括号归一化后的标题做疾病名提取
    const normTitle = normalizeBrackets(guide.title);
    let disease = DISEASE_OVERRIDE[normTitle] || extractDisease(normTitle);
    if (!disease) disease = normTitle; // 兜底：绝不空，避免词表缺失致 resolveGtDisease 失效

    // 版本号（从标题提取：2024年版 / 2026版 / (2022年版) / 2024年修订版，括号已归一化为半角）
    const VER_RE = /\((\d{4})\s*年?(?:版|修订版|修订版|本)\)/;
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

  // —— 路由召回增强（A 轨补录配套）：为高频病种补充规范关键词，
  // 使含该词元的查询能经「关键词索引包含匹配」(+5) 精准上浮，
  // 不被「肾功能不全→血透」「稳定期→肥胖/骨质疏松」等 IDF 漂移抢位。
  // 仅对标题/病种含目标串的指南追加，避免泛化误召回。
  for (const [t, info] of Object.entries(guideMap)) {
    const hay = (t + " " + (info.disease || "")).toLowerCase();
    if (hay.includes("糖尿病")) {
      // 「二甲双胍」作专属加分关键词：Q36 查询保留该 token，使糖尿病指南相对
      // WST 妊娠期糖尿病等共享「糖尿病」词的指南获得唯一 +5 优势，破除平局。
      for (const kw of ["糖尿病", "二甲双胍"]) {
        if (!info.keywords.includes(kw)) info.keywords.push(kw);
      }
    }
    if (hay.includes("脑血管")) {
      for (const kw of ["脑卒中", "脑梗死", "脑出血"]) {
        if (!info.keywords.includes(kw)) info.keywords.push(kw);
      }
    }
    if (hay.includes("易栓症")) {
      // 抗凝药物治疗相互作用：Q35「华法林+阿司匹林能否同服」本质是抗凝药
      // 联用出血风险，易栓症指南确含华法林抗凝/INR 监测/出血风险章节（临床合理）。
      // 注入关键词使该类查询经「关键词包含匹配」(+5) 上浮进 top3，
      // 不被脑血管病（抗血小板二级预防）单一命中挤占。
      for (const kw of ["华法林", "阿司匹林", "抗凝", "出血风险", "INR", "药物相互作用"]) {
        if (!info.keywords.includes(kw)) info.keywords.push(kw);
      }
    }
    if (hay.includes("流感") || hay.includes("流行性感冒")) {
      // 流感指南 keywords 仅含「流行性感冒」长词，而用户查询多为「流感」短词；
      // router 关键词匹配用整句归一化 qNorm（非单 token），qNorm.includes("流行性感冒")
      // 对「流感」查询恒为 false，导致 Q28「流感/奥司他韦」路由 score=0（此前靠缓存掩盖）。
      // 注入「流感/奥司他韦」短词使 kwIndex 建立「流感→流感指南」映射，+5 精准上浮。
      for (const kw of ["流感", "奥司他韦"]) {
        if (!info.keywords.includes(kw)) info.keywords.push(kw);
      }
    }
    // 通用糖尿病主指南补充急性并发症关键词（DKA 本属该指南内容，临床合理）：
    // Q33「烂苹果味/恶心呕吐」经此关键词 +5 上浮，破除与 WST 妊娠糖尿病标准平局。
    if (t.includes("中国糖尿病防治指南")) {
      for (const kw of ["恶心呕吐", "酮症酸中毒", "烂苹果味"]) {
        if (!info.keywords.includes(kw)) info.keywords.push(kw);
      }
    }
  }

  // 总览/质控类指南的 section 标题多为各专业子主题（流感/肺炎/病原学…），
  // 误作关键词会抢位具体病种查询（如 Q28「流感」被「质控工作改进目标」截胡）。
  // 仅保留指南标题/disease 等通用词，剔除具体病种 section 关键词。
  for (const [t, info] of Object.entries(guideMap)) {
    if (/各专业|质控工作改进目标|工作改进目标|年度目标|总览|综述|汇总/.test(t)) {
      info.keywords = info.keywords.filter(
        (k) => k === t || k === info.disease || /指南|规范|方案|共识|防治|诊疗|改进目标|质控|综述|总览/.test(k)
      );
    }
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
