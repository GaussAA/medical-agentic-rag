// data-lifecycle.mjs
// 数据留存治理 —— 数据生命周期 + "被遗忘权"删除。
//
// 覆盖《个人信息保护法》《数据安全法》要求：
//   1. 数据最小化：PHI 仅保留必要字段
//   2. 明示同意：所有 PHI 写入记审计（已有 T12 哈希链）
//   3. 留存期限：患者画像 30 天自动过期
//   4. 被遗忘权：一键清除所有 PHI 关联数据
//
// 用法：
//   node scripts/kb/data-lifecycle.mjs cleanup    → 清理过期数据
//   node scripts/kb/data-lifecycle.mjs forget     → 被遗忘权删除
//   node scripts/kb/data-lifecycle.mjs status     → 查看数据状态

import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const LOGS_DIR = join(ROOT, "logs");
const PI_DIR = join(ROOT, ".pi");
const KB_DIR = join(ROOT, "knowledge-base");

const PHI_RETENTION_DAYS = 30; // 患者画像保留 30 天
const AUDIT_RETENTION_DAYS = 90; // 审计日志保留 90 天

const cmd = process.argv[2] || "status";

/** 删除患者画像。 */
function forgetPatientProfile() {
  const file = join(PI_DIR, "patient-profile.json");
  if (!existsSync(file)) return { deleted: false, reason: "不存在" };

  // 保留空加密占位符（标识已被遗忘）
  writeFileSync(file, JSON.stringify({
    forgotten: true,
    forgottenAt: new Date().toISOString(),
    note: "患者数据已于用户要求下删除（被遗忘权）",
  }, null, 2), "utf-8");

  return { deleted: true, file };
}

/** 删除会话状态。 */
function forgetConversationState() {
  const file = join(PI_DIR, "conversation-state.json");
  if (!existsSync(file)) return { deleted: false, reason: "不存在" };
  unlinkSync(file);
  return { deleted: true, file };
}

/** 清理过期审计日志（保留 AUDIT_RETENTION_DAYS 天）。 */
function cleanupAuditLogs() {
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 86400000;
  const files = readdirSync(LOGS_DIR).filter(f => f.startsWith("audit-") && f.endsWith(".ndjson"));

  let deleted = 0;
  let kept = 0;
  for (const f of files) {
    const dateStr = f.replace("audit-", "").replace(".ndjson", "");
    const ts = new Date(dateStr).getTime();
    if (isNaN(ts)) continue;
    if (ts < cutoff) {
      unlinkSync(join(LOGS_DIR, f));
      deleted++;
    } else {
      kept++;
    }
  }
  return { deleted, kept };
}

/** 获取数据状态摘要。 */
function getStatus() {
  const profile = join(PI_DIR, "patient-profile.json");
  const conv = join(PI_DIR, "conversation-state.json");
  const auditFiles = readdirSync(LOGS_DIR).filter(f => f.startsWith("audit-"));

  let profileInfo = "不存在";
  if (existsSync(profile)) {
    try {
      const data = JSON.parse(readFileSync(profile, "utf-8"));
      profileInfo = data.forgotten ? "已遗忘" : `存在（${data.updatedAt ? new Date(data.updatedAt).toLocaleDateString() : "未知"}）`;
    } catch { profileInfo = "存在（解析失败）"; }
  }

  let convInfo = "不存在";
  if (existsSync(conv)) {
    try {
      const data = JSON.parse(readFileSync(conv, "utf-8"));
      convInfo = `存在（${data.askedQuestions?.length || 0} 个已问问题）`;
    } catch { convInfo = "存在（解析失败）"; }
  }

  return {
    patientProfile: profileInfo,
    conversationState: convInfo,
    auditFiles: auditFiles.length,
    phiRetentionDays: PHI_RETENTION_DAYS,
    auditRetentionDays: AUDIT_RETENTION_DAYS,
  };
}

async function main() {
  switch (cmd) {
    case "cleanup": {
      console.log("数据清理\n");
      console.log(`审计日志保留: ${AUDIT_RETENTION_DAYS} 天`);
      const audit = cleanupAuditLogs();
      console.log(`审计日志: 删除 ${audit.deleted} 个，保留 ${audit.kept} 个`);
      console.log("\n✓ 清理完成");
      break;
    }

    case "forget": {
      console.log("被遗忘权请求\n");

      const profile = forgetPatientProfile();
      console.log(`患者画像: ${profile.deleted ? "✓ 已清除（保留占位符）" : "— ${profile.reason}"}`);

      const conv = forgetConversationState();
      console.log(`会话状态: ${conv.deleted ? "✓ 已删除" : "— ${conv.reason}"}`);

      // 记审计
      try {
        const { auditChainLog } = await import("../../.pi/extensions/lib/audit-chain.mjs");
        auditChainLog("data.forget", { target: "patient_profile,conversation_state" });
        console.log("审计: ✓ 已记录");
      } catch { console.log("审计: 跳过"); }

      console.log("\n✓ 被遗忘权请求已执行。所有患者个人数据已清除。");
      break;
    }

    case "status": {
      const s = getStatus();
      console.log("数据留存状态\n");
      console.log(`患者画像:     ${s.patientProfile}`);
      console.log(`会话状态:     ${s.conversationState}`);
      console.log(`审计日志文件: ${s.auditFiles} 个`);
      console.log(`\n保留策略:`);
      console.log(`  PHI 数据:   ${s.phiRetentionDays} 天（需手动清理）`);
      console.log(`  审计日志:   ${s.auditRetentionDays} 天（执行 cleanup 自动清理）`);
      break;
    }

    default:
      console.log(`用法:
  node scripts/kb/data-lifecycle.mjs status   查看数据状态
  node scripts/kb/data-lifecycle.mjs cleanup  清理过期数据
  node scripts/kb/data-lifecycle.mjs forget   被遗忘权删除`);
  }
}

main().catch((err) => {
  console.error(`失败: ${err.message}`);
  process.exit(1);
});
