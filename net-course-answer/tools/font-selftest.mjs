#!/usr/bin/env node
// 字体解密链路离线自检。
//
// 子命令/模式:
//   1) node tools/font-selftest.mjs
//        基础自检: md5 标准向量 + vendor Typr 与「字形表生成环境所用 Typr」的一致性
//        (对照文件 tools/.cache/TyprMd5.js, 可选) + 真实字体解析/取字形冒烟。
//   2) node tools/font-selftest.mjs --font <cx-secret-0.ttf> [--text cx-secret-text.txt]
//        拿真实超星加密字体跑「真表」解密: 打印命中码点数与解密预览, 以及密文文件解密结果。
//        (这是唯一能判定 P0 是否真正跑通的离线验证; 加密字体用 tools/dump-font.js 从答题页导出)
//   3) node tools/font-selftest.mjs --identity <font>
//        在系统字体上做「标准字形恒等映射」探测。⚠️ 字形表是用某个特定基准字体生成的,
//        系统字体不匹配属正常现象, 恒等率为 0 并不代表链路有错; 仅作参考。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis; // vendor Typr 顶层引用 window.TextDecoder
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".cache");
const TABLE_CACHE = path.join(CACHE_DIR, "table.json");
const CANONICAL_TYPR = path.join(CACHE_DIR, "TyprMd5.js");
const TABLE_URL = "https://www.forestpolice.org/ttf/2.0/table.json";
const CANONICAL_TYPR_URL = "https://scriptcat.org/lib/668/1.0/TyprMd5.js";

