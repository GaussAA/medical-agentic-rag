// scope-guard-test.mjs
// 越界拦截纯逻辑单测：零 LLM、确定性，进 CI。
// 运行: node tests/unit/scope-guard-test.mjs

import { detectScope, isOutOfScope } from "../../.pi/extensions/lib/scope-guard.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
    console.error("  ✗ " + name);
  }
}

// 1. 明确非医疗 → 越界
ok(isOutOfScope("帮我写一份离婚起诉状"), "离婚起诉状 → 越界");
ok(isOutOfScope("用 python 写个爬虫代码"), "写 python 代码 → 越界");
ok(isOutOfScope("股票怎么买能赚钱"), "炒股 → 越界");
ok(isOutOfScope("算算我的星座运势"), "星座运势 → 越界");
ok(isOutOfScope("红烧肉怎么做"), "菜谱 → 越界");
ok(isOutOfScope("高考志愿怎么填"), "高考志愿 → 越界");

// 2. 医疗相关 → 不越界
ok(!isOutOfScope("高血压患者推荐用什么药"), "高血压用药 → 医疗不越界");
ok(!isOutOfScope("糖尿病饮食需要注意什么"), "糖尿病饮食 → 医疗不越界");
ok(!isOutOfScope("怎么看懂体检报告里的指标"), "体检报告 → 医疗不越界");
ok(!isOutOfScope("感冒发烧吃什么好"), "感冒发烧 → 医疗不越界");
ok(!isOutOfScope("CT 检查结果怎么看"), "CT 检查 → 医疗不越界");

// 3. 边界/无关 → 保守放行（不误伤）
ok(!isOutOfScope("今天天气不错"), "天气 → 保守放行");
ok(!isOutOfScope(""), "空串 → 不越界");

// 4. detectScope 返回结构
{
  const v = detectScope("帮我写离婚协议");
  ok(
    v.outOfScope === true && typeof v.reason === "string" && v.reason.length > 0,
    "detectScope 越界带 reason",
  );
  const w = detectScope("肺癌化疗方案");
  ok(
    w.outOfScope === false && typeof w.reason === "string",
    "detectScope 医疗带 reason",
  );
}

// 5. 大小写归一化（latin 关键词）
ok(isOutOfScope("How to write Java code?"), "Java 代码(大小写) → 越界");

console.log(`\n越界拦截单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
