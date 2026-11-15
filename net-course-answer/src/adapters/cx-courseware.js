// S4 课件任务点驱动器(PPT/PDF): 自动翻页 + 停留计时, 直到"到最后一页/超时"。
// 实测结构(2026-09-19 真机, 国际贸易学 1.1):
//   top:studentstudy
//    └ iframe /mooc-ans/knowledge/cards
//       └ iframe /ananas/modules/pdf/index.html        ← 模块壳(#panView)
//          └ iframe pan-yz.chaoxing.com/screen/v2/file_xxx   ← 幻灯片渲染器
//               [class*=page] × N (每页一个 img) + 底部 "1 2 3 ... N  100% - +"
// 完成条件: 超星对课件的要求通常是"翻到最后一页"(有的还要停留时长) —— 这里两者都做。
import { sleepMs } from "../vendor/gm.js";
import { CX_STUDY_SEL, collectDocs, findCoursewareDoc } from "../contract/cx-study-contract.js";

export const DEFAULT_COURSEWARE_OPTIONS = {
  pageDwellMs: 2500, // 每页停留(让心跳/计时算数)
  maxPages: 400, // 防御: 最多翻多少页
  timeoutMs: 20 * 60 * 1000, // 单个课件最长处理时长
  tickMs: 800,
  scrollStepMs: 450, // 连续滚动型文档每滚一屏的间隔
};

/**
 * 连续滚动型文档的滚动容器。
 *
 * 2026-11-10 真机(国际贸易学 1.3 案例 / 1.1 参考文献): 整份 PDF 不是分页器, 而是一个长页 ——
 * `#panView` 里 `.fileBox` 高 N 千 px、每页一张 `<img>`, 底部那排 `span.pageNum` 只是
 * **每页后面的页码标签**, 点它不翻页。站点自己的 `bindScroll()` 给 panView 的 window 挂了
 * onscroll: 滚到距底 100px 内就调 `finishJob()` 上报「已看完」→ 所以"滚到底"就是正规完成动作。
 * @returns {{el:Element,height:number,client:number,max:number,top:number,frac:number}|null}
 */
export function scrollHost(doc) {
  if (!doc) return null;
  const cands = [doc.scrollingElement, doc.documentElement, doc.body].filter(Boolean);
  let best = null;
  for (const el of cands) {
    const height = el.scrollHeight || 0;
    const client = el.clientHeight || 0;
    const max = Math.max(0, height - client);
    if (!best || max > best.max) best = { el, height, client, max };
  }
  if (!best) return null;
  best.top = best.el.scrollTop || 0;
  best.frac = best.max > 0 ? Math.min(1, best.top / best.max) : 1;
  return best;
}

/** 幻灯片页码按钮(实测: span.pageNum, 文本是纯数字, 点它直接跳页) */
export const PAGE_NUM_SEL = "span.pageNum, .pageNum, [class*='pageNum']";

/** 激活态判定(超星各版本用过 active/current/on/cur/selected) */
const ACTIVE_RE = /active|current|on|cur|selected/i;

/** 收集页面上所有"文本为纯数字"的页码按钮(readPageState 与 turnPage 共用一处实现) */
export function pageNumButtons(doc) {
  if (!doc || !doc.querySelectorAll) return [];
  try {
    return Array.from(doc.querySelectorAll(PAGE_NUM_SEL)).filter((e) => /^\d{1,4}$/.test(String(e.textContent || "").trim()));
  } catch (e) {
    return [];
  }
}

/** 当前激活的页码按钮下标(没有激活态返回 -1) */
export function activePageIndex(buttons) {
  return (buttons || []).findIndex((e) => ACTIVE_RE.test(String(e.className || "")));
}

/** 读当前页码/总页数(尽力而为: 优先 "n/m", 再看激活的页码按钮) */
export function readPageState(doc) {
  const out = { cur: null, total: null };
  if (!doc) return out;
  // ① 最权威: span.pageNum —— 实测 17 个页码按钮 = 17 页
  const pn = pageNumButtons(doc);
  if (pn.length) {
    const idx = activePageIndex(pn);
    out.total = pn.length;
    out.cur = idx >= 0 ? Number(String(pn[idx].textContent).trim()) : null;
    out.byPageNum = true;
    out.authoritative = true;
    return out;
  }
  // ② 文本 "cur/total"
  let txt = "";
  try {
    txt = (doc.body && doc.body.innerText) || "";
  } catch (e) {}
  const m = /(\d+)\s*\/\s*(\d+)/.exec(txt);
  if (m) {
    out.cur = Number(m[1]);
    out.total = Number(m[2]);
    return out;
  }
  // ③ 兜底: 页面上一串纯数字元素 —— 取最大数当总页数, 带激活态的当当前页
  try {
    const nums = Array.from(doc.querySelectorAll("a,span,div,li"))
      .filter((e) => /^\d{1,4}$/.test(String(e.textContent || "").trim()))
      .map((e) => ({ e, n: Number(String(e.textContent).trim()) }));
    if (nums.length) {
      out.total = Math.max(...nums.map((x) => x.n));
      const act = nums.find((x) => ACTIVE_RE.test(String(x.e.className || "")));
      out.cur = act ? act.n : null;
    }
  } catch (e) {}
  return out;
}

