/**
 * 知识图谱搜索工具 - 已废弃（由 retrieval.orchestrator.ts 的 `retrieve` 工具替代）
 *
 * 其内部逻辑 searchKG() 函数已被 retrieval.orchestrator.ts 在 KG 补充阶段直接调用。
 * 本文件保留为空壳，避免 Pi 扩展加载器报"文件缺失"。
 */
export default function () {
  // 已废弃：kg_search 不再作为独立工具注册。
  // 其功能由 retrieve 工具（retrieval.orchestrator.ts）内部自动完成。
}
