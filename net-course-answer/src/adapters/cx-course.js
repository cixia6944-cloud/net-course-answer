// 超星章节页(study)刷课控制器: 把 core/course.js 的纯逻辑接到真实 DOM 上。
// 只在顶层窗口使用(iframe 里不挂面板, 也不跑编排)。
//
// 2026-09-11 按真机采集重构(网课答题助手\情报\采集发现-20260911.md §一/§二/§八):
//   · 一个 cards 页里可能有**多个视频任务点**(实测 3.9 = 3 个, 各带自己的 video iframe);
//     旧代码 `findFrameDoc(/modules\/video/)` 只取第一个 → 漏播(这就是"3.9 漏视频")。
//     现在: 以 `.ans-job-icon[aria-label="任务点已完成|任务点未完成"]` 枚举任务点,
//     每个任务点用它**自己容器内**的视频 iframe。
//   · 新版泛雅3 课程页(fanyav3)没有 `.posCatalog_name`, 章节列表在 studentcourse iframe 里,
//     条目 `DIV.chapter_item[onclick=toOld(courseId,knowledgeId,clazzId,0)]`;
//     在那边点「开始刷课」= 自动进入第一个未完成章节(设一次性标志, 旧页面加载后自动开跑)。
import { createCourseRunner, playVideoDoc } from "../core/course.js";
import { findVideoElement, DEFAULT_PLAY_OPTIONS } from "../core/player.js";
import { sleepMs, gm } from "../vendor/gm.js";
import { CX_STUDY_SEL, parseJobs, parseChapterTabs, tabNum, parseNewChapterList, findCoursewareDoc, collectDocs } from "../contract/cx-study-contract.js";
import { playCourseware } from "./cx-courseware.js";

/** 分支(任务点)标签选择器 —— 见契约表 */
const TAB_SEL = CX_STUDY_SEL.old.tab;
const AUTOSTART_KEY = "nca-course-autostart";

/**
 * 在 win 的 iframe 树里按 src 正则找一个 document(同源)。
 * 遍历交给契约层的 collectDocs —— 全工程只有那一处 iframe 递归实现。
 * (旧参数 depth/seen 保留仅为签名兼容, 不再使用)
 */
export function findFrameDoc(win, re) {
  if (!win) return null;
  for (const d of collectDocs(win, 6)) {
    if (d.src && re.test(d.src)) return d.doc;
  }
  return null;
}

/** 轮询等某个 iframe 出现(超星的 cards/video iframe 是 ajax 换 src) */
export async function waitForFrameDoc(win, re, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = findFrameDoc(win, re);
    if (d) return d;
    await sleepMs(500);
  }
  return null;
}

/** 从 outerHTML 粗判"这个分支已完成"(保守: 只有明确完成标记才认) */
export function hintTabDone(el) {
  const html = (el && el.outerHTML) || "";
  if (/incomplete|uncomplete|notComplete/i.test(html)) return false;
  return /icon_?Completed|icon-completed|isComplete|icon_?Finish|finished/i.test(html);
}

/**
 * 枚举当前章节要处理的任务点(分支)。
 * 优先用 cards 页的 `.ans-job-icon`(权威状态 + 每个任务点自带视频 iframe);
 * 拿不到就退回顶层的类型标签 `li#dct`(旧行为)。
 */
export function collectTaskTabs(win) {
  // ① cards 页的任务点列表(含多视频场景)
  const cardsDoc = findFrameDoc(win, CX_STUDY_SEL.old.cardsFrame);
  if (cardsDoc) {
    const jobs = parseJobs(cardsDoc);
    if (jobs.length) {
      // 每个任务点保留 parseJobs 给的媒体类型(video/pdf…) —— 旧代码覆盖成 kind:"job",
      // 结果 waitVideoDoc 把它当非视频, 视频任务点全走课件分支(2026-11-09 真机踩到).
      // 分支类型用 frameEl 区分, 不再占用 kind。
      return jobs;
    }
  }
  // ② 退回类型标签
  const docs = [];
  const push = (d) => {
    if (d && !docs.includes(d)) docs.push(d);
  };
  push(win.document);
  push(cardsDoc);
  push(findFrameDoc(win, CX_STUDY_SEL.old.videoFrame));
  for (const d of docs) {
    let els = [];
    try {
      els = Array.from(d.querySelectorAll(TAB_SEL));
    } catch (e) {}
    if (!els.length) continue;
    const seen = new Set();
    const out = [];
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      const onclick = el.getAttribute("onclick") || "";
      out.push({
        key: el.id || onclick.slice(0, 60),
        label: String(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24),
        done: hintTabDone(el) ? true : undefined,
        active: /(^|\s)(active|current|on)(\s|$)/.test(String(el.className || "")),
        kind: "tab",
        el,
      });
    }
    if (out.length) return out;
  }
  return [];
}

