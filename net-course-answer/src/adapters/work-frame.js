// 章节页(内嵌作业)接管: 在递归 iframe 树里找**答题页那一帧**, 交回它的 document/window。
//
// 为什么需要: 章节学习页(studentstudy)的任务点「作业/测验/考试」是嵌在 iframe 里的
// (实测 top/4/0/0: 外层 ananas/modules/work/index.html, 里面才是 /work/doHomeWorkNew),
// 顶层没有题 → 顶层适配器拿到的是 null, 面板 ①②③ 全哑。同一份作业平级打开时一切正常,
// 说明适配器逻辑没问题, 缺的只是"找到那个帧并接管"。
//
// 只做只读探测, 不点任何东西。判据(URL 形态)复用 adapters/index.js 的 cxWorkTypeForUrl ——
// 顶层路由和内嵌接管必须认同一套 URL, 各写一份早晚漂。
import { collectDocs, CX_STUDY_SEL } from "../contract/cx-study-contract.js";
import { cxWorkTypeForUrl } from "./index.js";

/**
 * 找内嵌答题帧。
 * @param {Window} topWin 起始窗口(章节页顶层)
 * @param {{maxDepth?: number}} [opts] 深度上限, 默认沿用契约表 harvest.maxFrameDepth(7)
 * @returns {{workType:"zj"|"zy"|"ks", doc:Document, win:Window, path:string, depth:number, href:string, questions:number}|null}
 */
export function findWorkFrame(topWin, opts = {}) {
  const maxDepth = opts.maxDepth || CX_STUDY_SEL.harvest.maxFrameDepth;
  let docs = [];
  try {
    docs = collectDocs(topWin, maxDepth);
  } catch (e) {
    return null; // 拿不到任何文档(全被同源策略挡住) → 当没找到
  }
  const hits = [];
  for (const d of docs) {
    if (!d.depth) continue; // 顶层自己不是"内嵌"帧: 顶层是作业页时有它自己的路由
    const href = d.src || "";
    const workType = cxWorkTypeForUrl(href);
    if (!workType) continue;
    hits.push({ workType, doc: d.doc, win: d.win, path: d.path, depth: d.depth, href, questions: countQuestions(d.doc) });
  }
  if (!hits.length) return null;
  // 一章可能挂多个作业帧(不同内容块各一个): 优先已经渲染出题目的那个,
  // 都还没出题就取最浅的(外层就是作业页的情况)。
  return hits.find((h) => h.questions > 0) || hits.sort((a, b) => a.depth - b.depth)[0];
}

/**
 * 章节页「正文帧」(cards)的加载状态 —— 用来区分「页面没加载完」和「这页确实没有作业」。
 *
 * 实测(2026-11-13 真机): 切章节后顶层 `iframe#iframe` 的 src 已经写着
 * /mooc-ans/knowledge/cards?...，但它的 contentWindow 还是 about:blank，
 * 整棵帧树里一个题目容器都没有 —— 这时候说「没找到答题页」用户看不懂。
 *
 * 判据(任一命中即「还没加载完」)，只在**正文帧存在**时才判:
 *   ① 帧的 location.href 还是 about:blank(或读不到地址)
 *   ② 帧的 document.readyState 不是 complete
 *   ③ 帧里没有任何任务点容器(.ans-attach-ct / .videoContainer)
 * 正文帧压根不存在(被站点卸掉)时不在这里下结论, 仍按「没找到答题页」报。
 *
 * @returns {{found:boolean, ready:boolean, reason:string}}
 */
export function contentFrameState(topWin) {
  const out = { found: false, ready: false, reason: "" };
  if (!topWin) return out;
  let docs = [];
  try {
    docs = collectDocs(topWin, 2); // cards 是顶层的第一层; 再深是模块壳, 不是正文帧
  } catch (e) {
    return out;
  }
  // 关键: 拿 **iframe 元素的 src 属性** 认帧 —— 帧没加载完时它自己的 location 是 about:blank,
  // 用 location 认就把「空正文帧」整个漏掉了(这就是用户看到的那个症状)。
  let frameEl = null;
  for (const d of docs) {
    let frames = [];
    try {
      frames = Array.from(d.doc.querySelectorAll("iframe"));
    } catch (e) {
      continue;
    }
    for (const f of frames) {
      let srcAttr = "";
      try {
        srcAttr = (f.getAttribute && f.getAttribute("src")) || "";
      } catch (e) {}
      if (!CX_STUDY_SEL.old.cardsFrame.test(srcAttr)) continue;
      frameEl = f;
      break;
    }
    if (frameEl) break;
  }
  if (!frameEl) return out;
  out.found = true;
  let doc = null;
  try {
    doc = frameEl.contentWindow && frameEl.contentWindow.document;
  } catch (e) {
    doc = null;
  }
  if (!doc) {
    out.reason = "内容帧还是空白帧";
    return out;
  }
  let href = "";
  try {
    href = (doc.location && doc.location.href) || "";
  } catch (e) {}
  if (!href || href === "about:blank") {
    out.reason = "内容帧还是空白帧";
    return out;
  }
  let rs = "";
  try {
    rs = doc.readyState || "";
  } catch (e) {}
  if (rs !== "complete") {
    out.reason = `内容帧还在加载(${rs || "状态未知"})`;
    return out;
  }
  let jobs = 0;
  try {
    jobs = doc.querySelectorAll(CX_STUDY_SEL.old.jobContainer).length;
  } catch (e) {}
  if (!jobs) {
    out.reason = "内容帧里还没有任何任务点";
    return out;
  }
  out.ready = true;
  return out;
}

/** 这一帧里有多少个题目容器(没有就是还没加载出题) */
function countQuestions(doc) {
  try {
    return doc.querySelectorAll(CX_STUDY_SEL.work.question).length;
  } catch (e) {
    return 0;
  }
}
