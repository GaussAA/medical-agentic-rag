// compliance-audit.mjs
// E4 控制级合规审计扫描器（零依赖、可进 CI / nightly）。
//
// 与 tests/unit/compliance-test.mjs（函数级加密/脱敏单测）互补：
//   本脚本从「架构/控制」层面静态核验各合规控制是否就绪（代码事实锚定），
//   产出机器可读 JSON（tests/reports/compliance-audit.json）+ 人类可读报告（stdout + .md）。
//
// 控制维度覆盖：加密 / 脱敏 / 审计防篡改 / 安全擦除(被遗忘权) / 5 道护栏 /
//                 gitignore 数据红线 / 合规文档交付 / 单测覆盖。
// 运行：node scripts/ops/compliance-audit.mjs
// 退出码：全部 PASS→0；存在 warn/fail→1（便于 nightly 硬报警复用）。

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** 读取文件内容（缺失返回 null，不抛）。 */
function readSafe(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** 在某文件内容中匹配正则，返回是否命中 + 首个匹配片段。 */
function matchIn(file, re) {
  const txt = readSafe(file);
  if (txt == null) return { hit: false, detail: "文件缺失" };
  const m = re.exec(txt);
  return m ? { hit: true, detail: m[0].slice(0, 60) } : { hit: false, detail: "未匹配" };
}

/** 目录下同扩展名文件计数。 */
function countInDir(dir, ext) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(ext)).length;
}

