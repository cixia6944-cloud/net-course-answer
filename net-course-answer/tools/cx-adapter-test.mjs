#!/usr/bin/env node
// 答题适配器单元自测(node tools/cx-adapter-test.mjs)
// cx.js 以前没有单测 —— 这次补上, 重点是三个改过的地方:
//   ① 填空/简答写入: UE 富文本 / 原生 value setter + input+change / 页面没有 UE 时的降级
//   ② 自动提交用的是"题目所在那一层"的 window(嵌套 iframe 里两层 window 不能混)
//   ③ 答题页选择器全部来自契约表 CX_STUDY_SEL.answer(含已批阅/新版结构的兜底)
//
// 注意: vendor/typr.js 顶层就引用 window.TextDecoder —— 和其它测试一样先垫一个 window,
// 再用动态 import 拉源码(cx.js → font-decrypt.js → typr.js)。
globalThis.window = globalThis;

const { CxAdapter } = await import("../src/adapters/cx.js");
const { CX_STUDY_SEL } = await import("../src/contract/cx-study-contract.js");
const { QTYPE } = await import("../src/core/types.js");

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

/* ---------- 极简假 DOM ---------- */
// 选择器支持(够用就好): 逗号分隔; 可带标签名; .class 链; [attr] / [attr=v] / [attr*=v]。
// 与 cx.js 用到的契约选择器一一对应; 故意不实现后代/伪类组合(堆到那里就该上真浏览器了)。
function attrTest(el, name, op, want) {
  let val = el.getAttribute ? el.getAttribute(name) : null;
  if (name === "class" && val == null) val = el.className || null;
  if (!op) return val != null; // [attr] = 有这个属性
  const s = String(val == null ? "" : val);
  if (op === "=") return s === want;
  if (op === "*=") return s.includes(want);
  return false;
}
function matches(el, sel) {
  const s = String(sel).trim();
  const tag = /^([a-z]+)/i.exec(s);
  let rest = s;
  if (tag) {
    if (String(el.tagName || "").toLowerCase() !== tag[1].toLowerCase()) return false;
    rest = s.slice(tag[1].length);
  }
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  if (!parts.length) return rest === "";
  for (const p of parts) {
    if (p.startsWith(".")) {
      if (!String(el.className || "").split(/\s+/).includes(p.slice(1))) return false;
    } else {
      const m = /^\[([\w-]+)(\*?=)?["']?([^"'\]]*)["']?\]$/.exec(p);
      if (!m || !attrTest(el, m[1], m[2], m[3])) return false;
    }
  }
  return true;
}
const queryAll = (root, sel) =>
  String(sel)
    .split(",")
    .flatMap((one) => {
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          try {
            if (matches(c, one)) out.push(c);
          } catch (e) {}
          walk(c);
        }
      };
      walk(root);
      return out;
    });

function el(tag, { cls = "", text = "", attrs = {}, children = [] } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    className: cls,
    children,
    innerHTML: text,
    _text: text,
    _attrs: attrs,
    events: [],
    clicks: 0,
    getAttribute: (n) => (n === "class" ? cls : n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => (attrs[n] = v),
    dispatchEvent(e) {
      node.events.push(e);
      return true;
    },
    click() {
      node.clicks++;
    },
  };
  node.querySelector = (s) => queryAll(node, s)[0] || null;
  node.querySelectorAll = (s) => queryAll(node, s);
  children.forEach((c) => (c.parentNode = node));
  return node;
}
const textEl = (cls, text) => el("a", { cls, text }); // eslint-disable-line no-unused-vars

/** 假窗口: 可开关 UE / 记录被调用的页面函数 */
function fakeWin({ href = "https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew", UE = null, pageFn = null } = {}) {
  const w = {
    location: { href },
    UE,
    events: [],
    alert: () => {},
    HTMLTextAreaElement: { prototype: {} },
    HTMLInputElement: { prototype: {} },
    Event: class {
      constructor(type, opts) {
        this.type = type;
        this.opts = opts;
        this.bubbles = opts && opts.bubbles;
      }
    },
  };
  // 原生 value setter(模拟浏览器原型上的访问器属性)
  for (const P of [w.HTMLTextAreaElement.prototype, w.HTMLInputElement.prototype]) {
    Object.defineProperty(P, "value", {
      configurable: true,
      get() {
        return this._v;
      },
      set(v) {
        this._v = v;
      },
    });
  }
  if (pageFn) Object.assign(w, pageFn);
  return w;
}

