// scripts/service/node-bin.mjs
// 解析受控 Node 二进制路径，并把 Git-Bash 风格 /c/... 规整为原生 C:/...
// （node 的 child_process.spawn 不做 shell 路径转换，必须传原生形式，否则 ENOENT）。
//
// 2026-07-17 P0-1 修复：原 MANAGED_NODE 写死 `C:/Users/JaNiy/...` 用户名，
//   跨机即失效。现统一委托 scripts/lib/config.mjs（由 process.env / os.homedir() 推导，
//   保留本文件对外的 { resolveNodeBin, toNativePath } 导出契约不变）。

export { resolveNodeBin, toNativePath } from "../lib/config.mjs";
