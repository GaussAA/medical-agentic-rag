/**
 * 指南查找工具 - 已废弃（由 retrieval.orchestrator.ts 的 `retrieve` 工具替代）
 *
 * 路由逻辑已抽取至 ./lib/guide-router.mjs（纯函数 + 文件化缓存），
 * 由 retrieval.orchestrator.ts 内部调用，不再作为独立工具注册。
 *
 * 本文件保留为空壳，避免 Pi 扩展加载器报"文件缺失"。
 * 若移除本文件，须同步更新 .pi/extensions.json。
 */
export default function () {
  // 已废弃：guide_finder 不再作为独立工具注册。
  // 其功能由 retrieve 工具（retrieval.orchestrator.ts）内部自动完成。
}
