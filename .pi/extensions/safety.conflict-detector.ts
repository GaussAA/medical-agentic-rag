import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * conflict-detector 跨指南冲突检测扩展
 * -----------------------------------------------------------------------------------
 * 版本冲突已在检索期（rag_search）通过 buildVersionConflictHint 前置标注，
 * 无需在 message_end 阶段重复检测。
 *
 * 本扩展保留为空壳：消除一切 post-response handler 注册，
 * 避免 Pi 框架在 message_end 阶段串行遍历扩展造成 UI spinner 延迟。
 *
 * Layer 2（免费 LLM·内容冲突）已于 2026-07-19 经大帅确认移除。
 */

export default function (_pi: ExtensionAPI) {
  // 无任何钩子注册——零运行时开销
}
