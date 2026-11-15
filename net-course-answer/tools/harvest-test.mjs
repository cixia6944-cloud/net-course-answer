#!/usr/bin/env node
// 抓取模块单元自测(纯 node, 假 DOM) —— node tools/harvest-test.mjs
// 覆盖: iframe 递归遍历(含跨域跳过) / 题目读取(题干扣掉题型徽标、选项字母、两栏答案、对错标记) /
//       markdown 生成 / 文件名清洗 / 落文件与剪贴板兜底 / 面板按钮挂载(幂等、防连点、插在 tabs 之前)。
import {
  hvWalkFrames,
  hvReadQuestions,
  hvName,
  hvStamp,
  hvToMd,
  hvSave,
  hvCopy,
  hvGrabCourseware,
  hvGrabQuestions,
  mountHarvestBar,
} from "../src/ui/harvest.js";

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

/* ---------------- mini DOM ---------------- */

class HEl {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = opts.className || "";
    this.id = opts.id || "";
    this._text = opts.text || "";
    this._attrs = opts.attrs || {};
    this.parentElement = null;
    this.style = { cssText: "" };
    this.disabled = false;
    this._listeners = {};
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
  }
  get innerHTML() {
    return this._html || "";
  }
  appendChild(c) {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    c.parentElement = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  }
  getAttribute(n) {
    return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null;
  }
  setAttribute(n, v) {
    this._attrs[n] = v;
  }
  addEventListener(t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  }
  click() {
    (this._listeners.click || []).forEach((fn) => fn({ target: this }));
  }
  querySelectorAll(sel) {
    return queryAll(this, sel);
  }
  querySelector(sel) {
    return queryAll(this, sel)[0] || null;
  }
  closest() {
    return this;
  }
  matches(sel) {
    return matchCompound(this, sel);
  }
}

/** 复合选择器: 支持 tag / .cls / #id / [attr] / [attr=val] / [attr*=val] / tag.cls 的组合 */
function matchCompound(el, sel) {
  if (!el || !el.tagName) return false;
  const s = sel.trim();
  if (!s) return false;
  // 逐段解析
  const re = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/;
  const m = re.exec(s);
  if (!m) return false;
  const [, tag, rest] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const parts = rest.match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
  for (const p of parts) {
    if (p[0] === ".") {
      const cls = p.slice(1);
      if (!String(el.className || "").split(/\s+/).includes(cls)) return false;
    } else if (p[0] === "#") {
      if (el.id !== p.slice(1)) return false;
    } else if (p[0] === "[") {
      const inner = p.slice(1, -1);
      let name = inner;
      let op = null;
      let val = null;
      let mm;
      if ((mm = /^([\w-]+)\s*\*=\s*['"]?([^'"]*)['"]?$/.exec(inner))) {
        name = mm[1];
        op = "*=";
        val = mm[2];
      } else if ((mm = /^([\w-]+)\s*=\s*['"]?([^'"]*)['"]?$/.exec(inner))) {
        name = mm[1];
        op = "=";
        val = mm[2];
      }
      const got = el.getAttribute(name);
      if (got == null) return false;
      if (op === "=" && String(got) !== val) return false;
      if (op === "*=" && !String(got).includes(val)) return false;
    }
  }
  return true;
}

/** 后代选择器(空格分隔, 支持 A B / A,B) */
function matchChain(el, sel) {
  const alternatives = sel.split(",").map((s) => s.trim()).filter(Boolean);
  return alternatives.some((alt) => {
    const parts = alt.split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    let node = el;
    if (!matchCompound(node, parts[parts.length - 1])) return false;
    let pi = parts.length - 2;
    while (pi >= 0) {
      let up = node.parentElement;
      let found = false;
      while (up) {
        if (matchCompound(up, parts[pi])) {
          found = true;
          node = up;
          break;
        }
        up = up.parentElement;
      }
      if (!found) return false;
      pi--;
    }
    return true;
  });
}

