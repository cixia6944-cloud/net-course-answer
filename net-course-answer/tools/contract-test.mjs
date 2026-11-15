#!/usr/bin/env node
// 契约测试: contract/cx-study-contract.js —— 用采集到的真机结构当夹具(node tools/contract-test.mjs)
// 夹具来源: 情报\章节-新列表页.dom.json / 章节-旧任务点树.dom.json / 采集发现-20260911.md §一/§二/§八
import { parseJobs, parseNewChapterList, readUnfinished, CX_STUDY_SEL, collectDocs, findQuestionDoc, isReviewedView, findCoursewareDoc } from "../src/contract/cx-study-contract.js";
import { readPageState, findNextPageControl, DEFAULT_COURSEWARE_OPTIONS, pageNumButtons, activePageIndex } from "../src/adapters/cx-courseware.js";

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
function el(sel = {}, children = []) {
  const node = {
    tagName: (sel.tag || "div").toUpperCase(),
    className: sel.cls || "",
    id: sel.id || "",
    _text: sel.text || "",
    _cls: sel.cls,
    _attrs: sel.attrs || {},
    parentElement: null,
    _children: children,
    getAttribute: (n) => (n === "class" ? sel.cls || "" : n in (sel.attrs || {}) ? sel.attrs[n] : null),
    querySelector(s) {
      return this.querySelectorAll(s)[0] || null;
    },
    querySelectorAll(s) {
      const out = [];
      const match = (n, q) => {
        // 支持 .class / [attr*=v] / tag[attr*=v]
        let rest = q;
        const tagMatch = /^([a-z]+)/i.exec(q);
        if (tagMatch) {
          if (String(n.tagName || "").toLowerCase() !== tagMatch[1].toLowerCase()) return false;
          rest = q.slice(tagMatch[1].length);
        }
        if (rest.startsWith(".")) return String(n.className || "").split(/\s+/).includes(rest.slice(1));
        if (rest.startsWith("[")) {
          const m = /\[([a-z-]+)\*?=['"]?([^'"\]]+)/.exec(rest);
          if (!m) return false;
          const v = n.getAttribute(m[1]) || String(n.className || "");
          return rest.includes("*=") ? String(v).includes(m[2]) : String(v) === m[2];
        }
        return rest === "";
      };
      const walk = (n) => {
        for (const c of n._children || []) {
          if (match(c, s)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    closest(s) {
      let n = this;
      while (n) {
        if (n.classList_has ? n.classList_has(s) : String(n.className || "").split(/\s+/).includes(String(s).replace(/^\./, ""))) return n;
        n = n.parentElement;
      }
      return null;
    },
    get textContent() {
      return [this._text, ...(this._children || []).map((c) => c.textContent)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    },
    scrollIntoView() {},
    click() {},
  };
  children.forEach((c) => (c.parentElement = node));
  return node;
}
const doc = (nodes) => ({
  querySelectorAll: (s) => {
    const out = [];
    for (const n of nodes) {
      if (String(n.className || "").split(/\s+/).includes(s.replace(/^\./, ""))) out.push(n);
      else if (s.startsWith("[") && String(n.getAttribute("onclick") || "").includes(s.match(/=\s*['"]?([^'"\]]+)/)?.[1] || "\u0000")) out.push(n);
      else out.push(...n.querySelectorAll(s));
    }
    return out;
  },
});

/* ---------- 夹具 ---------- */
const videoIframe = (src) => el({ tag: "iframe", attrs: { src } });
const jobIcon = (aria, cls = "ans-job-icon ans-job-video") => el({ cls, attrs: { "aria-label": aria } }); // eslint-disable-line

console.log("== 1) readUnfinished: 三种写法 ==");
{
  const a = el({ cls: "posCatalog_select" }, [el({ cls: "jobUnfinishCount", text: "4" })]);
  ok(readUnfinished(a) === 4, "写法①.jobUnfinishCount=4");
  const b = el({ cls: "posCatalog_select" }, [el({ cls: "catalog_points_yi", text: "3个待完成任务点3" })]);
  ok(readUnfinished(b) === 3, "写法②「3个待完成任务点3」=3");
  const c = el({ cls: "posCatalog_select" }, [el({ cls: "catalog_points_yi", text: "0" })]);
  ok(readUnfinished(c) === 0, "写法③裸 0 = 已完成");
  ok(readUnfinished(null) === 0, "空输入 → 0");
}

console.log("== 2) parseJobs: 一页多个视频任务点(3.9 真机结构) ==");
{
  const container = (aria, frameSrc) =>
    el({ cls: "ans-attach-ct videoContainer" }, [jobIcon(aria), frameSrc ? videoIframe(frameSrc) : el({})]);
  const c0 = container("任务点已完成", "https://x/ananas/modules/video/index.html?v=1");
  const c1 = container("任务点未完成", "https://x/ananas/modules/video/index.html?v=1");
  const c2 = container("任务点未完成", "https://x/ananas/modules/video/index.html?v=1");
  const jobs = parseJobs(doc([c0, c1, c2]));
  ok(jobs.length === 3, `识别出 3 个任务点(实际 ${jobs.length})`);
  ok(jobs[0].done === true && jobs[1].done === false && jobs[2].done === false, "完成态按 aria-label 判定(1 完成 / 2 未完成)");
  ok(!!jobs[1].frameEl, "每个任务点带自己的视频 iframe(修「漏视频」的关键)");
  ok(jobs.map((j) => j.key).join(",") === "job-0,job-1,job-2", "key 稳定(job-0/1/2)");
  ok(jobs[1].kind === "video", `kind 从 iframe src 识别(实际 ${jobs[1].kind})`);
  ok(/视频/.test(jobs[1].label) || /video/i.test(jobs[1].label), `label 带类型(实际 ${jobs[1].label})`);
}

console.log("== 3) parseJobs: 无 aria 时退回容器类名 ans-job-finished ==");
{
  const finished = el({ cls: "ans-attach-ct videoContainer ans-job-finished" }, [jobIcon("", "ans-job-icon ans-job-video")]);
  const pending = el({ cls: "ans-attach-ct videoContainer" }, [jobIcon("", "ans-job-icon ans-job-video")]);
  const jobs = parseJobs(doc([finished, pending]));
  ok(jobs[0].done === true && jobs[1].done === false, "类名兜底判定完成态");
  ok(jobs[0].frameEl === null || jobs[0].frameEl === undefined, "没有视频 iframe 时 frameEl 为空(说明是文档类任务点)");
}

console.log("== 3b) parseJobs: aria-label 缺失时用图标 class 兜底(以前这个分支永远进不去) ==");
{
  const doneIcon = el({ cls: "ans-job-icon ans-job-icon-clear" }, []);
  const plainIcon = el({ cls: "ans-job-icon ans-job-video" }, []);
  const withMark = el({ cls: "ans-attach-ct videoContainer" }, [doneIcon]);
  const noMark = el({ cls: "ans-attach-ct videoContainer" }, [plainIcon]);
  const jobs = parseJobs(doc([withMark, noMark]));
  ok(jobs[0].done === true, "aria 缺失 + 图标带完成标记 → done=true");
  ok(jobs[1].done === false, "aria 缺失 + 无完成标记 → done=false");
  ok(jobs[0].ariaLabel === null, "ariaLabel 缺失时是 null");
}

console.log("== 4) parseNewChapterList: 新版泛雅3 章节列表 ==");;
{
  const mk = (title, onclick, state) =>
    el({ cls: "chapter_item", attrs: { onclick } }, state ? [el({ cls: "catalog_task", text: state })] : []);
  const list = doc([
    mk("1 导论", "", ""), // 章标题: 没有 toOld → 跳过
    mk("1.1 马克思主义为什么要中国化？", "toOld('100000006', '1000000101', '100000007',0)", "已完成"),
    mk("3.9 “革命统一战线”之三理说", "toOld('100000006', '1103250738', '100000007',0)", "2个待完成任务点"),
  ]);
  const items = parseNewChapterList(list);
  ok(items.length === 2, `跳过无 toOld 的标题行(实际 ${items.length} 条)`);
  ok(items[0].knowledgeId === "1000000101" && items[0].unfinished === 0 && items[0].done, "「已完成」→ unfinished=0, done=true");
  ok(items[1].knowledgeId === "1103250738" && items[1].unfinished === 2, "「2个待完成任务点」→ unfinished=2");
  ok(items[1].courseId === "100000006" && items[1].clazzId === "100000007", "courseId/clazzId 解析正确");
}

console.log("== 5) 契约表本身: 关键选择器没写丢 ==");
{
  const s = CX_STUDY_SEL;
  ok(s.old.item === ".posCatalog_name", "旧目录项 .posCatalog_name");
  ok(/dct/.test(s.old.tab) && /changeDisplayContent/.test(s.old.tab), "类型标签 li#dct / changeDisplayContent");
  ok(s.old.jobIcon === ".ans-job-icon", "任务点图标 .ans-job-icon");
  ok(String(s.old.videoFrame) === String(/ananas\/modules\/video/), "视频 iframe 匹配");
  ok(/studentcourse/.test(String(s.neu.listFrame)), "新版章节列表 iframe 匹配");
  // 答题页(cx.js)的选择器也在契约表里 —— 以前散在 cx.js, 改版得改两处
  const a = s.answer;
  ok(a.question.zj === ".TiMu, .questionLi" && !!a.question.zy && !!a.question.ks, "三类答题页的题目容器选择器");
  ok(a.zj.title === ".fontLabel" && a.zj.optionItem === '[class*="before-after"]' && a.zj.optionText === ".fl.after", "zj 题干/选项选择器");
  ok(!!a.zj.optionListFallback && !!a.zj.optionTextFallback, "已批阅/新版结构的兜底选择器");
  ok(a.zy.title === "h3" && a.zy.optionItem === ".answerBg" && a.zy.optionText === ".answer_p", "zy/ks 题干/选项选择器");
  ok(a.judge.ariaTrue === "对选择" && a.judge.ariaFalse === "错选择" && /check_answer/.test(a.judge.checked), "判断题标记");
  ok(/textarea/.test(a.fill.field) && a.fill.textarea === "textarea", "填空/简答输入控件");
}

console.log("== 6) P0: 递归 iframe(实测作业 4 层 / 课件 5 层) ==");
{
  // 造三层嵌套: top > l1 > l2 > l3(题目在 l3)
  const qEl = el({ cls: "TiMu newTiMu ans-cc" }, [el({ cls: "newZy_TItle", text: "【单选题】x" })]);
  const l3 = { document: { querySelectorAll: (s) => (s.includes("TiMu") ? [qEl] : []), querySelector: () => qEl, body: { innerText: "【单选题】" }, defaultView: {} } };
  const l2 = { document: { querySelectorAll: (s) => (s === "iframe" ? [{ getAttribute: () => "/ananas/modules/work/index.html", contentWindow: l3 }] : []), querySelector: () => null, body: { innerText: "" } } };
  const l1 = { document: { querySelectorAll: (s) => (s === "iframe" ? [{ getAttribute: () => "/mooc-ans/knowledge/cards", contentWindow: l2 }] : []), querySelector: () => null, body: { innerText: "" } } };
  const top = { document: { querySelectorAll: (s) => (s === "iframe" ? [{ getAttribute: () => "/top", contentWindow: l1 }] : []), querySelector: () => null, body: { innerText: "" } } };
  const docs = collectDocs(top, 6);
  ok(docs.length >= 4, `递归收集到 ${docs.length} 个文档(应 ≥4)`);
  const hit = findQuestionDoc(top, CX_STUDY_SEL.work);
  ok(hit && hit.count === 1, `在第 ${hit ? hit.depth : "?"} 层找到题目容器`);
  ok(hit && /work/.test(hit.path), `路径含 work: ${hit ? hit.path : ""}`);
}

console.log("== 7) P0: 已批阅视图识别(无作答控件 + 有「我的答案」) ==");
{
  const reviewedDoc = {
    body: { innerText: "我的答案： C 25.0分" },
    querySelectorAll: () => [],
  };
  ok(isReviewedView(reviewedDoc) === true, "无控件且含我的答案 → 判为已批阅");
  const editableDoc = {
    body: { innerText: "单选题" },
    querySelectorAll: (s) => (/role=radio/.test(s) ? [el({})] : []),
  };
  ok(isReviewedView(editableDoc) === false, "有作答控件 → 不是已批阅");
}

console.log("== 8) P1: 课件页码/翻页控件 ==");
{
  const doc = {
    body: { innerText: "1 2 3 4 5 6 7 100% - +" },
    querySelectorAll: (s) => {
      if (s.includes("next")) return [{ className: "next", click() {} }];
      if (s === "a,span,div,li") return [1, 2, 3, 4, 5, 6, 7].map((n) => ({ textContent: String(n), className: n === 3 ? "active" : "" }));
      return [];
    },
    querySelector: (s) => (s.includes("next") ? { className: "next", click() {} } : null),
  };
  const st = readPageState(doc);
  ok(st.total === 7, `总页数 7(实际 ${st.total})`);
  ok(st.cur === 3, `当前页 = 激活按钮的 3(实际 ${st.cur})`);
  ok(pageNumButtons(doc).length === 0, "这个页面没有 pageNum 按钮(走数字元素兜底)");
  ok(activePageIndex([{ className: "active" }, { className: "pageNum" }]) === 0, "activePageIndex 能识别 active");
  ok(activePageIndex([]) === -1, "没有激活态 → -1");
  const nx = findNextPageControl(doc);
  ok(nx && /next/.test(nx.how), `找到翻页控件(${nx ? nx.how : "无"})`);
  ok(DEFAULT_COURSEWARE_OPTIONS.pageDwellMs >= 1000, "每页停留默认 ≥1s(让计时算数)");
}

console.log("== 9) P1: 真机翻页靠 span.pageNum(点页码跳页) ==");
{
  const mk = (n, active) => ({ textContent: String(n), className: "pageNum" + (active ? " active" : ""), click() {} });
  const pages = [1, 2, 3, 4, 5].map((n) => mk(n, n === 2));
  const doc = {
    body: { innerText: "1 2 3 4 5 100% - +" },
    querySelectorAll: (s) => {
      if (s.includes("pageNum")) return pages;
      if (s.includes("next")) return [];
      if (s === "a,span,div,li") return pages;
      return [];
    },
    querySelector: () => null,
  };
  const st = readPageState(doc);
  ok(st.byPageNum === true && st.total === 5, `pageNum 识别 5 页(实际 ${st.total}, byPageNum=${st.byPageNum})`);
  ok(st.cur === 2, `激活页 = 2(实际 ${st.cur})`);
}

console.log("== 10) 章节页内嵌作业: 从 iframe 树里挑出答题帧(真机 top/4/0/0 形状) ==");
// adapters/index.js → cx.js → font-decrypt.js → vendor/typr.js 顶层就用 window.TextDecoder:
// 先垫一个 window 再动态 import(和 cx-adapter-test 同一个手法)。
globalThis.window = globalThis;
const { findWorkFrame } = await import("../src/adapters/work-frame.js");
const { cxWorkTypeForUrl, createAdapterForUrl } = await import("../src/adapters/index.js");
{
  // 真机: studentstudy → cards → ananas/modules/work/index.html → /work/doHomeWorkNew(第 3 层)
  const S = "https://mooc1.chaoxing.com";
  const STUDENTSTUDY = `${S}/mycourse/studentstudy?chapterId=1000000008&courseId=100000004&clazzid=100000002&mooc2=1`;
  const WORK_URL = `${S}/mooc-ans/work/doHomeWorkNew?courseId=100000004&workAnswerId=10000009&workId=58158968&api=1`;
  const frameEl = (src, contentWindow) => ({ getAttribute: () => src, contentWindow });
  // q 非空 = 这一帧里已经有题目容器; 其它选择器一律空(collectDocs 只问 "iframe")
  const winOf = (href, frames = [], questions = []) => ({
    location: { href },
    document: {
      location: { href },
      body: { innerText: "" },
      documentElement: { innerText: "" },
      querySelector: () => null,
      querySelectorAll: (s) => (s === "iframe" ? frames : String(s).includes("TiMu") ? questions : []),
    },
  });

  const workWin = winOf(WORK_URL, [], [{}]);
  const shellWin = winOf(`${S}/ananas/modules/work/index.html?courseId=100000004`, [frameEl("/mooc-ans/work/doHomeWorkNew", workWin)]);
  const videoWin = winOf(`${S}/ananas/modules/video/index.html?v=1`);
  const cardsWin = winOf(`${S}/mooc-ans/knowledge/cards?clazzid=100000002`, [
    frameEl("/ananas/modules/video/index.html", videoWin),
    frameEl("/ananas/modules/work/index.html", shellWin),
  ]);
  const topWin = winOf(STUDENTSTUDY, [frameEl("/mooc-ans/knowledge/cards", cardsWin)]);

  const hit = findWorkFrame(topWin);
  ok(!!hit, "找到了内嵌答题帧");
  ok(hit && hit.workType === "zj", `doHomeWorkNew → zj(实际 ${hit && hit.workType})`);
  ok(hit && hit.depth === 3, `第 3 层(top/4/0/0 的真机形状, 实际 ${hit && hit.depth})`);
  ok(hit && hit.href === WORK_URL, "带回帧自己的 URL(日志/排错要看)");
  ok(hit && hit.win === workWin && hit.doc === workWin.document, "doc/win 成对指向题目那一帧(不能只给 doc)");
  ok(hit && hit.questions === 1, `报出帧里已渲染的题目数(实际 ${hit && hit.questions})`);
  ok(CX_STUDY_SEL.harvest.maxFrameDepth === 7, "默认深度上限沿用契约表 harvest.maxFrameDepth=7");
  ok(findWorkFrame(topWin, { maxDepth: 2 }) === null, "超过深度上限就当没看见(防病态嵌套)");

  // 只有视频/课件帧 → 没答题帧
  ok(findWorkFrame(winOf(STUDENTSTUDY, [frameEl("/ananas/modules/video/index.html", videoWin)])) === null, "纯视频章节页 → null");

  // 考试帧 / 新版作业帧
  const ksWin = winOf(`${S}/exam-ans/exam/test/reVersionTestStartNew?x=1`);
  ok(findWorkFrame(winOf(STUDENTSTUDY, [frameEl("/exam-ans/exam", ksWin)]))?.workType === "ks", "exam-ans → ks(考试页红线才不会漏)");
  const zyWin = winOf(`https://mooc2.chaoxing.com/mooc2/work/dowork?courseId=1`);
  ok(findWorkFrame(winOf(STUDENTSTUDY, [frameEl("/mooc2/work/dowork", zyWin)]))?.workType === "zy", "mooc2/work/dowork → zy");

  // 同源策略: 读不动的帧直接跳过, 不影响后面能读的
  const hostileWin = {
    get document() {
      throw new Error("SecurityError: cross-origin");
    },
  };
  const mixed = winOf(STUDENTSTUDY, [frameEl("https://other.example.com/x", hostileWin), frameEl("/mooc-ans/knowledge/cards", cardsWin)]);
  ok(findWorkFrame(mixed)?.win === workWin, "跨域帧读不到就跳过, 还能找到后面的作业帧");

  // 一章挂多个作业帧: 优先已经出题的那个(还没加载出题的先放着)
  const blankWin = winOf(`${WORK_URL}&oldWorkId=blank`);
  const readyWin = winOf(`${WORK_URL}&oldWorkId=ready`, [], [{}]);
  const two = winOf(STUDENTSTUDY, [
    frameEl("/mooc-ans/work/doHomeWorkNew?oldWorkId=blank", blankWin),
    frameEl("/mooc-ans/work/doHomeWorkNew?oldWorkId=ready", readyWin),
  ]);
  ok(findWorkFrame(two)?.win === readyWin, "多个作业帧时选已经渲染出题目的那个");
}

console.log("== 11) URL → workType 判据只一份(顶层路由与内嵌接管共用) ==");
{
  const S = "https://mooc1.chaoxing.com";
  ok(cxWorkTypeForUrl(`${S}/mooc-ans/work/doHomeWorkNew?workId=1`) === "zj", "doHomeWorkNew → zj");
  ok(cxWorkTypeForUrl(`https://mooc2.chaoxing.com/mooc2/work/dowork?x=1`) === "zy", "dowork → zy");
  ok(cxWorkTypeForUrl(`${S}/exam-ans/exam/test/reVersionTestStartNew`) === "ks", "exam-ans → ks");
  ok(cxWorkTypeForUrl(`${S}/mycourse/studentstudy?chapterId=1`) === null, "章节页本身不是答题页");
  // 重构后顶层路由必须一字不变
  ok(createAdapterForUrl(`${S}/mooc-ans/work/doHomeWorkNew?workId=1`)?.workType === "zj", "顶层平级作业页仍路由到 zj");
  ok(createAdapterForUrl(`${S}/mycourse/studentstudy?chapterId=1`)?.workType === "chapter", "章节页仍路由到 chapter(刷课链路不被动掉)");
}

console.log(`\n${fail ? "❌ 有失败" : "✅ 全部通过"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);