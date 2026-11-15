#!/usr/bin/env node
// 产物冒烟(node tools/bundle-smoke.mjs): 确认 build.mjs 拼出来的单文件能加载、能挂到 bootstrap。
// 为什么需要: 构建器把 22 个模块拼进同一个 IIFE —— 别名导入(已有护栏)和顶层重名(已有护栏)
// 之外, 还有一类问题单测看不出来: 模块拼接顺序导致的 TDZ/未定义名(例如在依赖初始化前就取值)。
// 这里用最小 window/document 桩把产物整体执行一遍, 不去碰网络、不挂面板。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "net-course-answer.user.js");

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

const code = fs.readFileSync(BUNDLE, "utf8");
ok(code.length > 100000, `产物大小正常(${code.length} B)`);
ok(/==UserScript==/.test(code), "带油猴头部");

// 最小桩: 没有 document.body → bootstrap 里的 boot() 会 setTimeout 等下一次, 测试随即结束
globalThis.window = globalThis;
globalThis.document = { readyState: "loading", body: null, addEventListener: () => {} };

let threw = null;
try {
  new Function(code)();
} catch (e) {
  threw = e;
}
ok(!threw, `整体执行不抛异常${threw ? "(实际: " + threw.message + ")" : ""}`);
ok(typeof globalThis.__NCA_BOOTSTRAP__ === "function", "挂上了 window.__NCA_BOOTSTRAP__");

// 再显式跑一次入口(仍然只应走到\"等 body\"这一步)
let bootThrew = null;
try {
  globalThis.__NCA_BOOTSTRAP__();
} catch (e) {
  bootThrew = e;
}
ok(!bootThrew, `bootstrap() 可重复调用${bootThrew ? "(实际: " + bootThrew.message + ")" : ""}`);

// 外部工具依赖的类名(改面板外壳时不能弄丢)
for (const cls of [".nca-panel", ".nca-log", ".nca-copy-log", ".nca-course-state", ".nca-rate", ".nca-autosubmit", ".nca-submitrate", ".nca-threshold-range"]) {
  ok(code.includes(cls), `产物含 ${cls}`);
}

// 版本号单源: 头部 @version、src/version.js、package.json 三处必须一致
// (0.5.2 那次游离构建就是因为版本号多处各写一遍, 装上去和仓库对不上, 排错排了很久)
{
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const verSrc = fs.readFileSync(path.join(ROOT, "src", "version.js"), "utf8");
  const srcVersion = (verSrc.match(/VERSION\s*=\s*["']([^"']+)["']/) || [])[1];
  const headVersion = (code.match(/^\/\/ @version\s+(\S+)/m) || [])[1];
  ok(!!headVersion, `产物头部有 @version(${headVersion})`);
  ok(headVersion === pkgVersion, `头部 @version 与 package.json 一致(${headVersion} / ${pkgVersion})`);
  ok(srcVersion === pkgVersion, `src/version.js 与 package.json 一致(${srcVersion} / ${pkgVersion})`);
  ok(code.includes("const VERSION = "), "产物里带 VERSION 常量(面板状态栏读数来源)");
  ok((code.match(/==UserScript==/g) || []).length === 1, "UserScript 头只出现一次(meta.js 未混进运行时)");
}

console.log(`\n${fail ? "❌" : "✅"} 全部通过: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
