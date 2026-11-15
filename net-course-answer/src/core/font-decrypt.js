// 超星 font-cxsecret 字体解密。
// 机理: 超星把真字符渲染为「混淆字体里的同形字」——DOM 文本是假码点, 字体把假码点映射到
// 真字形状。解密即: 对每个出现过的码点取字形路径 → md5(JSON.stringify(path)).slice(24) → 查
// 字形表得到真 unicode 码点, 再替换文本。
//
// ⚠️ 版本敏感: 字形哈希依赖 Typr 的 curve 取整细节。本工程 vendor 的是 photopea Typr
// (Typr.js@15aa12f + Typr.U.js@f4fcdeb), 与字形表生成环境一致; 换成 npm typr 等分支会导致
// 哈希整体不匹配(表现: 命中 0 个码点, 题面仍乱码)。
//
// 依赖: src/vendor/typr.js + src/vendor/md5.js + 字形表。
// 字形表来源优先级: 调用方传入 → 内存 → GM 存储缓存 → @resource ttf → 网络兜底(prefetchTable)。
import { Typr } from "../vendor/typr.js";
import { md5 } from "../vendor/md5.js";
import { gm, gmFetchJson } from "../vendor/gm.js";
import { CX_STUDY_SEL } from "../contract/cx-study-contract.js";

/** 需要解密的元素选择器(单源: 契约表) */
const SECRET_SEL = "." + CX_STUDY_SEL.font.secretClass;

/** 字形表地址(355 KB, 20902 条; 键=md5 字形哈希后 8 位 hex, 值=真 unicode 码点) */
export const TABLE_URL = "https://www.forestpolice.org/ttf/2.0/table.json";
const GM_TABLE_KEY = "nca_ttf_table";

let tableMem = null;
let tableState = "idle"; // idle | loading | ready | failed
let lastError = "";
let lastStats = { fonts: 0, codes: 0, mapped: 0, elements: 0 };

/** 字体解析结果缓存: 指纹 → Font 实例 */
const parsedFonts = new Map();
/** 码点映射缓存: 指纹 → Map<假码点, 真码点>(0 表示查表失败, 也缓存以免重算) */
const codeMapCaches = new Map();

export function getTableState() {
  return tableState;
}
export function getLastError() {
  return lastError;
}
export function getLastStats() {
  return { ...lastStats };
}
export function hasTable() {
  return !!tableMem;
}

/**
 * 同步取字形表(内存 → GM 存储 → @resource ttf)。
 * @returns {Object|null} 键为 8 位哈希的字形表
 */
export function getTableSync() {
  if (tableMem) return tableMem;
  try {
    const raw = gm.getValue ? gm.getValue(GM_TABLE_KEY) : null;
    if (raw) {
      tableMem = JSON.parse(raw);
      tableState = "ready";
      return tableMem;
    }
  } catch (e) {
    lastError = `读取缓存的字形表失败: ${e && e.message ? e.message : e}`;
  }
  try {
    const txt = gm.getResourceText ? gm.getResourceText("ttf") : null;
    if (txt) {
      tableMem = JSON.parse(txt);
      tableState = "ready";
      try {
        if (gm.setValue) gm.setValue(GM_TABLE_KEY, txt);
      } catch (e) {
        /* 缓存写失败不影响使用 */
      }
      return tableMem;
    }
  } catch (e) {
    lastError = `读取 @resource ttf 失败: ${e && e.message ? e.message : e}`;
  }
  return null;
}

/**
 * 预取字形表(异步, 供 bootstrap 后台调用)。
 * @returns {Promise<boolean>} 是否已就绪
 */
export async function prefetchTable() {
  if (tableMem) return true;
  if (getTableSync()) return true;
  tableState = "loading";
  try {
    const txt = await fetchTableText();
    tableMem = typeof txt === "string" ? JSON.parse(txt) : txt;
    tableState = "ready";
    try {
      if (gm.setValue) gm.setValue(GM_TABLE_KEY, typeof txt === "string" ? txt : JSON.stringify(txt));
    } catch (e) {
      /* ignore */
    }
    return true;
  } catch (e) {
    tableState = "failed";
    lastError = `拉取字形表失败: ${e && e.message ? e.message : e}`;
    return false;
  }
}