/** 点「下一节」(顶层按钮) */
export function clickNextSection(doc) {
  for (const el of Array.from(doc.querySelectorAll("a, span, button, div"))) {
    const t = String(el.textContent || "").trim();
    if (t === "下一节" || t === "下一章") {
      try {
        el.click();
        return true;
      } catch (e) {}
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 新版泛雅3 课程页: 检测 + 进入第一个未完成章节
 * 采集依据: 情报 §一(章节列表在 studentcourse iframe, 条目 .chapter_item + toOld)
 * ------------------------------------------------------------------ */

export function findNewCourseListDoc(win) {
  // 2026-11-11 真机: 同一页面上有两个候选 frame ——
  //   ① /fanyav3/studentCourse??…  = 课程首页(0 个 .chapter_item, 但正则能命中)
  //   ② /mooc2-ans/mycourse/studentcourse?…&fanyaVersion=4 = 真正的章节列表(96 个)
  // 以前取"第一个 src 命中的", 于是拿到首页 → 0 条 → 「没找到可进入的章节条目」。
  // 现在按内容挑: 有条目的优先, 都没有才退回第一个命中的。
  const re = CX_STUDY_SEL.neu.listFrame;
  const itemSel = CX_STUDY_SEL.neu.chapterItem;
  let firstMatch = null;
  for (const d of collectDocs(win, 6)) {
    if (!d.src || !re.test(d.src)) continue;
    const doc = d.doc;
    if (!doc || !doc.querySelectorAll) continue;
    let n = 0;
    try {
      n = doc.querySelectorAll(itemSel).length;
    } catch (e) {
      n = 0;
    }
    if (n) return doc;
    if (!firstMatch) firstMatch = doc;
  }
  return firstMatch;
}

/** 当前顶层页是不是"新版课程页"(没有旧目录项, 但有新版章节列表) */
export function isNewCoursePage(win) {
  const doc = win.document;
  const hasOldTree = !!(doc && doc.querySelectorAll && doc.querySelectorAll(CX_STUDY_SEL.old.item).length);
  if (hasOldTree) return false;
  return !!findNewCourseListDoc(win);
}

/** 进入第一个未完成章节(调 toOld) → 页面会跳到旧版 studentstudy */
export function enterFirstUnfinishedChapter(win) {
  const listDoc = findNewCourseListDoc(win);
  if (!listDoc) return null;
  const items = parseNewChapterList(listDoc);
  const pending = items.filter((i) => !i.done && i.unfinished > 0);
  const target = pending[0] || items[0];
  if (!target) return null;
  try {
    target.el.click(); // onclick=toOld(...) → 跳旧版
  } catch (e) {
    return null;
  }
  return target;
}

/** 记一个一次性标志: 跳到旧版页面后自动开跑 */
export function markAutostart(on = true) {
  try {
    if (gm.setValue) gm.setValue(AUTOSTART_KEY, on ? "1" : "");
    else localStorage.setItem(AUTOSTART_KEY, on ? "1" : "");
  } catch (e) {}
}

export function consumeAutostart() {
  try {
    let v = null;
    if (gm.getValue) v = gm.getValue(AUTOSTART_KEY, "");
    else v = localStorage.getItem(AUTOSTART_KEY);
    if (v) markAutostart(false);
    return !!v;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 控制器
 * ------------------------------------------------------------------ */

/**
 * @param {Object} cfg { win, log, onState, options }
 */
export function createCxCourseController(cfg = {}) {
  const win = cfg.win || window;
  const doc = win.document;
  const log = cfg.log || (() => {});
  let runner = null;
  let running = false;
  let stopRequested = false;
  // 本次刷课里已经交过卷的 work 任务点(避免平台图标没刷新时重复提交)
  const submittedJobs = new Set();
  let lastVideoEl = null;
  let lastItem = null;

  /** 当前顶层 URL 的 chapterId(用来判断"这一章是不是已经打开了") */
  function currentChapterId() {
    try {
      return (win.location.search.match(/[?&]chapterId=(\d+)/) || [])[1] || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 学习通切章太频繁会弹「为保障您的账号安全，请输入验证码」(#chapterVerificationCode)。
   * 弹着的时候 getTeacherAjax 不发请求, 页面只会留下 loading 图 —— 看上去就是卡死。
   * 2026-11-09 真机: 连续切 4 章触发了它, 刷课停在「切换到章节」不动。
   */
  function chapterCaptchaVisible() {
    try {
      const el = win.document.querySelector("#chapterVerificationCode");
      return !!(el && el.offsetParent !== null);
    } catch (e) {
      return false;
    }
  }

  /** 当前 cards 帧 URL 里的 num(= 正在显示第几块), 读不到就是 null */
  function cardsNum() {
    const d = findFrameDoc(win, CX_STUDY_SEL.old.cardsFrame);
    if (!d) return null;
    try {
      const m = /[?&]num=(\d+)/.exec(d.location.href || "");
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 切到章节里的某个内容块(1课程视频 / 2预习 / 3课件 …)。
   * 页面函数 changeDisplayContent 会换掉 cards 帧的 `num` —— 只有切过去, 那一块自己的
   * 任务点才会被渲染出来(2026-11-10 实测: 不切就永远只看得到当前块的任务点)。
   * @returns {Promise<boolean>} 是否已在该块上
   */
  async function switchTab(tab) {
    if (!tab || !tab.el) return false;
    const isActive = () => {
      try {
        return /(^|\s)(active|current|on)(\s|$)/.test(String(tab.el.className || ""));
      } catch (e) {
        return false;
      }
    };
    const want = tabNum(tab);
    const before = cardsNum();
    if (isActive() && (before === null || before === want)) return true;
    try {
      tab.el.click(); // 元素自带 onclick=changeDisplayContent(...)
    } catch (e) {
      return false;
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (stopRequested) return false;
      await sleepMs(300);
      const now = cardsNum();
      if (now !== null) {
        if (now === want) return true;
      } else if (isActive()) {
        return true; // cards 正在重建, 看不到 num 就以标签 active 为准(后面还会等任务点)
      }
    }
    return false;
  }

  /**
   * 当前块重新渲染后, 把分支里过期的元素句柄换成新 DOM 里的(块切换会重建 cards 内容)。
   *
   * ⚠️ 2026-11-10 真机: `changeDisplayContent` 是**先换 URL 里的 num, 再清空/重建 cards**:
   *   104ms 还显示上一块的 pdf 任务点 → 219ms num 已是 5 但 DOM 是空的 → 427ms 新的
   *   任务点图标才出现 → 980ms `<video>` 才挂上。切完立刻读会拿到空列表, 分支就一直拿着
   *   **枚举时那份已经脱离文档的 iframe**, 后面等视频必然超时(这就是 1.2「辅助视频(1)」
   *   明明是视频却被判成"没有可自动处理的媒体"的原因)。所以这里必须轮询到"这块自己的、
   *   还在文档里的"任务点出现为止。
   * @returns {Promise<boolean>} 是否定位到
   */
  async function refreshBranchElement(br) {
    if (!br) return false;
    const want = br.tab ? tabNum(br.tab) : null;
    let sawLive = false;
    for (let i = 0; i < 20; i++) {
      if (stopRequested) return false;
      const cards = findFrameDoc(win, CX_STUDY_SEL.old.cardsFrame);
      if (cards) {
        let nm = null;
        try {
          nm = (/[?&]num=(\d+)/.exec(cards.location.href || "") || [])[1] || null;
        } catch (e) {}
        const onBlock = !want || !nm || nm === want;
        if (onBlock) {
          const jobs = parseJobs(cards);
          const j = jobs[br.jobIndex] || jobs.find((x) => x.key === br.jobKey);
          const live = j && j.el && (!cards.contains || cards.contains(j.el));
          if (live) {
            br.el = j.el;
            br.frameEl = j.frameEl;
            if (typeof j.done === "boolean") br.done = j.done;
            // ⚠️ 类型(j.kind)由容器里的 iframe 决定, 而 iframe 比图标晚一拍才创建。
            //   2026-11-10 真机: 只认"图标出现"就返回, kind 还是 null → 测验任务点被当成
            //   "可能视频", 白等 6s+12s 才报「非课件/文档」。这里等类型认出来再收工。
            if (j.kind) {
              br.kind = j.kind;
              return true;
            }
            sawLive = true;
          }
        }
      }
      await sleepMs(300);
    }
    return sawLive; // 类型一直没认出来(极少): 元素至少是活的, 交给上层按未知类型处理
  }

  /**
   * 让平台自己说「这个任务点完成了没有」。
   *
   * 2026-11-10 真机纠错: 连续滚动型 PDF 翻完后, 当页图标不会立刻变「任务点已完成」,
   * 但下一次重新拉取这块时(1.1 参考文献)平台已经记完成 —— 也就是说"翻不动"只说明我们
   * 没翻到底, 不等于没记完成。这里重新点一下同一块(changeDisplayContent 会重发 cards 请求),
   * 以服务端回的状态为准, 免得把真完成的分支记成未完成。
   */
  async function recheckJobDone(br) {
    if (!br || !br.tab) return false;
    try {
      br.tab.el && br.tab.el.click && br.tab.el.click();
    } catch (e) {}
    await sleepMs(900);
    for (let i = 0; i < 8; i++) {
      if (stopRequested) return false;
      const cards = findFrameDoc(win, CX_STUDY_SEL.old.cardsFrame);
      if (cards) {
        const jobs = parseJobs(cards);
        const j = jobs[br.jobIndex] || jobs.find((x) => x.key === br.jobKey);
        if (j && j.el && (!cards.contains || cards.contains(j.el))) {
          br.done = !!j.done;
          if (br.done) return true;
        }
      }
      await sleepMs(500);
    }
    return false;
  }
  /**
   * 播完之后让平台确认「这个任务点真的记上了没有」。
   * 2026-11-10 真机: 90% 停手时平台不认账(图标仍「任务点未完成」), 所以不可以只信本地进度条。
   * @returns {Promise<boolean|undefined>} true=平台已记完成 / false=确实没记上 / undefined=判断不了
   */
  async function verifyBranchDone(br) {
    if (!br) return undefined;
    await sleepMs(1500);
    const cards = findFrameDoc(win, CX_STUDY_SEL.old.cardsFrame);
    if (!cards) return undefined;
    const jobs = parseJobs(cards);
    const j = jobs[br.jobIndex] || jobs.find((x) => x.key === br.jobKey);
    if (j && j.done) return true;
    if (!br.tab) return undefined; // 单块章节没有"重拉这块"的手段, 不乱判成失败
    return await recheckJobDone(br);
  }

  /** 任务点的跨章节唯一身份(章节 id + 内容块 id + 序号)。dct7|job-0 这种会在每章重复, 不能单独当键 */
  function jobUidOf(br) {
    if (!br) return "";
    if (br.jobUid) return br.jobUid;
    const tabKey = (br.tab && br.tab.key) || "";
    const idx = br.jobIndex != null ? br.jobIndex : br.jobKey;
    return tabKey && idx != null ? `${tabKey}|${idx}` : "";
  }

  /** 这个任务点是不是"测验/作业"(work 模块)? kind 可能还没认出来, 所以再看一眼 iframe 地址 */
  function jobLooksLikeWork(br) {
    if (!br) return false;
    if (String(br.kind || "").toLowerCase() === "work") return true;
    try {
      const src = String((br.frameEl && br.frameEl.getAttribute && br.frameEl.getAttribute("src")) || "");
      return /\/ananas\/modules\/work\//.test(src);
    } catch (e) {
      return false;
    }
  }

  async function enterItem(item) {
    lastItem = item;
    // ⚠️ 关键: 只在"当前章节 ≠ 目标章节"时才点。
    //   点目录项也会触发 getTeacherAjax → 再点一次会把 cards iframe 卸载掉(实测卡死)。
    const same = currentChapterId() && String(currentChapterId()) === String(item.knowledgeId);
    if (!same) {
      let ok = false;
      try {
        if (item.el && typeof item.el.click === "function") {
          item.el.click();
          ok = true;
        }
      } catch (e) {}
      // 点不到元素时, 才退回直接调页面函数(二选一, 绝不都调)
      if (!ok && typeof win.getTeacherAjax === "function") {
        try {
          win.getTeacherAjax(item.courseId, item.clazzId, item.knowledgeId);
        } catch (e) {}
      }
      log(`  ↳ 切换到章节 ${item.title}`);
      await waitForFrameDoc(win, CX_STUDY_SEL.old.cardsFrame, 10000);
      // 验证码弹着的时候 cards 永远等不到; 直接收工并把原因说清楚, 别让用户看着它"卡住"
      if (chapterCaptchaVisible()) {
        log("学习通要求输入验证码(切章太频繁会触发), 本次刷课已停止: 请在页面上完成验证后重新开始", "warning");
        if (runner && runner.stop) runner.stop();
      }
    }
    // 等 cards 帧就绪(无论是否切换, 都要有它才能枚举任务点)
    const cards = await waitForFrameDoc(win, CX_STUDY_SEL.old.cardsFrame, 8000);
    if (!cards) {
      // 2026-11-10 真机: 后台标签里切章, 页面把 #iframe 卸掉后没再建回来, 整个页面就停在
      // 没有 cards 的状态; 旧逻辑只打一行 warning 然后当"这章没有任务点"跳过, 结果静默漏章。
      log("  ↳ 没等到 cards 帧(页面可能卡在加载中), 本次刷课停止: 刷新页面后可重新开始", "warning");
      if (runner && runner.stop) runner.stop();
      return false;
    }
    return true;
  }

  /** 切到某个分支/任务点; 并等视频元素真的换掉(避免拿到上一个视频) */
  async function activateTab(br) {
    if (!br) return;
    if (br.tab) {
      // 多块章节: 先切到这块内容(会重建 cards), 再把分支的元素句柄换成新 DOM 的
      const ok = await switchTab(br.tab);
      if (!ok) log(`  ↳ 切不到「${br.tab.label || br.tab.key}」这块内容, 按当前块继续`, "warning");
      const located = await refreshBranchElement(br);
      if (!located) {
        br.locateFailed = true;
        log(`  ↳ 「${br.tab.label || br.tab.key}」这块没渲染出自己的任务点(可能内容为空/加载失败), 先跳过`, "warning");
      }
      try {
        br.el && br.el.scrollIntoView && br.el.scrollIntoView({ block: "center" });
      } catch (e) {}
      const k = String(br.kind || "").toLowerCase();
      if (located && br.frameEl && (k === "video" || k === "audio" || k === "")) {
        await waitForFrameVideo(br.frameEl, 6000);
      }
      return;
    }
    if (br.frameEl) {
      // 任务点(cards 页里的一个): 滚到可见; 只有视频类才等 <video>
      try {
        br.el && br.el.scrollIntoView && br.el.scrollIntoView({ block: "center" });
      } catch (e) {}
      if (br.frameEl) {
        const k = String(br.kind || "").toLowerCase();
        if (k === "video" || k === "audio" || k === "") {
          await waitForFrameVideo(br.frameEl, 6000);
        }
      }
      return;
    }
    if (!br.el) return;
    // 已经是当前显示的分支 → 不要重复点(点了会重载 iframe, 白等)
    if (br.active) {
      const vdocNow = findFrameDoc(win, CX_STUDY_SEL.old.videoFrame);
      const vNow = vdocNow ? findVideoElement(vdocNow) : null;
      if (vNow) {
        lastVideoEl = vNow;
        return;
      }
    }
    const before = lastVideoEl;
    try {
      br.el.click();
    } catch (e) {}
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      await sleepMs(500);
      const vdoc = findFrameDoc(win, CX_STUDY_SEL.old.videoFrame);
      const v = vdoc ? findVideoElement(vdoc) : null;
      if (!v) continue;
      if (v !== before) {
        lastVideoEl = v;
        return;
      }
    }
    log("界面没换新视频元素, 继续按当前视频处理", "warning");
  }

  /** 等某个 iframe 元素里出现 <video> */
  async function waitForFrameVideo(frameEl, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let v = null;
      try {
        const d = frameEl.contentDocument;
        v = d ? findVideoElement(d) : null;
      } catch (e) {}
      if (v) {
        lastVideoEl = v;
        return v;
      }
      await sleepMs(400);
    }
    return null;
  }

  /**
   * 等视频文档:
   *   · 传了分支且该分支有**自己的**视频 iframe(多任务点章节) → 精确用它;
   *   · 否则退回"第一个视频 iframe"(旧行为)。
   */
  const VIDEO_KINDS = new Set(["video", "audio"]);

  async function waitVideoDoc(item, timeoutMs, br) {
    // 已知不是视频类任务点(实测 kind 来自容器 iframe src: pdf/ppt/work/doc)→ 直接返回 null,
    // 让编排走 handleNonVideo(课件翻页), 避免白等 8 秒超时。
    if (br && br.kind && !VIDEO_KINDS.has(String(br.kind).toLowerCase())) {
      return null;
    }
    if (br && br.frameEl) {
      const v = await waitForFrameVideo(br.frameEl, timeoutMs);
      if (v) {
        try {
          return br.frameEl.contentDocument;
        } catch (e) {
          return null;
        }
      }
      // 标的是视频却没等到 <video>: 别让上层把它记成"非课件/文档"(会看不出到底是哪种情况)
      if (VIDEO_KINDS.has(String(br.kind || "").toLowerCase())) {
        log("  ↳ 这块标的是视频任务点, 但没等到 <video> 元素(可能要先点一下播放区, 或那块内容是空壳)", "warning");
      }
      return null;
    }
    // 多块章节的分支: 自己的媒体 iframe 还没挂上就是没有媒体, 绝不能退回"第一个视频 iframe"
    // (那会拿到别的任务点的视频, 白播一遍 —— 2026-11-10 真机 1.2 辅助视频 就踩在这里)
    if (br && br.jobKey) return null;
    const cards = await waitForFrameDoc(win, CX_STUDY_SEL.old.cardsFrame, timeoutMs);
    if (!cards) return null;
    const vdoc = await waitForFrameDoc(win, CX_STUDY_SEL.old.videoFrame, timeoutMs);
    if (!vdoc) return null;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const v = findVideoElement(vdoc);
      if (v) {
        lastVideoEl = v;
        return vdoc;
      }
      await sleepMs(500);
    }
    return null;
  }

  /**
   * 枚举「当前章节」的任务点。
   * 2026-11-09 真机(fanyaVersion=4): cards 帧在, 但内容还没渲染时 parseJobs 返回 0;
   * 旧代码这时退回顶层 `li[id^="dct"]` —— 那是 10 个章节标签, 不是任务点, 于是 42/11 这种
   * 假任务点 + 把「1课程视频」当课件翻。现在 cards 帧在就等它出自己的任务点(最多 12s),
   * 等不到就返回空, 绝不用顶层目录项顶替。
   */
  async function listTaskTabsReady() {
    const cards = await waitForFrameDoc(win, CX_STUDY_SEL.old.cardsFrame, 8000);
    if (!cards) return collectTaskTabs(win); // 没有 cards 帧才是旧页面, 退回标签枚举
    const kid = String((lastItem && lastItem.knowledgeId) || "");
    const tabs = parseChapterTabs(win.document);
    // 只有一块(或读不到标签): 就是老行为, 只读当前块
    if (tabs.length <= 1) {
      const jobs = await readCurrentBlockJobs(kid, tabs[0] || null);
      if (!jobs.length) log("  ↳ cards 帧里没等到任务点(不退回顶层章节标签)", "warning");
      return withTab(jobs, tabs[0] || null, kid);
    }
    // 多块章节(1课程视频 / 2预习 / 3课件 …): 每块是独立的 cards 请求, 任务点分散在各块里。
    // 只枚举当前块 → 视频做完就以为整章完事, 后面的预习/课件被整章略过(2026-11-10 实测)。
    const out = [];
    let switched = 0;
    for (const tab of tabs) {
      if (stopRequested) break;
      const label = tab.label || `第${tab.idx}块`;
      if (!(await switchTab(tab))) {
        log(`  ↳ 切不到「${label}」这块内容, 跳过`, "warning");
        continue;
      }
      switched++;
      const jobs = await readCurrentBlockJobs(kid, tab);
      if (!jobs.length) {
        log(`  ↳ 内容块「${label}」没有任务点`);
        continue;
      }
      log(`  ↳ 内容块「${label}」有 ${jobs.length} 个任务点`);
      out.push(...withTab(jobs, tab, kid));
    }
    // 一块都没切成功(页面结构跟预期不同, 比如 num 不是 idx-1): 退回只处理当前块,
    // 至少不会比修之前更差 —— 也不要把整章判成"没有任务点"。
    if (!switched && !out.length) {
      log("  ↳ 内容块切换一直没生效, 退回只处理当前块(与修前一致)", "warning");
      const jobs = await readCurrentBlockJobs(kid, null);
      return withTab(jobs, null);
    }
    if (!out.length) log("  ↳ 本章所有内容块都没读到任务点");
    return out;
  }

  /** 给当前块的任务点挂上"属于哪一块"的信息(切块后元素会失效, 靠 tab + 序号重新定位) */
  function withTab(jobs, tab, kid) {
    if (!tab) return jobs;
    return jobs.map((j) =>
      Object.assign({}, j, {
        key: `${tab.key}|${j.key}`,
        jobKey: j.key,
        // 跨章节唯一的任务点身份: dct 的 id 每章都一样, 必须带上 knowledgeid 才不会串
        jobUid: `${kid || ""}|${tab.key}|${j.index}`,
        jobIndex: j.index,
        tab,
        label: tab.label ? (jobs.length > 1 ? `${tab.label}(${j.index + 1})` : tab.label) : j.label,
      })
    );
  }

  /**
   * 读"当前显示的这一块"里的任务点。
   * 换块会让 cards 帧重建 —— 要求 num 对上目标块、knowledgeid 对得上本章;
   * 这一块本来就没有任务点是正常形态(纯图文块), 页面渲染完两轮仍没有就返回空。
   *
   * ⚠️ 完成态要等它"落定": 2026-11-10 真机实测, 切块后 374ms 任务点图标就出现了, 但
   * `aria-label` 还是「任务点未完成」, 到 706ms 才变成「任务点已完成」(容器加
   * `ans-job-finished`)。立刻读会把已完成的任务点当成未完成 → 白播一遍整段。
   * 所以要求连续两次读到的完成态一致才认。
   */
  async function readCurrentBlockJobs(kid, tab) {
    const want = tab ? tabNum(tab) : null;
    let quiet = 0;
    let prevSig = null;
    for (let i = 0; i < 24; i++) {
      if (stopRequested) return [];
      const cards = findFrameDoc(win, CX_STUDY_SEL.old.cardsFrame);
      let href = "";
      try {
        href = cards ? cards.location.href || "" : "";
      } catch (e) {}
      const nm = /[?&]num=(\d+)/.exec(href);
      const km = /knowledgeid=(\d+)/i.exec(href);
      const sameChapter = !kid || !km || km[1] === kid;
      const rightBlock = !want || !nm || nm[1] === want;
      if (cards && sameChapter && rightBlock) {
        const jobs = parseJobs(cards);
        if (jobs.length) {
          const sig = jobs.map((j) => `${j.key}:${j.done ? 1 : 0}`).join("|");
          if (sig === prevSig) return jobs; // 两轮一致 = 完成态已落定
          prevSig = sig;
        } else {
          prevSig = null;
          let ready = false;
          let len = 0;
          try {
            ready = cards.readyState === "complete";
            len = (cards.body && cards.body.innerHTML || "").length;
          } catch (e) {}
          if (ready && len > 200) {
            quiet++;
            if (quiet >= 2) return [];
          }
        }
      }
      await sleepMs(500);
    }
    if (tab) log(`  ↳ 内容块「${tab.label || tab.key}」12s 内没等到 cards 换成 num=${want}, 记为无任务点`, "warning");
    return [];
  }

  /**
   * 后台标签会骗人(2026-11-10 真机): 隐藏的标签页里浏览器把计时器节流到 1 次/分钟、
   * 还会暂停"只有视频的后台媒体" —— 表现就是日志停住、视频时钟不走, 看上去像卡死。
   * 这里在可见性变化时明确说一句, 别让用户猜。
   */
  function watchVisibility() {
    try {
      if (!doc || !doc.addEventListener) return;
      const warn = () =>
        log("⚠ 这个标签页在后台: 浏览器会把计时器节流(1 次/分钟)并暂停后台视频, 刷课会变慢或停住; 请把它留在前台可见", "warning");
      if (doc.hidden) warn();
      doc.addEventListener("visibilitychange", () => {
        if (doc.hidden) warn();
        else log("标签页回到前台, 继续", "info");
      });
    } catch (e) {}
  }

  function buildRunner() {
    watchVisibility();
    return createCourseRunner({
      doc,
      log: (m, t) => log(m, t),
      onState: cfg.onState,
      options: cfg.options,
      enterItem,
      waitVideoDoc,
      listTaskTabs: () => listTaskTabsReady(),
      activateTab,
      verifyBranchDone,
      // S4: 非视频分支 → 试课件(PPT/PDF)自动翻页
      handleNonVideo: async (item, br, ctx) => {
        const shouldStop = (ctx && ctx.shouldStop) || (() => false);
        // 切块后连任务点都没定位到: 这块的内容没出来, 别白等 12s 再报"非课件/文档"(会误导)
        if (br && br.locateFailed) return { ok: false, reason: "这块内容没渲染出来(切块后 8s 没读到任务点)" };
        // 测验类任务点(work): 完成它必须交卷 → 交给答题链; 交不交看面板「答完自动提交」
        if (jobLooksLikeWork(br)) {
          if (!cfg.solveWork) {
            return { ok: false, reason: "章节测验/作业(没接答题链, 要你自己做完并提交)" };
          }
          // 同一次刷课里同一个任务点只交一次卷: 交完平台可能还没来得及把图标改过来,
          // 下一轮重新枚举如果又"未完成", 不能拿第二次机会再交一遍(有些测验允许多次尝试)。
          if (br && jobUidOf(br) && submittedJobs.has(jobUidOf(br))) {
            return { ok: false, reason: "本次已交过卷, 不重复提交(等平台刷新任务点)" };
          }
          log("  ↳ 识别为章节测验/作业(work 模块), 交给答题链处理");
          let wr;
          try {
            wr = await cfg.solveWork(br.frameEl, { shouldStop });
          } catch (e) {
            wr = { ok: false, reason: `答题异常: ${(e && e.message) || e}` };
          }
          if (!wr || (!wr.ok && !wr.submitted)) return { ok: false, reason: (wr && wr.reason) || "测验处理失败" };
          if (wr.submitted && br && jobUidOf(br)) submittedJobs.add(jobUidOf(br));
          // 交卷后页面常常整页跳走, 页面上看不到结果 —— 以任务点图标为准
          const confirmed = await verifyBranchDone(br);
          if (confirmed === false) {
            return { ok: false, reason: "测验已交卷, 平台仍显示「任务点未完成」" };
          }
          if (wr.submitted && confirmed !== true) {
            return { ok: false, reason: wr.reason || "已交卷, 但没法确认平台记上了" };
          }
          return { ok: true, note: wr.note || (wr.submitted ? "测验已交卷, 平台已记完成" : "测验已作答并提交") };
        }
        // 刚切到这一块时 pdf/doc 模块还没挂起来 —— 等它出现再下结论, 否则刚发现的块会被当成
        // "没有可处理的媒体"整块跳过(这正是预习/课件被略过的第二种表现)。
        let hit = null;
        const t0 = Date.now();
        while (!shouldStop() && Date.now() - t0 < 12000) {
          hit = findCoursewareDoc(win);
          if (hit) break;
          await sleepMs(600);
        }
        if (!hit) return { ok: false, reason: "非课件/文档" };
        log(`  ↳ 识别为课件任务点(第 ${hit.depth} 层, ${hit.pages} 页), 开始自动翻页`);
        const r = await playCourseware({
          win,
          log: (m, t) => log(m, t),
          shouldStop: (ctx && ctx.shouldStop) || (() => false),
          onProgress: (p) => cfg.onState && cfg.onState({ phase: "courseware", item, progress: p }),
        });
        if (r && r.ok) {
          // 课件也一样要平台认账: 「滚到底/翻到末页」只是我们的动作, 真完成以图标为准
          // (2026-11-10 真机: 连续滚动型 PDF 滚到底 → 站点 bindScroll 调 finishJob, 图标变已完成)
          let confirmed;
          if (cfg.verifyBranchDone) {
            try {
              confirmed = await verifyBranchDone(br);
            } catch (e) {
              confirmed = undefined;
            }
          }
          if (confirmed === false) {
            return {
              ok: false,
              reason: (r.reason === "scroll-to-end" ? "滚到底了" : "翻到末页了") + ", 平台仍显示「任务点未完成」",
            };
          }
          const note =
            r.reason === "scroll-to-end"
              ? r.visited
                ? `滚到底(${r.visited} 屏)`
                : "已在底部"
              : r.reason === "static-doc"
                ? "整页直出, 平台已记完成"
                : r.reason === "last-page"
                  ? `翻到末页(${r.pages || r.visited} 页)`
                  : `翻了 ${r.visited} 页`;
          return { ok: true, note };
        }
        // 没翻到底 ≠ 平台没记完成(真机 1.1 参考文献: 当场图标不动, 重新拉这块已是「任务点已完成」)
        if (await recheckJobDone(br)) {
          log("  ↳ 重新拉取这块后, 平台已显示「任务点已完成」");
          return { ok: true, note: "翻页后平台已记完成" };
        }
        return { ok: false, reason: (r && r.reason) || "课件处理失败" };
      },
      playVideo: (vdoc, item, hooks) =>
        playVideoDoc(vdoc, {
          onDriver: hooks && hooks.onDriver,
          threshold: (cfg.options && cfg.options.threshold) || DEFAULT_PLAY_OPTIONS.threshold,
          rate: (cfg.options && cfg.options.rate) || 1.5,
          mute: true,
          log: (m) => log(m),
        }),
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopRequested = false;
      runner = buildRunner();
      runner.run().finally(() => {
        running = false;
        cfg.onState && cfg.onState({ phase: "idle" });
      });
    },
    stop() {
      stopRequested = true; // 切块/读任务点的循环也看这个令牌, 不再多切一轮
      if (runner) runner.stop();
      running = false;
    },
    isRunning: () => running,
    stats: () => (runner ? runner.stats() : null),
  };
}

/**
 * 在新版课程页点「开始刷课」: 进入第一个未完成章节 + 设一次性自动开跑标志。
 * @returns {{ok:boolean, reason?:string, chapter?:Object}}
 */
export function startFromNewCoursePage(win, log = () => {}) {
  if (!isNewCoursePage(win)) return { ok: false, reason: "not-new-course-page" };
  const target = enterFirstUnfinishedChapter(win);
  if (!target) {
    // 2026-11-11 真机: 只说「没找到」看不出是"没找到列表 frame"还是"frame 里没条目",
    //   所以把探测结果一起打出来, 下次再变结构能一眼定位。
    const doc = findNewCourseListDoc(win);
    let raw = -1;
    let parsed = -1;
    try {
      raw = doc ? doc.querySelectorAll(CX_STUDY_SEL.neu.chapterItem).length : -1;
      parsed = doc ? parseNewChapterList(doc).length : -1;
    } catch (e) {}
    log(`新版课程页: 没找到可进入的章节条目(.chapter_item) [列表frame=${doc ? "有" : "无"} 条目=${raw} 可解析=${parsed}]`, "warning");
    return { ok: false, reason: "no-chapter-item" };
  }
  markAutostart(true);
  log(`新版课程页: 即将进入「${target.title}」, 进去了会自动开刷…`, "primary");
  return { ok: true, chapter: target };
}
