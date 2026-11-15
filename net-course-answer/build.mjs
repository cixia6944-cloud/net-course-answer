#!/usr/bin/env node
// 纯 node 构建器:把 src/ 下 ESM 源码合并成单个油猴 .user.js。
// 无第三方依赖。做法: 从 runtime.js 出发做静态 import 解析(相对路径), 按依赖序拼接模块体,
// 去掉 import/export 语句, 全部模块体放进一个 IIFE, 顶部注入 UserScript header。

/* ALIASED_IMPORT_GUARD: 构建器把模块拼进同一作用域, 只支持"原名导入"。
   `import { a as b }` 会让 b 在产物里未定义(单测发现不了, 只有产物运行才炸) → 直接报错。 */
const ALIAS_RE = /import\s*\{[^}]*\bas\b[^}]*\}\s*from/g;
/* DUPLICATE_NAME_GUARD: 模块体拼进同一个 IIFE, 两个模块顶层的同名 const/function 会互相覆盖
   (后一个干掉前一个), 单测也发现不了 —— 这里也在构建期报错。
   ⚠️ 必须含 `async function`(和 `export async function`): 否则这类顶层声明逃过护栏。 */
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USERSCRIPT_HEADER } from "./src/meta.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "src");
const DIST_DIR = path.join(__dirname, "dist");

/** 解析 import 语句: 返回 {spec, names, defaultName} 列表 */
function parseImports(code) {
  const imports = [];
  const re = /import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[1].trim();
    const spec = m[2];
    let names = [];
    let defaultName = null;
    if (clause.startsWith("* as ")) {
      names.push({ local: clause.slice(5).trim(), star: true });
    } else if (clause.startsWith("{")) {
      const inner = clause.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const item of inner) {
        const [orig, , local] = item.split(/\s+as\s+| /); // orig as local | orig
        names.push({ local: local || orig, orig });
      }
    } else {
      defaultName = clause;
    }
    imports.push({ spec, names, defaultName });
  }
  return imports;
}

/** 去掉整段 import(含多行) */
function stripImports(code) {
  return code.replace(/import\s+([^;]+?)\s+from\s+["'][^"']+["']\s*;?/g, "").replace(/export\s+/g, "");
}

/** 递归收集模块, 返回按依赖序(被依赖在前)的 [ {file, body} ] */
function collectModules(entryFile, seen = new Set(), order = [], missing = []) {
  const abs = path.resolve(entryFile);
  if (seen.has(abs)) return order;
  seen.add(abs);
  const code = fs.readFileSync(abs, "utf8");
  for (const imp of parseImports(code)) {
    if (!imp.spec.startsWith(".")) continue; // 仅处理相对路径内部模块
    const resolved = path.resolve(path.dirname(abs), imp.spec + (imp.spec.endsWith(".js") ? "" : ".js"));
    /* MISSING_IMPORT_GUARD: 解析不到的相对导入以前是静默 continue —— 文件被挪走/改名时
       整个模块连同它后面的一切悄悄从产物里消失(产物变小但构建"成功", 单测也照绿)。
       这里必须报错。 */
    if (!fs.existsSync(resolved)) missing.push({ from: abs, spec: imp.spec, resolved });
    else collectModules(resolved, seen, order, missing);
  }
  order.push({ file: abs, code });
  return order;
}

function build() {
  const entry = path.join(SRC, "runtime.js");
  const missing = [];
  const modules = collectModules(entry, new Set(), [], missing);

  // 护栏: 相对导入解析不到 → 整块模块静默丢失(产物变小、构建却"成功") → 构建期直接报错
  if (missing.length) {
    console.error("✗ 构建中止: 有相对导入解析不到目标文件, 该模块会从产物里静默消失:");
    missing.slice(0, 8).forEach((m) => {
      const rel = path.relative(SRC, m.from).replace(/\\/g, "/");
      console.error(`   ${rel} → ${m.spec}  (解析成 ${path.relative(SRC, m.resolved).replace(/\\/g, "/")})`);
    });
    console.error("   → 检查文件是否被移动/改名; 移动后要同步改所有 import 路径。");
    process.exit(1);
  }

  // 合并体: 每个模块包在块作用域, 去掉 import/export
  const bodies = modules.map(({ file, code }) => {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    return `// ---- module: ${rel} ----\n${stripImports(code)}`;
  });

  const iife = `${USERSCRIPT_HEADER}\n/*!\n * 网课答题助手 — 构建产物, 请勿手改; 改源码后重跑 node build.mjs\n */\n(function () {\n  'use strict';\n\n${bodies.join("\n\n")}\n\n  // ---- bootstrap ----\n  window.__NCA_BOOTSTRAP__ = bootstrap;\n  bootstrap();\n})();\n`;

  // 护栏: 产物末尾是裸标识符 `bootstrap()` —— 入口改名/被删时构建期不报错, 只有装到浏览器才炸。
  {
    const declared = modules.some(({ code }) => /^(?:export\s+)?(?:async\s+)?function\s+bootstrap\s*\(/m.test(code));
    if (!declared) {
      console.error("✗ 构建中止: 没有模块声明 `function bootstrap()`, 产物末尾的 bootstrap() 会 ReferenceError。");
      console.error("   → 入口 src/runtime.js 必须导出 bootstrap, 或同步改 build.mjs 的产物尾部。");
      process.exit(1);
    }
  }

  // 护栏: 别名导入 / 再导出会让产物里出现未定义名(单测发现不了) → 构建期直接报错
  {
    const src = modules.map((m) => m.code).join("\n");
    const bad = src.match(ALIAS_RE) || [];
    if (bad.length) {
      console.error("✗ 构建中止: 检测到别名导入(构建器不支持, 产物会 ReferenceError):");
      bad.slice(0, 5).forEach((b) => console.error("   " + b.replace(/\s+/g, " ").slice(0, 90)));
      console.error("   → 改成 `import { 原名 }` 并在使用处直接调用原名。");
      process.exit(1);
    }
  }

  // 护栏: 两个模块的顶层声明重名 → 拼接后互相覆盖(产物静默出错) → 构建期直接报错
  {
    const seen = new Map(); // 名字 → 模块
    const dups = [];
    for (const { file, code } of modules) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      for (const line of code.split("\n")) {
        const m = DECL_RE.exec(line);
        if (!m) continue;
        const name = m[1];
        if (seen.has(name) && seen.get(name) !== rel) dups.push(`${name}: ${seen.get(name)} ↔ ${rel}`);
        else seen.set(name, rel);
      }
    }
    if (dups.length) {
      console.error("✗ 构建中止: 顶层重名(拼接成单文件后会互相覆盖):");
      dups.slice(0, 8).forEach((d) => console.error("   " + d));
      console.error("   → 改名, 或把其中一个换成块作用域(函数/大括号内)。");
      process.exit(1);
    }
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const out = path.join(DIST_DIR, "net-course-answer.user.js");
  fs.writeFileSync(out, iife, "utf8");
  console.log(`构建完成: ${out} (${fs.statSync(out).size} bytes, ${modules.length} 个模块)`);
}

build();
