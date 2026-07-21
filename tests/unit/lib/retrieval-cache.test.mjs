// retrieval-cache-test.mjs
// 验证容量上限（LRU 近似裁剪）+ 过期回收（gcExpired）+ TTL 命中语义。
// 通过 RETRIEVAL_CACHE_DIR / RETRIEVAL_CACHE_MAX_ENTRIES 注入测试环境，不影响默认行为。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "rcache-test-"));
process.env.RETRIEVAL_CACHE_DIR = TMP;
process.env.RETRIEVAL_CACHE_MAX_ENTRIES = "10";

const { cacheGet, cacheSet, gcExpired, cacheStats, cacheClear } = await import(
  "../../../.pi/extensions/lib/retrieval-cache.mjs"
);

test("容量上限：超容按写入时间 LRU 近似裁剪到 MAX_ENTRIES", () => {
  cacheClear();
  for (let i = 0; i < 25; i++) cacheSet(`k${i}`, `v${i}`);
  const s = cacheStats();
  assert.equal(s.total, 10, "应裁剪到 MAX_ENTRIES=10");
  // 保留的应为最后写入的 10 个（k15..k24）
  for (let i = 15; i < 25; i++) assert.equal(cacheGet(`k${i}`), `v${i}`, `k${i} 应保留`);
  // 最旧的应被裁掉
  assert.equal(cacheGet("k0"), undefined, "k0 应被裁剪");
});

test("未过期仍命中（显式 TTL）", () => {
  cacheClear();
  cacheSet("fresh", "data", 60000);
  assert.equal(cacheGet("fresh"), "data");
});

test("默认 TTL（10min）内命中", () => {
  cacheClear();
  cacheSet("a", 1);
  assert.equal(cacheGet("a"), 1);
});

test("过期回收：gcExpired 清理过期条目", async () => {
  cacheClear();
  cacheSet("ephemeral", "x", 5); // 5ms TTL
  await new Promise((r) => setTimeout(r, 20)); // 等待过期
  const removed = gcExpired();
  assert.ok(removed >= 1, "应至少回收 1 条过期");
  assert.equal(cacheGet("ephemeral"), undefined, "过期后读取应 miss");
  assert.equal(cacheStats().total, 0, "回收后磁盘为空");
});

test("cacheGet 命中过期：内存标记丢弃且不返回陈旧值", async () => {
  cacheClear();
  cacheSet("slow", "old", 5); // 5ms
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cacheGet("slow"), undefined, "过期项读取应 miss");
});

test("teardown：清理临时缓存目录", () => {
  cacheClear();
  rmSync(TMP, { recursive: true, force: true });
});