/** 找"下一页"控件(按钮/箭头/键盘) */
export function findNextPageControl(doc) {
  if (!doc) return null;
  const cands = [
    'a[class*="next"]',
    'div[class*="next"]',
    'span[class*="next"]',
    '[class*="arrow-right"]',
    '[class*="nextPage"]',
    '[title*="下一页"]',
    '[aria-label*="下一页"]',
    'button[class*="next"]',
  ];
  for (const sel of cands) {
    try {
      const el = doc.querySelector(sel);
      if (el) return { el, how: sel };
    } catch (e) {}
  }
  // 文字兜底
  try {
    const el = Array.from(doc.querySelectorAll("a,button,div,span")).find((e) => {
      const t = String(e.textContent || "").trim();
      return t === "下一页" || t === "下一张" || t === "▶" || t === ">";
    });
    if (el) return { el, how: "text" };
  } catch (e) {}
  return null;
}

/** 在课件文档里翻一页: 先后退到"翻页控件", 再退回"滚动到底", 最后试键盘 */
export async function turnPage(cwDoc, cwWin, log = () => {}) {
  // ① 实测最可靠: span.pageNum 集合 → 点"下一个"页码
  const pn = pageNumButtons(cwDoc);
  if (pn.length) {
    const idx = activePageIndex(pn);
    const nextIdx = idx >= 0 ? idx + 1 : 0;
    const target = pn[Math.min(nextIdx, pn.length - 1)];
    if (target) {
      try {
        target.click();
        return { ok: true, how: `pageNum:${String(target.textContent).trim()}` };
      } catch (e) {}
    }
  }
  const next = findNextPageControl(cwDoc);
  if (next) {
    try {
      next.el.click();
      return { ok: true, how: `click:${next.how}` };
    } catch (e) {}
  }
  // 滚动容器到底(有的课件是靠滚动查看)
  try {
    const scrollers = [cwDoc.scrollingElement, cwDoc.documentElement, cwDoc.body].filter(Boolean);
    let scrolled = false;
    for (const sc of scrollers) {
      if (sc.scrollHeight > sc.clientHeight + 20) {
        sc.scrollTop = sc.scrollHeight;
        scrolled = true;
      }
    }
    if (scrolled) return { ok: true, how: "scroll" };
  } catch (e) {}
  // 键盘(焦点在文档上时)
  try {
    const ev = (type, key, code) => cwWin.document.dispatchEvent(new cwWin.KeyboardEvent(type, { key, code, bubbles: true }));
    ev("keydown", "ArrowRight", "ArrowRight");
    ev("keyup", "ArrowRight", "ArrowRight");
    return { ok: true, how: "key:ArrowRight" };
  } catch (e) {}
  return { ok: false, how: "none" };
}

/**
 * 自动浏览一个课件任务点。
 * @param {Object} cfg { win(顶层window), log, options, onProgress }
 * @returns {Promise<{ok:boolean, reason:string, pages:number, visited:number}>}
 */
