/**
 * session-picker.mjs — 可复用的交互式会话选择器
 * ================================================
 *
 * 基于 ctx.ui 能力（input + select）封装的选择 + 搜索交互流程，
 * 供 /archive 及其他需要选择会话的命令复用。
 *
 * 交互流程：
 *   1. 显示所有会话列表（编号 + 摘要）
 *   2. 用户输入搜索词过滤（或留空显示全部）
 *   3. select 交互式选择（↑↓ 导航 + 回车确认）
 *
 * 返回选中的会话对象，或 null（取消）。
 *
 * @module session-picker
 */

/**
 * 交互式选择会话
 * @param {object} ctx — ExtensionCommandContext
 * @param {Array<{id:string, path:string, name?:string, mtime:Date, messageCount:number, firstMessage:string}>} sessions
 * @param {object} [opts]
 * @param {string} [opts.title] — 标题，默认"选择会话"
 * @param {boolean} [opts.showAllOption] — 是否显示"全部归档"选项
 * @returns {Promise<{session: object|null, all: boolean}>}
 *   session: 选中的会话对象（null 表示取消）
 *   all: true 表示用户选择了"全部"
 */
export async function pickSession(ctx, sessions, opts = {}) {
  const { title = "选择会话", showAllOption = false } = opts;

  if (sessions.length === 0) {
    ctx.ui.notify("没有可用的会话。", "info");
    return { session: null, all: false };
  }

  // ── 第 1 步：搜索过滤 ──
  const keyword = await ctx.ui.input(
    `搜索会话（输入关键词过滤，留空显示全部，共 ${sessions.length} 条）:`,
    "",
  );

  let filtered = sessions;
  if (keyword && keyword.trim()) {
    const kw = keyword.trim().toLowerCase();
    filtered = sessions.filter((s) => {
      const first = (s.firstMessage || "").toLowerCase();
      const name = (s.name || "").toLowerCase();
      return first.includes(kw) || name.includes(kw);
    });
    if (filtered.length === 0) {
      ctx.ui.notify(`未找到包含「${keyword.trim()}」的会话。`, "warning");
      return { session: null, all: false };
    }
  }

  // ── 第 2 步：交互式选择 ──
  const options = filtered.map((s) => {
    const time = s.mtime.toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const preview = (s.firstMessage || "").slice(0, 30);
    return `[${s.id.slice(0, 8)}] ${preview}  ${s.messageCount}条 ${time}`;
  });

  if (showAllOption) options.push("── 全部 ──");
  options.push("取消");

  const choice = await ctx.ui.select(`${title}（↑↓选择，回车确认）:`, options);
  if (!choice || choice === "取消") {
    ctx.ui.notify("已取消。", "info");
    return { session: null, all: false };
  }

  if (choice === "── 全部 ──") {
    return { session: null, all: true };
  }

  // 从选项文本提取会话 ID
  const idMatch = choice.match(/\[([^\]]+)\]/);
  const sessionId = idMatch ? idMatch[1] : "";
  const matched = filtered.find((s) => s.id.startsWith(sessionId));
  if (!matched) {
    ctx.ui.notify("未找到匹配的会话。", "error");
    return { session: null, all: false };
  }

  return { session: matched, all: false };
}