function queryAll(root, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (matchChain(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

const el = (tag, opts) => new HEl(tag, opts);

function makeDoc(nodes) {
  const body = el("body");
  const html = el("html");
  html.appendChild(body);
  const doc = {
    title: "第1章 小测",
    body,
    documentElement: html,
    head: el("head"),
    createElement: (t) => el(t),
    querySelectorAll: (s) => queryAll(html, s),
    querySelector: (s) => queryAll(html, s)[0] || null,
    _nodes: nodes,
  };
  (nodes || []).forEach((n) => body.appendChild(n));
  return doc;
}

/** 造一道已批阅的题(结构照 .TiMu 实测形态) */
function makeReviewedQuestion({ typeText = "单选题", stem = "下列哪个是正确的?", options = [["A", "选项一"], ["B", "选项二"]], my = "A", right = "B", score = "2", mark = "cuo", qid = "q1" } = {}) {
  const box = el("div", { className: "TiMu", attrs: { data: qid } });
  const title = el("div", { className: "Zy_TItle" });
  title.appendChild(el("span", { text: "第1题" }));
  const content = el("div", { className: "qtContent" });
  content.appendChild(el("span", { className: "newZy_TItle", text: typeText }));
  content.appendChild(el("span", { text: stem }));
  const ul = el("ul", { className: "Zy_ulTop" });
  options.forEach(([letter, text]) => {
    const li = el("li");
    li.appendChild(el("i", { text: letter }));
    li.appendChild(el("a", { text }));
    ul.appendChild(li);
  });
  const myBx = el("div", { className: "myAnswerBx" });
  const myA = el("div", { className: "myAnswer" });
  myA.appendChild(el("span", { className: "answerCon", text: my }));
  myBx.appendChild(myA);
  const rightBx = el("div", { className: "correctAnswerBx" });
  const rightA = el("div", { className: "correctAnswer" });
  rightA.appendChild(el("span", { className: "answerCon", text: right }));
  rightBx.appendChild(rightA);
  const markEl = el("span", { className: mark === "dui" ? "marking_dui" : "marking_cuo", text: mark === "dui" ? "√" : "×" });
  [title, content, ul, myBx, rightBx, markEl, el("span", { className: "scoreNum", text: score })].forEach((n) => box.appendChild(n));
  return box;
}

/* ---------------- 桩: 浏览器全局 ---------------- */

const sentFiles = [];
globalThis.Blob = class {
  constructor(parts, opts) {
    this.parts = parts;
    this.type = (opts && opts.type) || "";
  }
};
const RealURL = globalThis.URL;
globalThis.URL = Object.assign(function (...a) { return new RealURL(...a); }, {
  createObjectURL: (b) => `blob:fake/${sentFiles.length}`,
  revokeObjectURL: () => {},
});
// node 自带只读的 navigator, 用 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
globalThis.setTimeout = setTimeout;

function installDom(doc) {
  globalThis.document = doc;
  globalThis.window = { document: doc, frames: [], location: { href: "http://x/y" } };
  doc.createElement = (t) => {
    const node = el(t);
    if (t === "a") {
      node.click = function () {
        sentFiles.push({ name: this.download, href: this.href });
      };
    }
    return node;
  };
  return doc;
}

/* ---------------- 用例 ---------------- */

async function main() {
  console.log("== 1) hvName / hvStamp");
  {
    ok(hvName("第1章 小测") === "第1章 小测", "普通标题原样保留");
    ok(!/[\\/:*?"<>|]/.test(hvName('a/b\\c:d*e?f"g<h>i|j')), "非法字符被去掉");
    ok(hvName("   ") === "题目", "空标题兜底为「题目」");
    ok(hvName("x".repeat(200)).length === 60, "超长截到 60 字");
    ok(/^\d{8}-\d{6}$/.test(hvStamp(new Date(2026, 9, 22, 13, 5, 9))), `时间戳格式正确(${hvStamp(new Date(2026, 9, 22, 13, 5, 9))})`);
  }

  console.log("== 2) hvReadQuestions: 题干要扣掉题型徽标");
  {
    const q = makeReviewedQuestion({ typeText: "多选题", stem: "选出所有正确项" });
    const doc = installDom(makeDoc([q]));
    const qs = hvReadQuestions(globalThis.window);
    ok(qs.length === 1, "读到 1 题");
    ok(qs[0].typeText === "多选题", `题型 = 多选题(${qs[0].typeText})`);
    ok(!qs[0].stem.includes("多选题"), `题干里没有混进题型徽标(${JSON.stringify(qs[0].stem)})`);
    ok(qs[0].stem === "选出所有正确项", `题干正确(${JSON.stringify(qs[0].stem)})`);
    ok(qs[0].type === "multiple", `题型键 = multiple(${qs[0].type})`);
    ok(qs[0].options.length === 2, "读到 2 个选项");
    ok(qs[0].options[0].letter === "A" && qs[0].options[0].text === "选项一", `选项 A 正确(${JSON.stringify(qs[0].options[0])})`);
    ok(qs[0].myAnswer === "A", `我的答案 = A(${qs[0].myAnswer})`);
    ok(qs[0].rightAnswer === "B", `正确答案 = B(${qs[0].rightAnswer})`);
    ok(qs[0].score === "2", `分值 = 2(${qs[0].score})`);
    ok(qs[0].marked === "错", `对错标记 = 错(${qs[0].marked})`);
    ok(qs[0].qid === "q1", `qid 从 data 属性读到(${qs[0].qid})`);
  }

  console.log("== 3) hvReadQuestions: 对的标记 / 加密标记");
  {
    const q = makeReviewedQuestion({ mark: "dui" });
    const doc = installDom(makeDoc([q]));
    const qs = hvReadQuestions(globalThis.window);
    ok(qs[0].marked === "对", `对错标记 = 对(${qs[0].marked})`);

    const enc = makeReviewedQuestion();
    const content = enc.querySelector(".qtContent");
    content.appendChild(el("span", { className: "font-cxsecret", text: "乱码" }));
    const doc2 = installDom(makeDoc([enc]));
    const qs2 = hvReadQuestions(globalThis.window);
    ok(qs2[0].encrypted === true, "题面含 font-cxsecret 时标记 encrypted");
  }

  console.log("== 4) hvWalkFrames: 递归 + 跨域跳过");
  {
    const childDoc = makeDoc([makeReviewedQuestion()]);
    const childWin = { document: childDoc, frames: [], location: { href: "http://x/child" } };
    const topDoc = makeDoc([]);
    const topWin = { document: topDoc, frames: [childWin], location: { href: "http://x/top" } };
    const layers = hvWalkFrames(topWin);
    ok(layers.length === 2, `遍历到 2 层(${layers.length})`);
    ok(layers[0].path === "top", "顶层 path=top");
    ok(layers[1].path === "top/0", `子层 path=top/0(${layers[1].path})`);
    ok(layers[1].tiMu === 1, `子层读到 1 道题(${layers[1].tiMu})`);

    // 跨域: 访问 document 抛异常
    const hostile = {
      get document() {
        throw new Error("cross-origin");
      },
      frames: [],
      location: { href: "http://other/" },
    };
    const w2 = { document: topDoc, frames: [hostile], location: { href: "http://x/top" } };
    let threw = null;
    let layers2 = [];
    try {
      layers2 = hvWalkFrames(w2);
    } catch (e) {
      threw = e;
    }
    ok(!threw, "跨域层不抛异常");
    ok(layers2.length === 2, `跨域层仍被记录(只是没内容)(${layers2.length})`);
    ok(layers2[1].tiMu === 0, "跨域层题数为 0");
  }

  console.log("== 5) hvWalkFrames: 深度上限");
  {
    let leaf = { document: makeDoc([]), frames: [], location: { href: "http://x/leaf" } };
    let cur = leaf;
    for (let i = 0; i < 12; i++) cur = { document: makeDoc([]), frames: [cur], location: { href: "http://x/d" + i } };
    const layers = hvWalkFrames(cur);
    ok(layers.length <= 9, `深度被限制(实际 ${layers.length} 层 ≤ maxFrameDepth+2)`);
    ok(layers.length < 13, "没有无限递归");
  }

  console.log("== 6) hvToMd 结构");
  {
    const q = makeReviewedQuestion();
    const doc = installDom(makeDoc([q]));
    const qs = hvReadQuestions(globalThis.window);
    const md = hvToMd(qs, { title: "第1章 小测", layer: "top/0", layerUrl: "http://x/c", time: "2026-10-22 13:05" });
    ok(md.startsWith("# 题目 · 第1章 小测"), "有一级标题");
    ok(md.includes("## 来源"), "有来源小节");
    ok(md.includes("| 题目层 | top/0 |"), "来源表含题目层");
    ok(md.includes("不做判断、不改写"), "带免责那句");
    ok(md.includes("## 第1题【单选题】"), "每题有二级标题");
    ok(md.includes("- 我的答案：A"), "有我的答案");
    ok(md.includes("- 正确答案：B"), "有正确答案");
    ok(md.includes("- 分值：2"), "有分值");
    ok(md.includes("- 对错标记：错"), "有对错标记");
    ok(md.includes("- A、选项一"), "选项按字母列出");
  }

  console.log("== 7) hvSave: 交给浏览器");
  {
    sentFiles.length = 0;
    installDom(makeDoc([]));
    const okSave = hvSave("x.md", "# hi", "text/markdown");
    ok(okSave === true, "hvSave 返回 true");
    ok(sentFiles.length === 1, "触发了一次下载");
    ok(sentFiles[0].name === "x.md", `文件名正确(${sentFiles[0].name})`);
  }

  console.log("== 8) hvGrabCourseware: 找到 fileinfo.download");
  {
    sentFiles.length = 0;
    const logs = [];
    const courseDoc = makeDoc([]);
    const courseWin = { document: courseDoc, frames: [], location: { href: "http://x/pdf" }, fileinfo: { download: "http://x/ppt/abc.pptx" } };
    const topDoc = makeDoc([]);
    const topWin = { document: topDoc, frames: [courseWin], location: { href: "http://x/top" } };
    const r = await hvGrabCourseware(topWin, (m) => logs.push(m));
    ok(r.ok === true, "抓到课件");
    ok(r.url === "http://x/ppt/abc.pptx", `下载地址正确(${r.url})`);
    ok(r.name === "abc.pptx", `文件名正确(${r.name})`);
    ok(logs.some((m) => m.includes("abc.pptx")), "日志里报了文件名");
    ok(logs.some((m) => m.includes("看不到实际落盘")), "日志明确说看不到落盘");
    const ifr = document.body.children.find((c) => c.tagName === "IFRAME");
    ok(!!ifr && ifr.src === "http://x/ppt/abc.pptx", "用隐藏 iframe 交给浏览器(不在脚本里 fetch)");
  }

  console.log("== 9) hvGrabCourseware: 没课件时明确说");
  {
    const logs = [];
    installDom(makeDoc([]));
    const w = { document: globalThis.document, frames: [], location: { href: "http://x/top" } };
    const r = await hvGrabCourseware(w, (m) => logs.push(m));
    ok(r.ok === false && r.reason === "no-courseware", "返回 no-courseware");
    ok(logs.some((m) => m.includes("没找到课件")), "日志说明原因");
  }

  console.log("== 10) hvGrabQuestions: 落 md + json");
  {
    sentFiles.length = 0;
    const logs = [];
    const q = makeReviewedQuestion();
    const doc = makeDoc([q]);
    doc.title = "第1章 小测";
    installDom(doc);
    const w = { document: doc, frames: [], location: { href: "http://x/work" } };
    const r = await hvGrabQuestions(w, (m) => logs.push(m));
    ok(r.ok === true, "抓到题目");
    ok(r.count === 1, `题数 1(${r.count})`);
    ok(sentFiles.length === 2, `发了 2 个文件(${sentFiles.length})`);
    ok(sentFiles[0].name.endsWith(".md"), `第一份是 md(${sentFiles[0].name})`);
    ok(sentFiles[1].name.endsWith(".json"), `第二份是 json(${sentFiles[1].name})`);
    ok(sentFiles[0].name.replace(/\.md$/, "") === sentFiles[1].name.replace(/\.json$/, ""), "两份同名(只差扩展名)");
    ok(sentFiles[0].name.startsWith("第1章 小测-"), `文件名以页面标题开头(${sentFiles[0].name})`);
    ok(logs.some((m) => m.includes("交给浏览器保存到下载文件夹")), "日志说交给浏览器");
    ok(!logs.some((m) => m.includes("已保存")), "不写「已保存」(脚本看不到落盘)");
    ok(logs.some((m) => m.includes("第1题")), "逐题打了一行日志");
    ok(logs.some((m) => m.includes("我的答案")), "逐题日志含我的答案");
  }

  console.log("== 11) hvGrabQuestions: 从子层取题目最多的那层");
  {
    sentFiles.length = 0;
    const emptyTop = makeDoc([]);
    const richDoc = makeDoc([makeReviewedQuestion({ qid: "a" }), makeReviewedQuestion({ qid: "b" })]);
    installDom(emptyTop);
    const childWin = { document: richDoc, frames: [], location: { href: "http://x/work" } };
    const topWin = { document: emptyTop, frames: [childWin], location: { href: "http://x/top" } };
    const r = await hvGrabQuestions(topWin, () => {});
    ok(r.ok === true && r.count === 2, `从子层读到 2 题(${r.count})`);
  }

  console.log("== 12) hvGrabQuestions: 没题目时明确说");
  {
    const logs = [];
    installDom(makeDoc([]));
    const w = { document: globalThis.document, frames: [], location: { href: "http://x/top" } };
    const r = await hvGrabQuestions(w, (m) => logs.push(m));
    ok(r.ok === false && r.reason === "no-questions", "返回 no-questions");
    ok(logs.some((m) => m.includes("没读到题目")), "日志说明原因");
  }

  console.log("== 13) mountHarvestBar: 幂等 + 插在 tabs 之前");
  {
    const doc = installDom(makeDoc([]));
    const body = el("div", { className: "nca-body" });
    const tabs = el("div", { className: "nca-tabs" });
    body.appendChild(tabs);
    const root = el("div", { className: "nca-panel" });
    root.appendChild(body);
    const logs = [];
    const panel = { root, log: (m, t) => logs.push([m, t]) };
    const w = { document: doc, frames: [], location: { href: "http://x/top" } };

    const first = mountHarvestBar(panel, { win: w, log: panel.log });
    ok(first === true, "首次挂载成功");
    ok(!!root.querySelector(".nca-hv-bar"), "面板里有按钮栏");
    ok(!!root.querySelector(".nca-hv-cw"), "有「抓本页课件」按钮");
    ok(!!root.querySelector(".nca-hv-q"), "有「抓本页题目」按钮");

    const bodyKids = body.children.map((c) => c.className);
    const barIdx = bodyKids.indexOf("nca-hv-bar");
    const tabIdx = bodyKids.indexOf("nca-tabs");
    ok(barIdx >= 0 && tabIdx >= 0 && barIdx < tabIdx, `按钮栏在 .nca-tabs 之前(${bodyKids.join(",")})`);

    const second = mountHarvestBar(panel, { win: w, log: panel.log });
    ok(second === true, "二次挂载返回 true");
    ok(root.querySelectorAll(".nca-hv-bar").length === 1, "幂等: 只有一个按钮栏");
  }

  console.log("== 14) 按钮点击: 真的触发抓取 + 防连点");
  {
    sentFiles.length = 0;
    const q = makeReviewedQuestion();
    const doc = makeDoc([q]);
    installDom(doc);
    const body = el("div", { className: "nca-body" });
    const tabs = el("div", { className: "nca-tabs" });
    body.appendChild(tabs);
    const root = el("div", { className: "nca-panel" });
    root.appendChild(body);
    const logs = [];
    const panel = { root, log: (m, t) => logs.push([m, t]) };
    const w = { document: doc, frames: [], location: { href: "http://x/work" } };
    mountHarvestBar(panel, { win: w, log: panel.log });

    const btnQ = root.querySelector(".nca-hv-q");
    btnQ.click();
    // 两份文件之间有 200ms 间隔(防浏览器拦第二个), 等够
    await new Promise((r) => setTimeout(r, 400));
    ok(sentFiles.length === 2, `点一次发出 2 份文件(${sentFiles.length})`);
    // 立刻再点: 应被冷却挡住
    btnQ.click();
    await new Promise((r) => setTimeout(r, 400));
    ok(sentFiles.length === 2, `冷却期内再点不重复发(${sentFiles.length})`);
  }

  console.log("== 15) 抓取模块不碰提交/点击类动作(红线)");
  {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/ui/harvest.js", import.meta.url), "utf8"));
    ok(!/\.click\(\)/.test(src.replace(/a\.click\(\)/g, "")), "源码里没有点页面元素的 click(除下载用的 a.click)");
    ok(!/btnBlueSubmit|submitCheckTimes|noSubmit/.test(src), "不碰提交类页面函数");
    ok(!/getTeacherAjax|changeDisplayContent|toOld\(/.test(src), "不点任务点/不切章节");
    ok(!/\bfetch\s*\(/.test(src), "不发网络请求(课件交给浏览器)");
    ok(!/XMLHttpRequest/.test(src), "不用 XHR");
  }

  
/** 造一道「作业详情页」(mooc-ans/mooc2/work/view) 的已批阅题 —— 结构照真机 HTML 一字一字搭 */
function makeWorkViewQuestion({ no = 1, qid = "402285040", typeText = "单选题", stem = "价格水平上升导致（）。", options = [["A", "实际货币供给下降，LM曲线左移"], ["B", "实际货币供给下降，LM曲线右移"]], my = "B", right = "A", score = "0", mark = "cuo" } = {}) {
  const item = el("div", { className: "mark_item" });
  const li = el("div", { className: "marBom60 questionLi singleQuesId", id: "question" + qid, attrs: { data: qid, "aria-label": "题目详情" } });
  const aiArea = el("div", { className: "aiArea" });
  const aiContent = el("div", { className: "aiAreaContent" });
  const h3 = el("h3", { className: "mark_name colorDeep" });
  h3.appendChild(el("span", { text: no + ". " }));
  h3.appendChild(el("span", { className: "colorShallow", text: "(" + typeText + ")" }));
  const qt = el("span", { className: "qtContent workTextWrap" });
  qt.appendChild(el("p", { text: stem }));
  h3.appendChild(qt);
  const ul = el("ul", { className: "mark_letter colorDeep qtDetail" });
  options.forEach(([letter, text]) => {
    const o = el("li", { className: "workTextWrap" });
    o.appendChild(el("p", { text: letter + ". " + text }));
    ul.appendChild(o);
  });
  const ans = el("div", { className: "mark_answer" });
  const key = el("div", { className: "mark_key clearfix" });
  const mySpan = el("span", { className: "colorDeep marginRight40 fl" });
  mySpan.appendChild(el("i", { className: "fontWeight custom-style", text: "我的答案:" }));
  mySpan.appendChild(el("span", { className: "stuAnswerContent", text: my }));
  const rightSpan = el("span", { className: "colorGreen marginRight40 fl" });
  rightSpan.appendChild(el("i", { className: "fontWeight custom-style", text: "正确答案:" }));
  rightSpan.appendChild(el("span", { className: "rightAnswerContent workTextWrap", text: right }));
  key.appendChild(mySpan);
  key.appendChild(rightSpan);
  const scoreWrap = el("div", { className: "mark_score" });
  const judge = el("div", { className: "mark_judge_name" });
  judge.appendChild(el("span", { className: mark === "dui" ? "marking_dui" : "marking_cuo" }));
  const total = el("div", { className: "totalScore fr" });
  total.appendChild(el("i", { text: score }));
  total.appendChild(el("span", { text: "分" }));
  scoreWrap.appendChild(judge);
  scoreWrap.appendChild(total);
  ans.appendChild(key);
  ans.appendChild(scoreWrap);
  [h3, ul, ans].forEach((n) => aiContent.appendChild(n));
  aiArea.appendChild(aiContent);
  li.appendChild(aiArea);
  item.appendChild(li);
  return item;
}

  console.log("== 16) 作业详情页: .TiMu 是整页壳, 必须按 .questionLi 逐题读");
  {
    // 真机形态: <div class="TiMu" id="fanyaMarking"> 套住全部 .mark_item > .questionLi
    const shell = el("div", { className: "TiMu", id: "fanyaMarking" });
    const qs = [
      makeWorkViewQuestion({ no: 1, qid: "1", stem: "第一题题干", my: "B", right: "A", score: "0", mark: "cuo" }),
      makeWorkViewQuestion({ no: 2, qid: "2", stem: "第二题题干", my: "C", right: "C", score: "2", mark: "dui" }),
      makeWorkViewQuestion({ no: 3, qid: "3", stem: "第三题题干", my: "D", right: "A", score: "2", mark: "cuo" }),
    ];
    qs.forEach((q) => shell.appendChild(q));
    const doc = makeDoc([shell]);
    doc.title = "作业详情";
    installDom(doc);
    const w = { document: doc, frames: [], location: { href: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view?workId=1" } };
    const got = hvReadQuestions(w);
    ok(got.length === 3, `读到 3 题而不是 1 题(实际 ${got.length})`);
    const q0 = got[0] || {};
    const q1 = got[1] || {};
    const q2 = got[2] || {};
    ok(q0.stem === "第一题题干", `第1题题干正确(${JSON.stringify(q0.stem)})`);
    ok(q1.stem === "第二题题干", `第2题题干正确(${JSON.stringify(q1.stem)})`);
    ok(q2.stem === "第三题题干", `第3题题干正确(${JSON.stringify(q2.stem)})`);
    ok(q0.typeText === "单选题", `题型去掉括号(${q0.typeText})`);
    ok(q0.myAnswer === "B", `第1题我的答案 = B(${q0.myAnswer})`);
    ok(q0.rightAnswer === "A", `第1题正确答案 = A(${q0.rightAnswer})`);
    ok(q0.score === "0", `分值去掉「分」字(${q0.score})`);
    ok(q1.score === "2", `第2题分值 = 2(${q1.score})`);
    ok(q0.marked === "错", `第1题对错 = 错(${q0.marked})`);
    ok(q1.marked === "对", `第2题对错 = 对(${q1.marked})`);
    ok(Array.isArray(q0.options) && q0.options.length === 2, `第1题读到 2 个选项(${(q0.options||[]).length})`);
    ok(q0.options[0].letter === "A" && q0.options[0].text === "实际货币供给下降，LM曲线左移", `选项 A 字母与文本都正确(${JSON.stringify(q0.options[0])})`);
    ok(q0.qid === "1", `qid 从 data 属性读到(${q0.qid})`);
    // 关键回归: 第1题不能串到第2题的答案
    ok(q0.myAnswer !== q1.myAnswer, "第1题与第2题的答案没有互相串(逐题作用域生效)");
  }

  console.log("== 17) 作业详情页: 抓取动作产出 3 题 + 无漂移警告");
  {
    sentFiles.length = 0;
    const shell = el("div", { className: "TiMu", id: "fanyaMarking" });
    [1, 2, 3].forEach((n) => shell.appendChild(makeWorkViewQuestion({ no: n, qid: String(n), stem: "题" + n })));
    const doc = makeDoc([shell]);
    doc.title = "作业详情";
    installDom(doc);
    const logs = [];
    const w = { document: doc, frames: [], location: { href: "https://mooc1.chaoxing.com/mooc-ans/mooc2/work/view?workId=1" } };
    const r = await hvGrabQuestions(w, (m, t) => logs.push([m, t]));
    ok(r.ok === true && r.count === 3, `抓到 3 题(${r.count})`);
    ok(Array.isArray(r.warnings) && r.warnings.length === 0, `结构完整时没有漂移警告(${JSON.stringify(r.warnings)})`);
    ok(!logs.some(([m]) => m.includes("结构可能变了") || m.includes("读空")), "日志里没有警告");
  }

  console.log("== 18) 结构漂移: 字段读空必须自曝, 不能静默半成功");
  {
    sentFiles.length = 0;
    // 只有题干, 题型/选项/答案/分值全缺 —— 模拟页面改版
    const bare = el("div", { className: "questionLi", id: "q1", attrs: { data: "1" } });
    const qt = el("span", { className: "qtContent", text: "只有题干的题" });
    bare.appendChild(qt);
    const doc = makeDoc([bare]);
    doc.title = "作业详情";
    installDom(doc);
    const logs = [];
    const w = { document: doc, frames: [], location: { href: "https://x/view" } };
    const r = await hvGrabQuestions(w, (m) => logs.push(m));
    ok(r.ok === true, "仍然产出文件(总比什么都不给强)");
    ok(r.warnings.some((x) => x.includes("题型")), `警告里有「题型全空」(${JSON.stringify(r.warnings)})`);
    ok(r.warnings.some((x) => x.includes("我的答案")), "警告里有「我的答案全空」");
    ok(r.warnings.some((x) => x.includes("正确答案")), "警告里有「正确答案全空」");
    ok(r.warnings.some((x) => x.includes("分值")), "警告里有「分值全空」");
    ok(r.warnings.some((x) => x.includes("选项")), "警告里有「选项全空」");
    ok(r.warnings.some((x) => x.includes("只读到 1 道题")), "警告里有「只读到 1 道题」");
    ok(logs.some((m) => m.includes("⚠")), "面板日志打出了警告行");
    // md 头部也要带警告
    const md = hvToMd([{ typeText: "", stem: "x", options: [], myAnswer: "", rightAnswer: "", score: "", marked: "", encrypted: false }], { title: "t", warnings: ["题型全空"] });
    ok(md.includes("结构可能变了"), "md 里也标了结构警告");
    ok(r.warnings.length > 0 && r.notes.length === 0, `整份全空走故障警报, 不走温和说明(warnings=${r.warnings.length}, notes=${r.notes.length})`);
  }

  console.log("== 19) 选项字母重复前缀要剥干净(真机是 A. + A．两层)");
  {
    const item = el("div", { className: "mark_item" });
    const li = el("div", { className: "questionLi", attrs: { data: "9" } });
    const h3 = el("h3", { className: "mark_name" });
    h3.appendChild(el("span", { className: "colorShallow", text: "(单选题)" }));
    const qt = el("span", { className: "qtContent", text: "题干" });
    h3.appendChild(qt);
    const ul = el("ul", { className: "mark_letter" });
    const o = el("li", { className: "workTextWrap" });
    o.appendChild(el("p", { text: "A. A．实际货币供给下降，LM曲线左移" }));
    ul.appendChild(o);
    const o2 = el("li", { className: "workTextWrap" });
    o2.appendChild(el("p", { text: "B. B．实际货币供给上升" }));
    ul.appendChild(o2);
    [h3, ul].forEach((n) => li.appendChild(n));
    item.appendChild(li);
    const doc = makeDoc([item]);
    doc.title = "作业详情";
    installDom(doc);
    const w = { document: doc, frames: [], location: { href: "https://x/view" } };
    const got = hvReadQuestions(w);
    ok(got[0].options[0].text === "实际货币供给下降，LM曲线左移", `A 选项剥掉了两层字母(${JSON.stringify(got[0].options[0].text)})`);
    ok(got[0].options[1].text === "实际货币供给上升", `B 选项同样剥干净(${JSON.stringify(got[0].options[1].text)})`);
    ok(got[0].options[0].letter === "A" && got[0].options[1].letter === "B", "字母本身仍正确");
  }

  console.log("== 20) 图片题: 要能分辨「图片」和「选择器失效」");
  {
    sentFiles.length = 0;
    const normal = makeWorkViewQuestion({ no: 1, qid: "1", stem: "正常题" });
    // 图片题: 题干里只有 img, 没有文字
    const imgItem = el("div", { className: "mark_item" });
    const li = el("div", { className: "questionLi", attrs: { data: "2" } });
    const h3 = el("h3", { className: "mark_name" });
    h3.appendChild(el("span", { className: "colorShallow", text: "(单选题)" }));
    const qt = el("span", { className: "qtContent" });
    qt.appendChild(el("img", { attrs: { src: "a.png" } }));
    h3.appendChild(qt);
    li.appendChild(h3);
    imgItem.appendChild(li);
    const doc = makeDoc([normal, imgItem]);
    doc.title = "作业详情";
    installDom(doc);
    const w = { document: doc, frames: [], location: { href: "https://x/view" } };
    const qs = hvReadQuestions(w);
    ok(qs.length === 2, "读到 2 题");
    ok(qs[1].stemImage === true, "图片题被标记 stemImage");
    ok(qs[1].stem === "", "图片题题干文字为空(页面本身如此)");
    ok(qs[1].gaps.some((g) => g.includes("图片")), `gaps 说明是图片(${JSON.stringify(qs[1].gaps)})`);
    ok(qs[0].gaps.length === 0, `正常题没有 gaps(${JSON.stringify(qs[0].gaps)})`);
    // 少数题缺 → 点名, 不能整份静默
    const r = await hvGrabQuestions(w, () => {});
    ok(r.warnings.length === 0, `少数题缺内容不算结构故障, 不报警告(${JSON.stringify(r.warnings)})`);
    ok(r.notes.some((x) => x.includes("第 2 题")), `说明里点名了第 2 题(${JSON.stringify(r.notes)})`);
    ok(r.notes.some((x) => x.includes("图片")), "说明里指出是图片题");
    ok(!r.notes.some((x) => x.includes("题干全空")), "没有误报成「选择器失效」");
    // md 里也要标, 且是「说明」不是「结构可能变了」
    const md = hvToMd(qs, { title: "t", warnings: r.warnings, notes: r.notes });
    ok(md.includes("⚠️ 题干是图片"), "md 里逐题标了图片题");
    ok(md.includes("说明（非故障"), "md 头部用的是温和说明而不是故障警报");
    ok(!md.includes("结构可能变了"), "少数题缺失不会误报成结构变了");
  }

console.log(`\n${fail ? "❌ 有失败" : "✅ 全部通过"}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