const { Typr } = await import(new URL("../src/vendor/typr.js", import.meta.url));
const { md5 } = await import(new URL("../src/vendor/md5.js", import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

async function loadTable() {
  if (fs.existsSync(TABLE_CACHE)) return JSON.parse(fs.readFileSync(TABLE_CACHE, "utf8"));
  console.log(`下载字形表 ${TABLE_URL} …`);
  const res = await fetch(TABLE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const txt = await res.text();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(TABLE_CACHE, txt);
  return JSON.parse(txt);
}

/** 读字体: 支持二进制 ttf/ttc/otf, 或文本形式的 base64(自动识别) */
function readFont(file) {
  const buf = fs.readFileSync(file);
  const head = buf.slice(0, 4).toString("binary");
  if (head === "\x00\x01\x00\x00" || head === "OTTO" || head === "ttcf" || head === "true") {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const txt = buf.toString("utf8").trim();
  const m = txt.match(/base64,([\w\W]+?)['")\s]/) || txt.match(/^([A-Za-z0-9+/=\s]{100,})$/);
  const b64 = (m ? m[1] || m[0] : txt).replace(/\s+/g, "");
  return Buffer.from(b64, "base64").buffer;
}

function checkMd5() {
  const vectors = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["The quick brown fox jumps over the lazy dog", "9e107d9d372bb6826bd81d3542a419d6"],
    ["中文测试", "089b4943ea034acfa445d050c7913e55"],
  ];
  let ok = 0;
  for (const [input, want] of vectors) {
    if (md5(input) === want) ok += 1;
    else console.log(`  ✗ md5(${JSON.stringify(input)}) = ${md5(input)}, 期望 ${want}`);
  }
  console.log(`md5 标准向量: ${ok}/${vectors.length} ${ok === vectors.length ? "✅" : "❌"}`);
  return ok === vectors.length;
}

/** vendor Typr vs 字形表生成环境所用 Typr(photopea) 的一致性 */
function checkTyprParity() {
  if (!fs.existsSync(CANONICAL_TYPR)) {
    console.log(`Typr 一致性: ⏭ 跳过(无对照文件 ${path.relative(process.cwd(), CANONICAL_TYPR)})`);
    console.log(`  获取方式: curl -L -o "${CANONICAL_TYPR}" ${CANONICAL_TYPR_URL}`);
    return true;
  }
  const src = fs.readFileSync(CANONICAL_TYPR, "utf8");
  const ctx = { console: { log() {}, warn() {}, error() {} }, TextEncoder, DOMParser: class {}, fetch: () => Promise.reject(new Error("x")) };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const Theirs = ctx.Typr;
  const fonts = ["C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/msyh.ttc"].filter((f) => fs.existsSync(f));
  if (!fonts.length) {
    console.log("Typr 一致性: ⏭ 跳过(无本机中文字体可比)");
    return true;
  }
  let ok = true;
  for (const f of fonts) {
    const buf = fs.readFileSync(f);
    const f1 = Typr.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))[0];
    const f2 = Theirs.parse(new Uint8Array(buf))[0];
    let same = 0;
    let diff = 0;
    for (let cp = 0x4e00; cp < 0x4e00 + 300; cp++) {
      const g1 = Typr.U.codeToGlyph(f1, cp);
      const g2 = Theirs.U.codeToGlyph(f2, cp);
      if (g1 !== g2) {
        diff += 1;
        continue;
      }
      if (!g1) continue;
      const p1 = JSON.stringify(Typr.U.glyphToPath(f1, g1));
      const p2 = JSON.stringify(Theirs.U.glyphToPath(f2, g2));
      if (p1 === p2) same += 1;
      else diff += 1;
    }
    console.log(`  ${path.basename(f)}: 相同 ${same}, 不同 ${diff}`);
    if (diff) ok = false;
  }
  console.log(`Typr 一致性(vs 字形表生成环境): ${ok ? "✅ 完全一致(哈希可复现)" : "❌ 存在差异 → 解密会失败, 请还原 vendor Typr"}`);
  return ok;
}

async function runRealFont(fontFile, textFile) {
  const table = await loadTable();
  const font = Typr.parse(readFont(fontFile))[0];
  const map = new Map();
  for (let cp = 19968; cp < 40870; cp++) {
    let gid;
    try {
      gid = Typr.U.codeToGlyph(font, cp);
    } catch (e) {
      break;
    }
    if (!gid) continue;
    const real = table[md5(JSON.stringify(Typr.U.glyphToPath(font, gid))).slice(24)];
    if (real) map.set(cp, real);
  }
  const covered = Array.from(map.keys()).filter((c) => c >= 0x4e00).length;
  console.log(`字形表: ${Object.keys(table).length} 条`);
  console.log(`加密字体: ${fontFile}`);
  console.log(`命中码点: ${map.size} / 20902 (${((map.size / 20902) * 100).toFixed(1)}%)`);
  console.log(
    map.size > 5000
      ? "✅ 命中率正常, 解密链路可用(真实字体 + 真实表)"
      : "❌ 命中率异常低 → Typr 版本/表来源/字体数据有问题"
  );
  const preview = Array.from(map.entries()).slice(0, 200).map(([, r]) => String.fromCharCode(r)).join("");
  console.log(`\n明文预览(前 200 个映射, 应基本是可读汉字):\n${preview}`);

  if (textFile && fs.existsSync(textFile)) {
    const raw = fs.readFileSync(textFile, "utf8");
    const dec = Array.from(raw).map((ch) => (map.has(ch.charCodeAt(0)) ? String.fromCharCode(map.get(ch.charCodeAt(0))) : ch)).join("");
    console.log(`\n密文文件解密结果(${textFile}):\n${dec.slice(0, 1200)}`);
  }
  return map.size > 5000 && covered > 0;
}

function runIdentity(fontFile) {
  const table = JSON.parse(fs.readFileSync(TABLE_CACHE.replace("table.json", "table1.json"), "utf8"));
  const font = Typr.parse(readFont(fontFile))[0];
  let tested = 0;
  let hit = 0;
  for (let cp = 0x4e00; cp < 0x9fa6; cp++) {
    const gid = Typr.U.codeToGlyph(font, cp);
    if (!gid) continue;
    tested += 1;
    if (table[md5(JSON.stringify(Typr.U.glyphToPath(font, gid)))] !== undefined) hit += 1;
  }
  console.log(`${fontFile}: 测试 ${tested}, 表内命中 ${hit} (${((hit / Math.max(tested, 1)) * 100).toFixed(1)}%)`);
  console.log(
    hit === 0
      ? "提示: 命中 0 属正常 —— 字形表由某个特定基准字体生成, 系统字体不是它。判定解密是否可用请用 --font(真实加密字体)。"
      : "命中 >0: 该字体与生成表的基准字体形状一致。"
  );
  return true;
}

const fontArg = flag("--font");
if (fontArg) {
  const ok = await runRealFont(fontArg, flag("--text"));
  process.exit(ok ? 0 : 1);
}
const identityArg = flag("--identity");
if (identityArg) {
  runIdentity(identityArg);
  process.exit(0);
}

console.log("== 基础自检 ==\n");
const a = checkMd5();
console.log("");
const b = checkTyprParity();
console.log("");
const ok = a && b;
console.log(ok ? "✅ 基础自检通过。真正判定解密是否可用请跑: node tools/font-selftest.mjs --font <cx-secret-0.ttf>" : "❌ 基础自检失败");
process.exit(ok ? 0 : 1);