export async function playCourseware(cfg = {}) {
  const win = cfg.win || window;
  const log = cfg.log || (() => {});
  const o = Object.assign({}, DEFAULT_COURSEWARE_OPTIONS, cfg.options || {});
  // 「停止刷课」必须能停住翻页循环: 2026-11-09 真机, 点了停止还继续翻了 5 分钟(16/16 → 110/40).
  const shouldStop = cfg.shouldStop || (() => false);
  const t0 = Date.now();

  // 等课件渲染器就绪(五层嵌套, 给它点时间)
  let hit = null;
  const wait0 = Date.now();
  while (Date.now() - wait0 < 15000) {
    if (shouldStop()) return { ok: false, stopped: true, reason: "stopped", pages: 0, visited: 0 };
    hit = findCoursewareDoc(win);
    if (hit) break;
    await sleepMs(600);
  }
  if (!hit) {
    log("[课件] 没找到幻灯片渲染器(可能不是 PPT/PDF 任务点)", "warning");
    return { ok: false, reason: "no-courseware", pages: 0, visited: 0 };
  }
  log(`[课件] 渲染器在第 ${hit.depth} 层(${hit.path}), 共 ${hit.pages} 页`);

  // 连续滚动型文档: 长页 + 页码标签(不是翻页按钮)。先判断, 免得先打一串"pageNum/翻不动"误导人。
  const host = scrollHost(hit.doc);
  const scrollMode = !!(host && host.max > 200);

  const st0 = scrollMode ? { cur: null, total: null } : readPageState(hit.doc);
  const totalPages = st0.total || hit.pages; // pageNum 权威, 否则用 [class*=page] 计数
  if (st0.authoritative) log(`[课件] pageNum 权威页数 = ${totalPages}`);
  if (st0.cur != null && totalPages) log(`[课件] 当前 ${st0.cur}/${totalPages} 页`);

  let visited = 0;
  let last = null;
  let sameCount = 0;

  // 连续滚动型文档: 逐屏往下滚 —— 滚到底时站点自己的 bindScroll() 会调 finishJob() 上报完成,
  // 我们不碰任何完成接口(2026-11-10 真机: 1.2 案例 2 个任务点、1.3 案例, 滚到底即记完成)。
  if (scrollMode) {
    log(`[课件] 连续滚动型文档(整份 ${host.height}px / 视口 ${host.client}px): 逐屏下滚, 滚到底站点自己上报完成`);
    let same = 0;
    while (Date.now() - t0 < o.timeoutMs) {
      if (shouldStop()) {
        log("[课件] 已停止刷课, 收工", "warning");
        return { ok: false, stopped: true, reason: "stopped", pages: 0, visited };
      }
      const h = scrollHost(hit.doc);
      if (!h) break;
      if (h.frac >= 0.995) {
        await sleepMs(2500); // finishJob 是同步 Ajax, 给它落地时间
        log(`[课件] 已滚到底(${Math.round(h.top)}/${Math.round(h.max)}px), 站点已上报完成`, "success");
        return { ok: true, reason: "scroll-to-end", pages: 0, visited };
      }
      const prev = h.top;
      const step = Math.max(160, Math.floor(h.client * 1.1));
      h.el.scrollTop = Math.min(h.max, h.top + step);
      if (hit.doc.body && hit.doc.body !== h.el) hit.doc.body.scrollTop = Math.min(h.max, h.top + step);
      visited++;
      await sleepMs(o.scrollStepMs);
      const now = scrollHost(hit.doc);
      if (now && now.top <= prev + 1) {
        same++;
        if (same >= 3) {
          log(`[课件] 文档滚不动(停在 ${Math.round(now.top)}/${Math.round(now.max)}px), 记为未完成`, "warning");
          return { ok: false, reason: `文档滚不动(滚到 ${Math.round(now.frac * 100)}%)`, pages: 0, visited };
        }
      } else {
        same = 0;
      }
      if (visited % 20 === 0 && now) log(`[课件] 已滚到 ${Math.round(now.frac * 100)}%`);
    }
    log("[课件] 处理超时, 收工", "warning");
    return { ok: false, reason: "timeout", pages: 0, visited };
  }
  if (host && host.max <= 200) {
    // 没有滚动区: 站点在 bindScroll() 里对 scrollHeight==clientHeight 的文档直接 finishJob。
    // 我们只等它落地, 平台到底认不认由上层 verifyBranchDone 判。
    log("[课件] 文档整页直出(没有滚动区), 站点渲染完即上报; 等 3s 再让平台核对");
    await sleepMs(3000);
    return { ok: true, reason: "static-doc", pages: 0, visited: 0 };
  }

  if (st0.cur == null) log("[课件] 读不到当前页(分页器没有激活态), 只能按翻页控件尽力翻; 翻不动会如实报未完成", "warning");

  while (Date.now() - t0 < o.timeoutMs) {
    if (shouldStop()) {
      log("[课件] 已停止刷课, 收工", "warning");
      return { ok: false, stopped: true, reason: "stopped", pages: totalPages, visited };
    }
    const st = readPageState(hit.doc);
    const key = `${st.cur}|${st.total}`;
    if (key === last) sameCount++;
    else {
      sameCount = 0;
      last = key;
    }
    // 到底判据: 当前页 == 总页数, 或连续多次翻不动
    const total = st.total || totalPages;
    if (st.cur != null && total && st.cur >= total) {
      log(`[课件] 已到最后一页(${st.cur}/${total})`, "success");
      return { ok: true, reason: "last-page", pages: total, visited };
    }
    if (visited >= o.maxPages) {
      // 没翻到底就是没翻到底 —— 别再报 ok, 否则上层会记成「已完成」而平台上仍未完成
      // (2026-11-10 真机: 205 页的参考文献翻 5 页就报 ✔ 完成, 重新切块后图标还是「任务点未完成」)。
      log(`[课件] 翻页达上限 ${o.maxPages}, 没翻到底, 记为未完成`, "warning");
      return { ok: false, reason: `课件没翻到底(翻了 ${visited} 页)`, pages: total || visited, visited };
    }
    if (sameCount >= 6 && visited > 3) {
      log("[课件] 连续多次翻不动(可能最后一页/或需点击别处), 没翻到底, 记为未完成", "warning");
      return { ok: false, reason: `课件翻不动了(翻了 ${visited} 页)`, pages: total || visited, visited };
    }

    const r = await turnPage(hit.doc, hit.win, log);
    visited++;
    cfg.onProgress && cfg.onProgress({ visited, cur: st.cur, total: st.total });
    if (visited % 5 === 0) log(`[课件] 已翻 ${visited} 页(${st.cur || "?"}/${st.total || "?"})`);
    if (!r.ok) {
      log("[课件] 找不到翻页方式, 收工", "warning");
      return { ok: false, reason: "no-next-control", pages: total || visited, visited };
    }
    // 每页停留, 让页面计时/心跳算数
    await sleepMs(Math.max(o.tickMs, o.pageDwellMs));
  }
  log("[课件] 处理超时, 收工", "warning");
  return { ok: false, reason: "timeout", pages: 0, visited };
}