/** 造一个用假窗口原型做的输入框(这样才能命中 native setter 分支) */
function inputLike(win, tag, { name = "answer", cls = "" } = {}) {
  const proto = tag === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const node = Object.create(proto);
  Object.assign(node, {
    tagName: tag,
    name,
    className: cls,
    events: [],
    getAttribute: (n) => (n === "class" ? cls : n === "name" ? name : null),
    dispatchEvent(e) {
      node.events.push(e);
      return true;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  return node;
}

/** 题目容器: zj 结构(.TiMu > .fontLabel + li[class*=before-after] > a.fl.after) */
function zjQuestion(optionTexts, { qid = "1", fallbackStruct = false, role = "radio" } = {}) {
  const titleEl = el("div", { cls: "fontLabel qtContent", text: "题干文字" });
  const options = optionTexts.map((t, i) => {
    const inner = el("a", { cls: fallbackStruct ? "fl" : "fl after", text: t });
    const li = el("li", {
      cls: fallbackStruct ? "clearfix" : `before-after-${role}`,
      attrs: { role: fallbackStruct ? "option" : role, qid: String(qid), qtype: role === "checkbox" ? "1" : "0", "aria-label": `${String.fromCharCode(65 + i)} 选项选择` },
      children: [inner],
    });
    return li;
  });
  const list = el("ul", { cls: fallbackStruct ? "Zy_ulTop qtDetail" : "Zy_ulTop w-top", children: options });
  return el("div", { cls: "TiMu newTiMu", children: [titleEl, list] });
}
const makeAdapter = (type, doc, win) => {
  const a = new CxAdapter(type);
  a._document = doc;
  a._window = win;
  return a;
};
const futureDoc = (extra = {}) => Object.assign({ body: { innerText: "" }, documentElement: { innerText: "" }, querySelector: () => null, querySelectorAll: () => [] }, extra);

async function main() {
  console.log("== 1) 填空/简答写入: 无 UE 时降级写 value + 派发 input/change ==");
  {
    const win = fakeWin();
    const a = makeAdapter("zj", futureDoc(), win);
    const ta = inputLike(win, "TEXTAREA");
    ok(a.fillTextElement(ta, "毛泽东思想") === true, "写入返回 true");
    ok(ta._v === "毛泽东思想", "值真的写进去了(走原型 setter)");
    ok(ta.events.map((e) => e.type).join(",") === "input,change", `派发了 input+change(实际 ${ta.events.map((e) => e.type).join(",") || "无"})`);
  }

  console.log("== 2) 有 UE 富文本时优先走 UE ==");
  {
    const calls = [];
    const win = fakeWin({ UE: { getEditor: (n) => ({ setContent: (v) => calls.push([n, v]) }) } });
    const a = makeAdapter("zj", futureDoc(), win);
    const ta = inputLike(win, "TEXTAREA", { name: "content1" });
    a.fillTextElement(ta, "答案甲");
    ok(calls.length === 1 && calls[0][0] === "content1" && calls[0][1] === "答案甲", "调了 UE.getEditor(name).setContent()");
    ok(ta._v === undefined, "UE 成功时不重复写 value");
  }

  console.log("== 3) 简答题没有 UE 也不能抛(以前直接读 this._window.UE 会 TypeError) ==");
  {
    const win = fakeWin(); // 无 UE
    const qEl = el("div", { cls: "TiMu", children: [el("div", { cls: "fontLabel", text: "简答: 试述…" })] });
    const ta = inputLike(win, "TEXTAREA");
    qEl.children.push(ta);
    ta.parentNode = qEl;
    const a = makeAdapter("zj", futureDoc(), win);
    const q = { element: qEl, type: QTYPE.ESSAY, title: "简答", options: {}, optionsText: [], answer: ["这是简答答案"] };
    const filled = await a.fillQuestion(q);
    ok(filled === 1, `简答题填入 1(filled=${filled}, 以前会抛异常 → runner 记「填充失败」)`);
    ok(ta._v === "这是简答答案", "答案写进了 textarea");
  }

  console.log("== 4) 自动提交用题目所在那一层的 window(嵌套 iframe 场景) ==");
  {
    const outerWin = fakeWin({ pageFn: { btnBlueSubmit: () => (outerWin.called = true) } });
    const innerWin = fakeWin({ pageFn: { btnBlueSubmit: () => (innerWin.called = true) } });
    const a = makeAdapter("zj", futureDoc(), outerWin);
    a._activeWin = innerWin; // parseHtml 找到内层题目后就是这么设的
    ok(a.activeWindow() === innerWin, "activeWindow() 指向内层");
    const r = await a.autoSubmit({ sleep: async () => {}, confirmWaitMs: 1, settleMs: 1, correctRate: 100, threshold: 85 });
    ok(innerWin.called === true, "调的是内层 window 的 btnBlueSubmit");
    ok(!outerWin.called, "没有误调外层 window 的页面函数");
    ok(r && r.reason !== undefined, `返回结构化结果(reason=${r && r.reason})`);
  }

  console.log("== 5) 选择器走契约表: zj 结构与已批阅/新版兜底结构都能解析 ==");
  {
    const win = fakeWin();
    ok(CX_STUDY_SEL.answer.zj.optionItem === '[class*="before-after"]', "契约表里有 zj 选项选择器");
    const a = makeAdapter("zj", futureDoc(), win);
    a.addQuestion(zjQuestion(["A 贸易顺差", "B 贸易逆差", "C 都不是", "D 说不清"]));
    const q = a.questions[0];
    ok(!!q, "解析出 1 题");
    ok(q.title === "题干文字", `题干取 .fontLabel(实际「${q && q.title}」)`);
    ok(q.optionsText.length === 4 && q.optionsText[0] === "A 贸易顺差", `4 个选项文本(实际 ${q && q.optionsText.join("|")})`);
    ok(q.type === QTYPE.SINGLE, `role=radio 的结构推断为单选(实际 ${q && q.type})`);
    ok(typeof q.options[q.optionsText[0]]?.click === "function", "options 是 文本→DOM 的映射");

    // role=checkbox 的多选
    const m = makeAdapter("zj", futureDoc(), win);
    m.addQuestion(zjQuestion(["A", "B", "C"], { qid: "3", role: "checkbox" }));
    ok(m.questions[0].type === QTYPE.MULTI, `role=checkbox 的结构推断为多选(实际 ${m.questions[0].type})`);

    // 没有 .fl.after 的已批阅/新版结构 → 走契约表里的兜底分支
    const b = makeAdapter("zj", futureDoc(), win);
    b.addQuestion(zjQuestion(["甲", "乙"], { qid: "2", fallbackStruct: true }));
    ok(b.questions[0].optionsText.join("|") === "甲|乙", `兜底结构也能取到选项(实际 ${b.questions[0].optionsText.join("|")})`);
  }

  console.log("== 6) 判断题按 aria-label 里的「对选择/错选择」定位 ==");
  {
    const win = fakeWin();
    const yes = el("li", { cls: "before-after", attrs: { "aria-label": "A 对选择", "aria-checked": "false" } });
    const no = el("li", { cls: "before-after", attrs: { "aria-label": "B 错选择", "aria-checked": "false" } });
    const qEl = el("div", { cls: "TiMu", children: [el("div", { cls: "fontLabel", text: "判断题" }), el("ul", { cls: "Zy_ulTop", children: [yes, no] })] });
    const a = makeAdapter("zj", futureDoc(), win);
    const q = { element: qEl, type: QTYPE.JUDGE, title: "判断题", options: { 对: yes, 错: no }, optionsText: ["对", "错"], answer: ["错误"] };
    // 点完要把 aria-checked 变成 true, 否则回读校验会认为没勾上
    no.click = () => {
      no.clicks++;
      no.setAttribute("aria-checked", "true");
    };
    const filled = await a.fillQuestion(q);
    ok(filled === 1, `判断题填入 1(filled=${filled})`);
    ok(no.clicks === 1 && yes.clicks === 0, "答案「错误」→ 点的是「错选择」那个");
  }

  console.log("== 7) 章节页内嵌作业: setContext 注入的帧就是解析/提交的那一层 ==");
  {
    // 内嵌接管不走 `new CxAdapter(type, iframe)`(扫描拿到的是 doc/win, 不是 iframe 元素), 走 setContext。
    const outerWin = fakeWin({ pageFn: { btnBlueSubmit: () => (outerWin.called = true) } });
    const frameWin = fakeWin({
      href: "https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=58158968&api=1",
      pageFn: { btnBlueSubmit: () => (frameWin.called = true) },
    });
    const frameDoc = futureDoc({ location: { href: frameWin.location.href } });
    const a = new CxAdapter("zj");
    ok(a.setContext(frameDoc, frameWin, outerWin) === a, "setContext 返回自己(可链式)");
    ok(a._document === frameDoc && a._window === frameWin, "doc/win 成对换到内嵌帧");
    ok(a.activeWindow() === frameWin, "activeWindow() = 内嵌帧窗口(没跑 parseHtml 也不会误用顶层)");
    ok(a._hostWin === outerWin, "宿主窗口记下来(字体注入在帧外面的章节页上时解密要用)");

    const r = await a.autoSubmit({ sleep: async () => {}, confirmWaitMs: 1, settleMs: 1, correctRate: 100, threshold: 85 });
    ok(frameWin.called === true, "提交调的是内嵌帧的 btnBlueSubmit");
    ok(!outerWin.called, "没有误调顶层窗口的页面函数");
    ok(r && r.reason !== undefined, `返回结构化结果(reason=${r && r.reason})`);

    // 题目元数据(refer)也得指向内嵌帧, 否则取答案时带错页面地址
    const b = new CxAdapter("zj").setContext(frameDoc, frameWin);
    b.addQuestion(zjQuestion(["A 甲", "B 乙"]));
    ok(b.questions[0].refer === frameWin.location.href, "题目 refer 用内嵌帧的 URL");

    // 原有构造方式(传 iframe 元素)不能被改坏
    const c = new CxAdapter("zj", { contentDocument: frameDoc, contentWindow: frameWin });
    ok(c._document === frameDoc && c._window === frameWin, "传 iframe 元素的旧构造路径照旧");
  }

  /* ---------- 章节页编排: 接管内嵌作业帧 / 没有答题页时不再静默 ---------- */
  const STUDENTSTUDY =
    "https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1000000008&courseId=100000004&clazzid=100000002&mooc2=1";
  const WORK_URL = "https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=100000004&workAnswerId=10000009&workId=58158968&api=1";
  /** 假帧窗口(mimic 真机 top/4/0/0): questions 非空 = 这一帧里已经有题目容器 */
  const frameWinOf = (href, frames = [], questions = []) => ({
    location: { href },
    document: {
      location: { href },
      body: { innerText: "" },
      documentElement: { innerText: "" },
      querySelector: () => null,
      querySelectorAll: (s) => (s === "iframe" ? frames : String(s).includes("TiMu") ? questions : []),
    },
  });
  /** 章节学习页: 顶层 doc(readyState=complete) + 可指定的 iframe 列表 */
  const chapterPage = (frames = []) => {
    const doc = {
      readyState: "complete",
      location: { href: STUDENTSTUDY },
      body: { innerText: "" },
      documentElement: { innerText: "" },
      querySelector: () => null,
      querySelectorAll: (s) => (s === "iframe" ? frames : []),
    };
    return { doc, win: { document: doc, location: { href: STUDENTSTUDY } } };
  };
  const fakePanel = (logs) => ({
    log: (m, t) => logs.push([m, t]),
    getCourseRate: () => 1.5,
    getAutoSubmit: () => false,
    getAutoAnswer: () => false,
    resetQuestions: () => {},
  });
  const runtime = await import("../src/runtime.js");

  console.log("== 8) 章节页没有内嵌作业帧: 点 ①②③ 会打警告, 不再静默 ==");
  {
    const logs = [];
    const fake = fakePanel(logs);
    runtime.usePanel(fake);
    const page = chapterPage();
    await runtime.startAnswering({ win: page.win, doc: page.doc, log: (m, t) => logs.push([m, t]), embedWork: { tries: 1, intervalMs: 0 } });
    ok(
      typeof fake.onParse === "function" && typeof fake.onAskAll === "function" && typeof fake.onFillAll === "function",
      "没找到答题页也把 ①②③ 接上了(以前直接 return, 面板按钮是空的)"
    );
    await fake.onParse();
    ok(
      logs.some(([m, t]) => /没找到答题页/.test(m) && t === "warning"),
      "① 解析会明确警告(以前 handler 为空直接 return, 一条日志都没有)"
    );
    const before = logs.length;
    await fake.onAskAll();
    await fake.onFillAll();
    ok(logs.slice(before).filter(([m]) => /没找到答题页/.test(m)).length === 2, "② 取答案 / ③ 填入 同样有话说");
  }

  console.log("== 8b) 正文帧没加载出内容: 说「还没加载完」而不是「没找到答题页」 ==");
  {
    // 真机症状(2026-11-13): iframe#iframe 的 src 已经是 /mooc-ans/knowledge/cards, 但 contentWindow 还是 about:blank
    const blankWin = {
      location: { href: "about:blank" },
      document: {
        location: { href: "about:blank" },
        readyState: "loading",
        body: { innerText: "" },
        documentElement: { innerText: "" },
        querySelector: () => null,
        querySelectorAll: () => [],
      },
    };
    const blankCards = { getAttribute: () => "/mooc-ans/knowledge/cards?clazzid=100000002&knowledgeid=1", contentWindow: blankWin };

    const logs = [];
    const fake = fakePanel(logs);
    runtime.usePanel(fake);
    const page = chapterPage([blankCards]);
    await runtime.startAnswering({ win: page.win, doc: page.doc, log: (m, t) => logs.push([m, t]), embedWork: { tries: 1, intervalMs: 0 } });
    await fake.onParse();
    ok(
      logs.some(([m, t]) => /页面正文还没加载完/.test(m) && /刷新/.test(m) && t === "warning"),
      "空正文帧 → 给「正文还没加载完，刷新一下再试」的 warning"
    );
    ok(!logs.some(([m]) => /没找到答题页/.test(m)), "不再报「没找到答题页」(用户看不懂那句)");
    ok(!logs.some(([m, t]) => /正文还没加载完/.test(m) && t === "danger"), "类型不是 danger(这不是错误, 只是还没好)");
    ok(!/doHomeWorkNew|iframe|cx\/chapter/.test(logs.map(([m]) => m).join(" ")), "提示里没有内部黑话");
  }

  console.log("== 8c) 正文帧加载完但里面没任务点: 也算「还没加载完」 ==");
  {
    const emptyCards = {
      getAttribute: () => "/mooc-ans/knowledge/cards?clazzid=100000002",
      contentWindow: frameWinOf("https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=100000002", [], []),
    };
    const logs = [];
    const fake = fakePanel(logs);
    runtime.usePanel(fake);
    const page = chapterPage([emptyCards]);
    await runtime.startAnswering({ win: page.win, doc: page.doc, log: (m, t) => logs.push([m, t]), embedWork: { tries: 1, intervalMs: 0 } });
    await fake.onParse();
    ok(logs.some(([m, t]) => /页面正文还没加载完/.test(m) && t === "warning"), "没有任务点容器 → 仍是「还没加载完」");
  }

  console.log("== 8d) 正文帧加载完、有任务点但没作业: 保留「没找到答题页」 ==");
  {
    // 这里不能再用 frameWinOf: 它 querySelectorAll 对任何非 iframe 选择器都返回 []。正文己加载要有任务点容器。
    const readyCardsDoc = {
      location: { href: "https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=100000002" },
      readyState: "complete",
      body: { innerText: "" },
      documentElement: { innerText: "" },
      querySelector: () => null,
      querySelectorAll: (s) => (s === "iframe" ? [] : [{}]),
    };
    const readyCards = {
      getAttribute: () => "/mooc-ans/knowledge/cards?clazzid=100000002",
      contentWindow: { location: readyCardsDoc.location, document: readyCardsDoc },
    };
    const logs = [];
    const fake = fakePanel(logs);
    runtime.usePanel(fake);
    const page = chapterPage([readyCards]);
    await runtime.startAnswering({ win: page.win, doc: page.doc, log: (m, t) => logs.push([m, t]), embedWork: { tries: 1, intervalMs: 0 } });
    await fake.onParse();
    ok(logs.some(([m, t]) => /没找到答题页/.test(m) && t === "warning"), "正文加载完、就是没作业 → 原句「没找到答题页」");
    ok(!logs.some(([m]) => /页面正文还没加载完/.test(m)), "不会误报「还没加载完」");
  }

  console.log("== 8e) 帧晚加载: load 事件补重试能接上(轮询窗口早过了) ==");
  {
    const frames = [];
    const loadListeners = [];
    const doc = {
      readyState: "complete",
      location: { href: STUDENTSTUDY },
      body: { innerText: "" },
      documentElement: { innerText: "" },
      querySelector: () => null,
      querySelectorAll: (s) => (s === "iframe" ? frames : []),
      addEventListener: (t, fn) => {
        if (t === "load") loadListeners.push(fn);
      },
      removeEventListener: () => {},
    };
    const page = { doc, win: { document: doc, location: { href: STUDENTSTUDY } } };
    const logs = [];
    const fake = fakePanel(logs);
    runtime.usePanel(fake);
    // 轮询只给它 1 次且不等待 → 一开始找不到(模拟「帧晚了几分钟」)
    await runtime.startAnswering({ win: page.win, doc: page.doc, log: (m, t) => logs.push([m, t]), embedWork: { tries: 1, intervalMs: 0 } });
    ok(loadListeners.length > 0, "顶层文档挂上了 load 监听(捕获阶段)");
    ok(!logs.some(([m]) => /已直接接管/.test(m)), "启动时确实还没接上");

    // 晚加载: 然后作业帧才插进来
    const workWin = frameWinOf(WORK_URL, [], [{}]);
    const shellWin = frameWinOf("https://mooc1.chaoxing.com/ananas/modules/work/index.html?courseId=100000004", [
      { getAttribute: () => "/mooc-ans/work/doHomeWorkNew", contentWindow: workWin },
    ]);
    const cardsWin = frameWinOf("https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=100000002", [
      { getAttribute: () => "/ananas/modules/work/index.html", contentWindow: shellWin },
    ]);
    frames.push({ getAttribute: () => "/mooc-ans/knowledge/cards", contentWindow: cardsWin });
    loadListeners.forEach((fn) => fn({ target: { tagName: "IFRAME" } }));
    await new Promise((r) => setTimeout(r, 500));
    ok(logs.some(([m, t]) => /已直接接管/.test(m) && t === "success"), "帧 load 后自动重试并接管成功");

    // 接管后再来一波 load: 不应该重复接管/重复打日志
    const beforeDup = logs.filter(([m]) => /已直接接管/.test(m)).length;
    loadListeners.forEach((fn) => fn({ target: { tagName: "IFRAME" } }));
    await new Promise((r) => setTimeout(r, 500));
    ok(logs.filter(([m]) => /已直接接管/.test(m)).length === beforeDup, "接管成功后不再重复接管(不空转)");
  }

  console.log("== 9) 章节页有内嵌作业帧: 启动即接管, 刷课链路照旧 ==");
  {
    runtime.resetRuntimeForTest(); // 8e 留下的 handler 会黏住, 这里要干净的初始态
    const logs = [];
    const fake = fakePanel(logs);
    runtime.usePanel(fake);
    const workWin = frameWinOf(WORK_URL, [], [{}]);
    const shellWin = frameWinOf("https://mooc1.chaoxing.com/ananas/modules/work/index.html?courseId=100000004", [
      { getAttribute: () => "/mooc-ans/work/doHomeWorkNew", contentWindow: workWin },
    ]);
    const cardsWin = frameWinOf("https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=100000002", [
      { getAttribute: () => "/ananas/modules/work/index.html", contentWindow: shellWin },
    ]);
    const page = chapterPage([{ getAttribute: () => "/mooc-ans/knowledge/cards", contentWindow: cardsWin }]);
    await runtime.startAnswering({ win: page.win, doc: page.doc, log: (m, t) => logs.push([m, t]), embedWork: { tries: 3, intervalMs: 0 } });
    ok(
      logs.some(([m, t]) => m.includes("作业在页面内嵌帧(第 3 层 doHomeWorkNew)，已直接接管，不用跳页") && t === "success"),
      "日志说清了: 作业在第 3 层内嵌帧, 已直接接管, 不用跳页"
    );
    ok(logs.some(([m]) => /「刷课」页签/.test(m)), "章节页原有刷课提示照旧(没被接管抢掉)");
    ok(typeof fake.onCourseToggle === "function", "「开始刷课」按钮仍接上(刷课能力保留)");
    const before = logs.length;
    await fake.onAskAll();
    ok(
      logs.slice(before).some(([m]) => /先点「① 解析题目」/.test(m)),
      "② 走的是「先解析」而不是「没答题页」→ handler 确实接管了"
    );
    ok(!logs.some(([m]) => /没找到答题页/.test(m)), "接管成功后不会再报「没找到答题页」");
  }

  console.log(`\n${fail ? "❌" : "✅"} 全部通过: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
