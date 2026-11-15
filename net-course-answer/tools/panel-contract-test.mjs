#!/usr/bin/env node
// runtime ↔ panel 接口契约测试(node tools/panel-contract-test.mjs)
//
// 为什么需要这个测试:
//   2026-09-29 那次改动给 runtime.js 加了取消令牌, 写了 panel.setAnswerRunning(...) /
//   panel.setAutoAnswer(...) 两个调用 —— 但 panel.js 里根本没有这两个方法, 面板也没接
//   onStopAnswer / onAutoAnswerChange 两个回调。
//   结果: node build.mjs 成功、8 套单测全绿, 产物装进浏览器点「取答案」才 TypeError。
//   构建器和单测都发现不了, 因为这是"两个文件之间的约定", 不是任何一边的内部逻辑。
//
// 本测试是通用护栏, 不是给某一个方法打补丁:
//   ① runtime 里每一次 `panel.X(...)` 调用, Panel 上必须有 X —— 以后新增调用自动被管住
//   ② runtime 注入的每一个 `panel.onXxx` 回调, panel.js 里必须真的被调用过(不是注入了没人用)
//   ③ 面板的公开方法在未挂载(root=null)时不得抛异常 —— 防止"顺序一换就炸"
globalThis.window = globalThis;

const fs = await import("node:fs");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✅ " + msg);
  } else {
    fail++;
    console.log("  ❌ " + msg);
  }
};

const runtimeSrc = read("src/runtime.js");
const panelSrc = read("src/ui/panel.js");

const { Panel } = await import("../src/ui/panel.js");

/* ---------- ① 每次 panel.X(...) 调用, Panel 上必须有 X ---------- */

// 只抓"调用"(panel.X 后面跟 `(`), 不抓赋值(panel.X = ...) —— 赋值是 runtime 往面板塞回调, 方向相反。
// 注意 onXxx: runtime 也会 `panel.onXxx && panel.onXxx(...)` 反过来触发自己注入的回调, 那是②管的事,
// 不算"要求面板实现的方法", 所以这里先剔掉。
const called = new Set();
for (const m of runtimeSrc.matchAll(/\bpanel\.([A-Za-z_$][\w$]*)\s*\(/g)) {
  if (!/^on[A-Z]/.test(m[1])) called.add(m[1]);
}

ok(called.size >= 10, `runtime 调用了 ${called.size} 个面板方法(样本量正常)`);

const missing = [...called].filter((name) => typeof Panel.prototype[name] !== "function");
ok(missing.length === 0, `runtime 调用的面板方法都存在${missing.length ? " —— 缺失: " + missing.join(", ") : ""}`);

/* ---------- ② runtime 注入的每个 onXxx, 面板必须真的会调它 ---------- */

const injected = new Set();
for (const m of runtimeSrc.matchAll(/\bpanel\.(on[A-Z][\w$]*)\s*=/g)) injected.add(m[1]);

ok(injected.size >= 5, `runtime 注入了 ${injected.size} 个面板回调`);

const neverFired = [...injected].filter((name) => !new RegExp(`this\\.${name}\\b`).test(panelSrc));
ok(
  neverFired.length === 0,
  `runtime 注入的回调面板都会触发${neverFired.length ? " —— 注入了却没人调: " + neverFired.join(", ") : ""}`
);

/* ---------- ③ 未挂载时调公开方法不得抛异常 ---------- */

const panel = new Panel({ log: () => {} });
ok(panel.root === null, "新建面板未挂载(root 为空)");

const safeCalls = [
  ["setAnswerRunning", [true]],
  ["setAnswerRunning", [false]],
  ["setAutoAnswer", [false]],
  ["setBridge", [true]],
  ["setAnswerProgress", [1, 3, "测试中"]],
  ["setCourseProgress", ["测试", 50]],
  ["setCourseState", ["运行中"]],
  ["setCourseOn", [true]],
  ["resetQuestions", []],
  ["clearQuestions", []],
];
const thrown = [];
for (const [name, args] of safeCalls) {
  try {
    Panel.prototype[name].apply(panel, args);
  } catch (e) {
    thrown.push(`${name}(): ${e.message}`);
  }
}
ok(thrown.length === 0, `未挂载时公开方法不抛异常${thrown.length ? " —— " + thrown.join(" | ") : ""}`);

/* ---------- ④ 「停止」入口必须真的接上 ---------- */

ok(/\.nca-stop/.test(panelSrc), "面板有「停止」按钮");
ok(/this\.onStopAnswer\s*&&/.test(panelSrc), "「停止」按钮接到 onStopAnswer");
ok(typeof Panel.prototype.setAnswerRunning === "function", "Panel 实现 setAnswerRunning");
ok(typeof Panel.prototype.setAutoAnswer === "function", "Panel 实现 setAutoAnswer");

/* ---------- ⑤ runtime 的取消令牌链路完整 ---------- */

ok(/import\s*\{[^}]*createCancelToken[^}]*\}/.test(runtimeSrc), "runtime 引入 createCancelToken");
ok(/function startAnswerRun/.test(runtimeSrc) && /function finishAnswerRun/.test(runtimeSrc), "runtime 有起/停配对");
const startCalls = (runtimeSrc.match(/startAnswerRun\(\)/g) || []).length;
const finishCalls = (runtimeSrc.match(/finishAnswerRun\(run\)/g) || []).length;
ok(startCalls > 0 && startCalls === finishCalls, `每轮 startAnswerRun 都有对应 finishAnswerRun(${startCalls}/${finishCalls})`);

console.log(`\n${fail ? "❌" : "✅"} 全部通过: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
