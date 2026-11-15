#!/usr/bin/env node
// font-decrypt 单元自测(不依赖真实超星字体)。
// 做法: 用本机一个真实字体"冒充"混淆字体, 并同步合成一张字形表
//   table[ md5(JSON.stringify(glyphToPath(font, code))) ] = code + SHIFT
// 于是"密文码点 C"经 查表→替换 后必须变成 C+SHIFT。
// 这能端到端验证: Typr 解析 → glyphToPath → md5 → 查表 → 正则替换 → 移除类名 → 缓存。
//
// 用法: node tools/font-decrypt-test.mjs [字体路径]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis; // vendor Typr 顶层引用 window.TextDecoder

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const { Typr } = await import(new URL("../src/vendor/typr.js", import.meta.url));
const { md5 } = await import(new URL("../src/vendor/md5.js", import.meta.url));
const { decryptFonts, getLastError, getLastStats, __setTableForTest, __resetFontDecryptCache } = await import(
  new URL("../src/core/font-decrypt.js", import.meta.url)
);

const CANDIDATES = ["C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/Deng.ttf"];
const fontPath = process.argv[2] || CANDIDATES.find((p) => fs.existsSync(p));
if (!fontPath || !fs.existsSync(fontPath)) {
  console.error("找不到可用字体, 请传入字体路径: node tools/font-decrypt-test.mjs <font.ttf>");
  process.exit(1);
}

const SHIFT = 100;
const CODES = [0x4e00, 0x4e01, 0x4e03, 0x4e09, 0x4e0a, 0x4e0b, 0x4e0d, 0x4e2d];
const HEAD = 16;

function makeDoc(styleText, texts) {
  const style = { textContent: styleText };
  const els = texts.map((t) => {
    const cls = new Set(["font-cxsecret"]);
    return {
      _html: t,
      _text: t,
      get innerHTML() {
        return this._html;
      },
      set innerHTML(v) {
        this._html = v;
        this._text = String(v).replace(/<[^>]*>/g, "");
      },
      get textContent() {
        return this._text;
      },
      classList: { remove: (c) => cls.delete(c), has: (c) => cls.has(c) },
    };
  });
  return {
    _els: els,
    querySelectorAll(sel) {
      if (sel === "style") return [style];
      if (sel === ".font-cxsecret") return els.filter((e) => e.classList.has("font-cxsecret"));
      return [];
    },
  };
}

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failures += 1;
}

// ---- 用真实字体 + 合成表 ----
const buf = fs.readFileSync(fontPath);
const font = Typr.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))[0];
const table = {};
for (const cp of CODES) {
  const gid = Typr.U.codeToGlyph(font, cp);
  if (!gid) continue;
  table[md5(JSON.stringify(Typr.U.glyphToPath(font, gid))).slice(24)] = cp + SHIFT;
}
const cipherText = CODES.map((c) => String.fromCharCode(c)).join("");
const plainText = CODES.map((c) => String.fromCharCode(c + SHIFT)).join("");
const styleText =
  `@font-face{font-family:"cxsecret";src:url(data:font/ttf;base64,${buf.toString("base64")}) format('truetype');}` +
  `.font-cxsecret{font-family:cxsecret}`;

console.log(`字体: ${fontPath}`);
console.log(`合成映射: ${Object.keys(table).length} 条(码点 +${SHIFT})\n`);

// 1) 正常解密
__resetFontDecryptCache();
__setTableForTest(table);
let doc = makeDoc(styleText, [cipherText, `<span>${cipherText.slice(0, 4)}</span>`]);
let n = decryptFonts(doc);
check("返回解密元素数 = 2", n === 2, `实际 ${n}`);
check("第 1 个元素已替换为明文", doc._els[0].innerHTML === plainText, `实际 ${JSON.stringify(doc._els[0].innerHTML)}`);
check("第 2 个元素(含标签)已替换", doc._els[1].innerHTML === `<span>${plainText.slice(0, 4)}</span>`, `实际 ${JSON.stringify(doc._els[1].innerHTML)}`);
check("类名 font-cxsecret 已移除", !doc._els[0].classList.has("font-cxsecret"));
const st = getLastStats();
check("统计: 命中码点数 = 合成表条数", st.mapped === Object.keys(table).length, JSON.stringify(st));

// 2) 缓存: 同页再次调用仍应命中(不重新解析字体)
doc = makeDoc(styleText, [cipherText]);
n = decryptFonts(doc);
check("二次调用(走字体缓存)仍解密成功", doc._els[0].innerHTML === plainText, `实际 ${JSON.stringify(doc._els[0].innerHTML)}`);

// 3) 部分命中: 表里没有的码点保持原样
const extra = String.fromCharCode(0x9fa5); // 大概率不在 CODES 里
doc = makeDoc(styleText, [cipherText + extra]);
decryptFonts(doc);
check("未命中码点保持原样", doc._els[0].innerHTML.endsWith(extra));

// 4) 表未就绪 → 0 + 明确错误
__resetFontDecryptCache();
doc = makeDoc(styleText, [cipherText]);
n = decryptFonts(doc);
check("无字形表时返回 0", n === 0, `实际 ${n}`);
check("无字形表时有错误信息", /字形表/.test(getLastError()), getLastError());

// 5) 页面无加密元素 → 0
__resetFontDecryptCache();
__setTableForTest(table);
doc = makeDoc('<style>body{}</style>', []);
n = decryptFonts(doc);
check("无 .font-cxsecret 时返回 0", n === 0, `实际 ${n}`);

console.log(failures ? `\n❌ ${failures} 项失败` : "\n✅ 全部通过");
process.exit(failures ? 1 : 0);