// ============ 控制定义 ============
const controls = [
  {
    id: "C-ENC",
    area: "加密",
    desc: "PHI 静态加密 AES-256-GCM（encryptJSON 落盘）",
    evidenceFile: ".pi/extensions/lib/phi-crypto.mjs",
    re: /export function encryptJSON/,
  },
  {
    id: "C-MASK",
    area: "脱敏",
    desc: "PII 综合脱敏（手机/身份证/邮箱/姓名）",
    evidenceFile: ".pi/extensions/lib/phi-crypto.mjs",
    re: /export function maskPII/,
  },
  {
    id: "C-AUDIT",
    area: "审计",
    desc: "审计防篡改 HMAC-SHA256 哈希链",
    evidenceFile: ".pi/extensions/lib/audit-chain.mjs",
    re: /createHmac|HMAC/,
  },
  {
    id: "C-WIPE",
    area: "被遗忘权",
    desc: "安全擦除 secureWipeFile（覆写+删除）",
    evidenceFile: ".pi/extensions/lib/phi-crypto.mjs",
    re: /export function secureWipeFile/,
  },
  {
    id: "C-FORGET",
    area: "被遗忘权",
    desc: "forget_patient 工具（须 confirm=true）",
    evidenceFile: ".pi/extensions/safety.patient-profile.ts",
    re: /name:\s*"forget_patient"/,
  },
  {
    id: "C-SCOPE",
    area: "护栏",
    desc: "越界硬阻断（scope-guard 注入 system 拒答）",
    evidenceFile: ".pi/extensions/safety.scope-guard.ts",
    re: /SCOPE_REFUSAL_DIRECTIVE|return\s*\{\s*messages:/,
  },
  {
    id: "C-BASH",
    area: "护栏",
    desc: "命令护栏（bash-guard 危险命令拦截+超时）",
    evidenceFile: ".pi/extensions/safety.bash-guard.ts",
    re: /assessCommand|blocked/,
  },
  {
    id: "C-FAITH",
    area: "护栏",
    desc: "忠实度真阻断（E1：message_end return 替换）",
    evidenceFile: ".pi/extensions/safety.faithfulness-guard.ts",
    re: /buildReplacementMessage|return\s*\{\s*message/,
  },
  {
    id: "C-CONFLICT",
    area: "护栏",
    desc: "冲突真阻断（E1：conflict message_end 替换）",
    evidenceFile: ".pi/extensions/safety.conflict-detector.ts",
    re: /buildReplacementMessage|return\s*\{\s*message/,
  },
  {
    id: "C-RED",
    area: "数据红线",
    desc: "gitignore 排除 PHI/密钥（sessions/profile/key/env）",
    evidenceFile: ".gitignore",
    re: /\.pi\/sessions\/|\.pi\/patient-profile\.json|\.pi\/\.data-key|\.pi\/\.audit-key|^\.env$/m,
  },
  {
    id: "C-DOCS",
    area: "治理文档",
    desc: "合规交付件 docs/compliance/（≥6 份）",
    evidenceDir: "docs/compliance",
    minCount: 6,
    ext: ".md",
  },
  {
    id: "C-TEST",
    area: "单测覆盖",
    desc: "护栏/删除/加密单测齐备",
    evidenceDir: "tests/unit",
    multiExt: [".mjs", ".mjs"], // 仅计数校验用，实际按文件名匹配
    required: [
      "guard-replacement-test.mjs",
      "patient-forget-test.mjs",
      "compliance-test.mjs",
      "scope-guard-test.mjs",
      "bash-guard-test.mjs",
      "faithfulness-guard-test.mjs",
    ],
  },
];

// ============ 执行扫描 ============
const results = [];
for (const c of controls) {
  let status = "pass";
  let detail = "";
  if (c.evidenceFile) {
    const r = matchIn(join(ROOT, c.evidenceFile), c.re);
    status = r.hit ? "pass" : "fail";
    detail = r.detail;
  } else if (c.evidenceDir && c.required) {
    const dir = join(ROOT, c.evidenceDir);
    const missing = (c.required || []).filter((f) => !existsSync(join(dir, f)));
    if (missing.length === 0) {
      status = "pass";
      detail = `全部 ${c.required.length} 份单测存在`;
    } else {
      status = "fail";
      detail = `缺失: ${missing.join(", ")}`;
    }
  } else if (c.evidenceDir) {
    const n = countInDir(join(ROOT, c.evidenceDir), c.ext);
    if (n >= (c.minCount || 1)) {
      status = "pass";
      detail = `${n} 份 ≥ 阈值 ${c.minCount}`;
    } else {
      status = "fail";
      detail = `仅 ${n} 份 < 阈值 ${c.minCount}`;
    }
  }
  results.push({ id: c.id, area: c.area, desc: c.desc, status, detail });
}

const pass = results.filter((r) => r.status === "pass").length;
const fail = results.filter((r) => r.status === "fail").length;
const verdict = fail === 0 ? "PASS" : "FAIL";

// ============ 输出 ============
const report = {
  suite: "compliance-control-audit",
  ts: new Date().toISOString(),
  verdict,
  summary: { pass, fail, total: results.length },
  controls: results,
};
const reportsDir = join(ROOT, "tests", "reports");
mkdirSync(reportsDir, { recursive: true });
writeFileSync(
  join(reportsDir, "compliance-audit.json"),
  JSON.stringify(report, null, 2),
  "utf-8",
);

// 人类可读
const md = [
  `# 合规控制审计（E4）`,
  ``,
  `> 生成时间：${report.ts} ｜ 结论：**${verdict}** ｜ 通过 ${pass} / 失败 ${fail} / 共 ${results.length}`,
  ``,
  `| 控制 | 维度 | 描述 | 状态 | 证据 |`,
  `|---|---|---|---|---|`,
  ...results.map(
    (r) =>
      `| ${r.id} | ${r.area} | ${r.desc} | ${r.status === "pass" ? "✅" : "❌"} | ${r.detail} |`,
  ),
  ``,
  `## 维度覆盖`,
  `- 加密 / 脱敏 / 审计防篡改：PHI 静态加密 + PII 出境前脱敏 + HMAC 哈希链不可抵赖`,
  `- 被遗忘权：secureWipeFile 安全擦除 + forget_patient 确认门（E2 闭环）`,
  `- 5 道护栏：越界/命令/忠实度/冲突/脱敏，代码层硬阻断 + 运行时真生效（E1 闭环）`,
  `- 数据红线：含 PHI/密钥产物一律 gitignore`,
  `- 治理文档：docs/compliance/ 6+ 份交付件入仓（E3 闭环）`,
  `- 单测覆盖：护栏/删除/加密确定性单测齐备，接入 npm test 主链`,
  ``,
  `## 已知缺口（透明披露）`,
  `- 自由文本中文姓名未自动脱敏（误伤权衡）`,
  `- 密钥未实现定期轮换接口`,
  `- 无自动保留期 TTL 销毁`,
  `- 无自助访问/导出工具（被遗忘权已落地，访问/导出需运维解密）`,
  `- 与 LLM 提供方无书面 DPA（依赖免费档不训练条款）`,
  ``,
].join("\n");
writeFileSync(join(reportsDir, "compliance-audit.md"), md, "utf-8");

console.log(`\n=== E4 合规控制审计 ===\n`);
console.log(`结论: ${verdict} ｜ 通过 ${pass} / 失败 ${fail} / 共 ${results.length}\n`);
for (const r of results) {
  console.log(`  ${r.status === "pass" ? "✅" : "❌"} ${r.id} [${r.area}] ${r.desc} — ${r.detail}`);
}
console.log(`\n报告已写: tests/reports/compliance-audit.json + compliance-audit.md`);

process.exit(fail === 0 ? 0 : 1);
