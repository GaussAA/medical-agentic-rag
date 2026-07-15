// scripts/service/node-bin.mjs
// 解析受控 Node 二进制路径，并把 Git-Bash 风格 /c/... 规整为原生 C:/...
// （node 的 child_process.spawn 不做 shell 路径转换，必须传原生形式，否则 ENOENT）。

import { existsSync } from "node:fs";

const MANAGED_NODE =
  "C:/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node.exe";

// 把 /c/Users/... 这类 Git-Bash 路径转为 C:/Users/...（仅 Windows）
export function toNativePath(p) {
  if (!p) return p;
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(p)) {
    return p.replace(/^\/([a-zA-Z])\//, "$1:/");
  }
  return p;
}

export function resolveNodeBin() {
  const fromEnv = process.env.NODE_BIN
    ? toNativePath(process.env.NODE_BIN)
    : "";
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(MANAGED_NODE)) return MANAGED_NODE;
  return "node";
}