async function fetchTableText() {
  if (gm.xmlhttpRequest) {
    return JSON.stringify(await gmFetchJson(TABLE_URL, { timeout: 30000 }));
  }
  if (typeof fetch === "function") {
    const res = await fetch(TABLE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
  throw new Error("当前环境无网络请求能力(GM_xmlhttpRequest / fetch 均不可用)");
}

/** 收集页面里所有 font-cxsecret 字体的 base64(可能多个 style / 多个 @font-face) */
function collectFontBase64(doc) {
  const out = [];
  const grab = (txt) => {
    const re = /base64,([\w\W]+?)['")]/g;
    let m;
    while ((m = re.exec(txt))) out.push(m[1]);
  };
  // 1) 页内 <style>
  doc.querySelectorAll("style").forEach((style) => {
    const txt = style.textContent || "";
    if (!txt.includes(CX_STUDY_SEL.font.secretClass)) return;
    grab(txt);
  });
  // 2) 样式表里的 @font-face: base64 在 cssRules 里, <style> 里看不到。
  //    2026-11-10 真机(章节测验): 字体定义在 work/index.html 的样式表, 题目在 api/work。
  const all = [];
  try {
    Array.from(doc.styleSheets || []).forEach((ss) => {
      let rules = null;
      try {
        rules = ss.cssRules; // 跨域表读不到, 跳过
      } catch (e) {
        return;
      }
      if (!rules) return;
      for (const r of rules) {
        const t = String(r.cssText || "");
        if (!t.includes("base64,")) continue;
        all.push(t);
        if (t.includes(CX_STUDY_SEL.font.secretClass)) grab(t);
      }
    });
  } catch (e) {}
  // 3) 类名对不上时(字体族名不一定叫 font-cxsecret)退回全部 base64 字体:
  //    多解析几个字体没有副作用, 对不上的字体映射不到码点, 会自然淘汰
  if (!out.length) all.forEach(grab);
  return out;
}

function base64ToArrayBuffer(base64) {
  const bin = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function fontFingerprint(base64) {
  return `${base64.length}:${base64.slice(0, 48)}:${base64.slice(-24)}`;
}

function parseFont(base64) {
  const fp = fontFingerprint(base64);
  const cached = parsedFonts.get(fp);
  if (cached) return { font: cached, fp };
  const font = new TyprFont(base64ToArrayBuffer(base64));
  parsedFonts.set(fp, font);
  return { font, fp };
}

/** 精简 Font 包装: 只保留解密所需的三件(parse / codeToGlyph / glyphToPath) */
function TyprFont(data) {
  const obj = Typr.parse(data);
  if (!obj || !obj.length || typeof obj[0] !== "object") throw new Error("unable to parse font");
  for (const n in obj[0]) this[n] = obj[0][n];
}
TyprFont.prototype.codeToGlyph = function (code) {
  return Typr.U.codeToGlyph(this, code);
};
TyprFont.prototype.glyphToPath = function (gid) {
  return Typr.U.glyphToPath(this, gid);
};

/** 收集待解密元素里实际出现的码点(只查这些, 免去遍历全部汉字) */
function collectCodes(elements) {
  const set = new Set();
  elements.forEach((el) => {
    const s = el.textContent || "";
    for (let i = 0; i < s.length; i++) {
      const cp = s.charCodeAt(i);
      if (cp > 0x7f) set.add(cp);
    }
  });
  return set;
}

/** 逐码点算字形哈希查表(按字体指纹缓存, 同一字体不重复解析) */
function buildCodeMap(font, fp, table, codes) {
  let cache = codeMapCaches.get(fp);
  if (!cache) {
    cache = new Map();
    codeMapCaches.set(fp, cache);
  }
  const out = new Map();
  codes.forEach((cp) => {
    if (cache.has(cp)) {
      const hit = cache.get(cp);
      if (hit) out.set(cp, hit);
      return;
    }
    let real = 0;
    try {
      const gid = font.codeToGlyph(cp);
      if (gid) {
        const path = font.glyphToPath(gid);
        real = table[md5(JSON.stringify(path)).slice(24)] || 0;
      }
    } catch (e) {
      real = 0;
    }
    cache.set(cp, real);
    if (real) out.set(cp, real);
  });
  return out;
}

function escapeForCharClass(ch) {
  return ch.replace(/[\\\]^\-]/g, "\\$&");
}

/**
 * 解密 doc 内所有 .font-cxsecret 元素(就地替换文本并移除该类名)。
 * @param {Document} [doc=document] 目标文档(答题页为平级页面, 默认当前 document; iframe 场景传入 iframe.contentDocument)
 * @param {{table?: Object}} [opts] 可选覆盖(自测用: 直接注入字形表)
 * @returns {number} 实际解密的元素数(0 = 无可解密内容/未就绪)
 */
export function decryptFonts(doc, opts = {}) {
  lastError = "";
  lastStats = { fonts: 0, codes: 0, mapped: 0, elements: 0 };
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.querySelectorAll !== "function") {
    lastError = "无可用 document";
    return 0;
  }
  const targets = d.querySelectorAll(SECRET_SEL);
  if (!targets.length) return 0;

  const table = opts.table || getTableSync();
  if (!table) {
    lastError = "字形表未就绪(@resource ttf 缺失且预取未完成)";
    return 0;
  }
  const sources = collectFontBase64(d);
  // 字体定义可能挂在外层文档(章节测验: cards 页注入 @font-face, 题目在 api/work) —— 由调用方补
  if (Array.isArray(opts.docs)) {
    for (const extra of opts.docs) {
      if (!extra || extra === d) continue;
      try {
        collectFontBase64(extra).forEach((b) => {
          if (!sources.includes(b)) sources.push(b);
        });
      } catch (e) {}
    }
  }
  if (!sources.length) {
    lastError = `未找到含 ${CX_STUDY_SEL.font.secretClass} 的 base64 字体(字体定义缺失)`;
    return 0;
  }

  const codes = collectCodes(targets);
  if (!codes.size) return 0;

  // 合并多个字体的映射(同一页通常只有一个字体; 多字体时按出现顺序互补)
  const map = new Map();
  let parsed = 0;
  for (const b64 of sources) {
    let pair;
    try {
      pair = parseFont(b64);
    } catch (e) {
      lastError = `字体解析失败: ${e && e.message ? e.message : e}`;
      continue;
    }
    parsed += 1;
    const remain = new Set();
    codes.forEach((cp) => {
      if (!map.has(cp)) remain.add(cp);
    });
    if (!remain.size) break;
    buildCodeMap(pair.font, pair.fp, table, remain).forEach((v, k) => map.set(k, v));
  }

  lastStats = { fonts: parsed, codes: codes.size, mapped: map.size, elements: targets.length };
  if (!map.size) {
    lastError = `字形表未命中任何码点(待查 ${codes.size} 个; 检查 Typr 版本 / 表来源)`;
    return 0;
  }

  const chars = [];
  map.forEach((_real, cp) => chars.push(String.fromCharCode(cp)));
  const re = new RegExp(`[${chars.map(escapeForCharClass).join("")}]`, "g");

  let done = 0;
  targets.forEach((el) => {
    const html = el.innerHTML;
    const next = html.replace(re, (ch) => String.fromCharCode(map.get(ch.charCodeAt(0))));
    if (next !== html) el.innerHTML = next;
    el.classList.remove(CX_STUDY_SEL.font.secretClass);
    done += 1;
  });
  return done;
}

/** 清空内部缓存(调试/自测用) */
export function __resetFontDecryptCache() {
  tableMem = null;
  tableState = "idle";
  lastError = "";
  lastStats = { fonts: 0, codes: 0, mapped: 0, elements: 0 };
  parsedFonts.clear();
  codeMapCaches.clear();
}

/** 供自测注入字形表 */
export function __setTableForTest(table) {
  tableMem = table;
  tableState = "ready";
}
