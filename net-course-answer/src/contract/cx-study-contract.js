// 超星「章节学习页」DOM 契约表 —— 2026-09-11 由真机采集(网课答题助手\情报\)固化成代码。
// 位置: src/contract/ (不做任何页面操作, 只放选择器/结构解析) —— core/ 与 adapters/ 都可以依赖它, 不会形成倒挂。
// 原则: **所有选择器集中在这里**, 页面改版只改这一个文件 + 跑契约测试。
// 两套界面:
//   ① 新版泛雅3(fanyav3): 章节列表在 iframe `/mooc2-ans/mycourse/studentcourse`,
//      条目 `DIV.chapter_item[onclick=toOld(courseId,knowledgeId,clazzId,0)]`, 状态 `SPAN.catalog_task`
//      (文本: "已完成" | "N个待完成任务点") —— 点它才会跳到旧版章节页。
//   ② 旧版(studentstudy): 目录 `.posCatalog_name[onclick=getTeacherAjax(...)]`,
//      类型标签 `li[id^=dct]` + `changeDisplayContent(idx,type,knowledgeId,courseId,clazzId,'')`,
//      cards iframe `/mooc-ans/knowledge/cards`, 视频 iframe `/ananas/modules/video/`,
//      任务点权威状态 `.ans-job-icon[aria-label="任务点已完成|任务点未完成"]`(容器 `.ans-attach-ct`)。
// 采集依据: 一手侦察记录(未随仓库分发) §一/§二/§八

export const CX_STUDY_SEL = {
  // ---- 旧版 studentstudy ----
  old: {
    /** 目录项(任务点行) */
    item: ".posCatalog_name",
    /** 目录行的容器(parseTaskTree 用 closest 往上找时按这个顺序) */
    row: ".posCatalog_select",
    level: ".posCatalog_level",
    unfinishedCount: ".jobUnfinishCount",
    /** 类型/任务点标签(如 <li id="dct1">1视频</li>) */
    tab: 'li[id^="dct"], [onclick*="changeDisplayContent("]',
    cardsFrame: /mooc-ans\/knowledge\/cards/,
    videoFrame: /ananas\/modules\/video/,
    /** 任务点图标: aria-label = 任务点已完成 / 任务点未完成 */
    jobIcon: ".ans-job-icon",
    jobContainer: ".ans-attach-ct, .videoContainer",
    jobFinishedClass: "ans-job-finished",
    jobVideoIframe: 'iframe[src*="modules/video"]',
    /** 任务点容器里的任意模块 iframe(视频/课件/测验都算) —— 判"这是哪种任务点"用 */
    jobFrame: 'iframe[src*="ananas/modules/"]',
    finishedWord: "已完成",
    unfinishedWord: "未完成",
  },
  // ---- 新版泛雅3 课程页(fanyav3) ----
  neu: {
    // 2026-11-11 真机: 路径是 mooc2-ans(不是 mooc-ans); 且 fanyav3/studentCourse 是课程首页、
    //   已不再承载章节列表 —— 真正带 .chapter_item 的是 mooc2-ans/mycourse/studentcourse?fanyaVersion=4。
    //   正则只负责"候选", 选哪个由 findNewCourseListDoc 按内容决定。
    listFrame: /mooc2?-ans\/mycourse\/studentcourse|fanyav3\/studentCourse/,
    chapterItem: ".chapter_item",
    chapterState: ".catalog_task",
    /** "N个待完成任务点" / "已完成" */
    unfinishedRe: /(\d+)\s*个待完成任务点/,
    finishedWord: "已完成",
  },
  /** 作业/测验: 只留「题目容器」「已批阅判据」两条, 答题页细节统一走下面的 answer 组 */
  work: {
    question: ".TiMu, .questionLi, .examPaper_subject",
    /** 已批阅特征: 有「我的答案：」「分」等文本、且没有作答控件 */
    reviewedWord: "我的答案",
  },
  /** 课件(PPT/PDF, 五层: top>cards>pdf/index.html>screen/file) */
  courseware: {
    /** 幻灯片页 */
    page: '[class*="page"], .swiper-slide',
  },
  /**
   * 视频元素: 按顺序尝试, 命中后还要校验 tagName === VIDEO(防止 .vjs-tech 之类不是 video 的壳)。
   * 播放器是 video.js, 实际视频元素 id=#video_html5_api / class=.vjs-tech。
   */
  video: {
    element: ["#video_html5_api", ".vjs-tech", "video"],
  },
  /** 字体加密(题面字体反爬): 需要解密的元素类名 —— core/font-decrypt.js 与 adapters/cx.js 共用 */
  font: {
    secretClass: "font-cxsecret",
  },
  /**
   * 答题页(作业/测验/考试) —— 由 adapters/cx.js 使用。
   * 以前这些选择器散在 cx.js 里, 改版要改两处; 现在统一到这里。
   * 三类页面: zj=章节作业 doHomeWorkNew / zy=新版作业 dowork / ks=考试 exam-ans。
   */
  answer: {
    /** 题目容器: 按页面类型取不同顺序(先命中的优先) */
    question: {
      zj: ".TiMu, .questionLi",
      zy: ".questionLi, .TiMu",
      ks: ".questionLi, .TiMu",
    },
    /** zj: 题干 .fontLabel; 选项 li[class*=before-after] 内 .fl.after */
    zj: {
      title: ".fontLabel",
      optionItem: '[class*="before-after"]',
      optionText: ".fl.after",
      /** 已批阅/新版结构: ul.Zy_ulTop(.qtDetail) > li > a.fl(没有 .fl.after) */
      optionListFallback: "ul.Zy_ulTop, ul.qtDetail, ul",
      optionItemFallback: "li",
      optionTextFallback: "a, .fl",
    },
    /** zy/ks: 题干 h3(去掉 .colorShallow); 选项 .answerBg 内 .answer_p */
    zy: {
      title: "h3",
      titleStrip: ".colorShallow",
      optionItem: ".answerBg",
      optionText: ".answer_p",
    },
    /** 判断题: zj/zy 看选项 aria-label; ks 看选项里 span[data=true|false] */
    judge: {
      ariaTrue: "对选择",
      ariaFalse: "错选择",
      checked: ".check_answer, .check_answer_dx",
    },
    /** 填空/简答的输入控件 */
    fill: {
      field: "textarea, input[type=text], input:not([type])",
      textarea: "textarea",
    },
  },
  /**
   * 提交/暂存/二次确认 —— core/submit.js 用。
   * 以前这几组选择器写死在 submit.js 里, 现在按本文件开头那条原则("所有选择器集中在这里")挪过来。
   * 页面函数(btnBlueSubmit/submitCheckTimes/noSubmit)仍在 submit.js 里优先调用, 这里只是 DOM 兜底。
   */
  submit: {
    /** 提交按钮候选 */
    submitBtn: [
      "a.btnSubmit",
      "#submitBtn",
      "a.btnBlueSubmit",
      "a[onclick*='btnBlueSubmit']",
      "a[onclick*='submitWork']",
      "input[type=button][value*='提交']",
      "input[type=submit]",
    ],
    /** 暂存按钮候选 */
    draftBtn: [
      "a[onclick*='noSubmit']",
      "a.btnSave",
      "#saveBtn",
      "input[type=button][value*='暂存']",
      "input[type=button][value*='保存']",
    ],
    /** 二次确认层里的"确定" */
    confirmBtn: [
      ".layui-layer-btn0",
      ".layui-layer-btn .layui-layer-btn0",
      "#popup_ok",
      ".aui_state_highlight",
      ".Tj_button",
      "a[onclick*='submitCheckTimes']",
    ],
    /** 页面出现这些字 → 已有结果, 别再提交 */
    doneWords: ["已完成", "待批阅", "已提交", "已交卷", "已评分", "已批阅"],
    /** 确认层按钮文字(选择器没命中时的兜底) */
    confirmWords: ["确定", "确认", "继续提交", "坚持提交"],
    /** 扫文字时排除的字样(防止点到"暂存/取消") */
    excludeWords: ["暂存", "保存", "取消", "返回"],
  },
  /**
   * 抓取(本页课件原件 / 本页题目与答案) —— ui/harvest.js 用。
   * 只读页面、不点任务点、不翻页、不碰提交类动作。
   *
   * 已知两种页面形态(选择器按顺序取第一个命中的, 所以两种都能读):
   *   ① 做题页 .TiMu:           每题一个 .TiMu, 选项 ul.Zy_ulTop li, 答案 .myAnswerBx/.correctAnswerBx
   *   ② 作业详情页 .questionLi:  每题一个 .questionLi(外层还有 .mark_item),
   *                              选项 ul.mark_letter li, 答案 .stuAnswerContent/.rightAnswerContent,
   *                              分值 .totalScore("0分") —— 采集自 mooc-ans/mooc2/work/view
   * ⚠️ .TiMu 在②里是**整页容器**(#fanyaMarking, 全页只 1 个), 绝不能当每题容器用 ——
   *    否则会把整页当一道题、只读到第一个 .qtContent、答案靠全页 querySelector 乱捞(实测踩过)。
   */
  harvest: {
    /** 每道题的容器候选(按优先级, 第一个命中的选择器胜出) */
    question: [".questionLi", ".mark_item", ".TiMu"],
    /** 题干正文 */
    stem: [".qtContent", ".Zy_TItle"],
    /** 题型徽标 —— 内容可能是 "(单选题)" 或 "单选题"; 落在题干内部时要扣掉 */
    typeBadge: [".colorShallow", "span.newZy_TItle"],
    /** 选项列表(取第一个命中的选择器, 不混用不同形态的 li) */
    options: [".mark_letter li", ".Zy_ulTop li", "ul.qtDetail li"],
    /** 我的答案 */
    myAnswer: [".stuAnswerContent", ".myAnswerBx .myAnswer .answerCon", ".myAnswer"],
    /** 正确答案 */
    rightAnswer: [".rightAnswerContent", ".correctAnswerBx .correctAnswer .answerCon", ".correctAnswer"],
    /** 分值(可能带「分」字, 读取时去掉) */
    score: [".totalScore", ".scoreNum"],
    /** 对错标记(判据是类名存在, 元素里通常没有文字) */
    markDui: ".marking_dui",
    markCuo: ".marking_cuo",
    /** 遍历 iframe 的最大深度(超过就当没看见, 防病态嵌套) */
    maxFrameDepth: 7,
  },
};

/* ---------------- 旧版: 未完成数 ---------------- */

/** 从一行目录节点里读"待完成任务点数"(三种写法: .jobUnfinishCount / "N个待完成任务点N" / 裸 0) */
export function readUnfinished(row, sel = CX_STUDY_SEL.old) {
  if (!row) return 0;
  const cnt = row.querySelector ? row.querySelector(sel.unfinishedCount) : null;
  if (cnt) {
    const n = parseInt(String(cnt.textContent || "").replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(n)) return n;
  }
  const text = String(row.textContent || "");
  const m = /个待完成任务点\s*(\d+)/.exec(text);
  if (m) return parseInt(m[1], 10);
  return 0; // 没有待完成计数 = 视为已完成
}

/* ---------------- 旧版: 章节内"内容块"标签 ---------------- */

/**
 * 章节内的内容块标签(新版章节页一章可有多块: 1课程视频 / 2预习 / 3课件 / …)。
 * 每块是**独立的一次 cards 请求**(`num = idx - 1`), 各自可能有自己的任务点。
 * 只枚举当前块 → 做完视频就以为整章完事, 后面的预习/课件全被略过(2026-11-10 用户实测)。
 *
 * 结构(采集自 一手侦察记录(未随仓库分发)):
 *   <li id="dct1" class="active" onclick="changeDisplayContent(1,2,'1103250729','100000006','100000007','');">
 *     <div class="prev_white"><span class="num">1</span><span class="spanText">视频</span></div>
 *   </li>
 *
 * @returns {Array<{key,index,idx,type,label,active,el}>} idx 从 1 起(页面函数参数)
 */
export function parseChapterTabs(doc, sel = CX_STUDY_SEL.old) {
  if (!doc || !doc.querySelectorAll) return [];
  const out = [];
  Array.from(doc.querySelectorAll(sel.tab)).forEach((el, i) => {
    const onclick = (el.getAttribute && el.getAttribute("onclick")) || "";
    const m = /changeDisplayContent\(\s*(\d+)\s*,\s*(\d+)/.exec(onclick);
    const isDct = /^dct\d+$/.test(el.id || "");
    if (!m && !isDct) return; // 不是内容块(比如只有 changeDisplayContent 字样的事件委托容器)
    const textEl = el.querySelector && el.querySelector(".spanText");
    const raw = String((textEl && textEl.textContent) || el.textContent || "");
    const label = raw.trim().replace(/\s+/g, " ").replace(/^\d+\s*/, "").slice(0, 24);
    out.push({
      key: el.id || `tab-${i}`,
      index: i,
      // changeDisplayContent 的第一个参数(1 起); 少数老页面标签没有 onclick, 按 DOM 顺序兜底
      idx: m ? parseInt(m[1], 10) : i + 1,
      type: m ? parseInt(m[2], 10) : null,
      label,
      active: /(^|\s)(active|current|on)(\s|$)/.test(String(el.className || "")),
      el,
    });
  });
  return out;
}

/** 内容块 idx(1 起) → cards 请求里的 num(0 起); 实测 毛概2.6 第 4 块 = num=3 */
export function tabNum(tab) {
  const idx = tab && Number(tab.idx);
  return String(Math.max(0, (Number.isFinite(idx) ? idx : 1) - 1));
}

/* ---------------- 新版: 章节条目 ---------------- */

/** 判断这个 `DIV.chapter_item` 是不是可进入的章节(带 toOld) */
export function parseNewChapterItem(el, sel = CX_STUDY_SEL.neu) {
  if (!el) return null;
  const onclick = (el.getAttribute && el.getAttribute("onclick")) || "";
  const m = /toOld\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(\d+)?/.exec(onclick);
  if (!m) return null;
  const stateEl = el.querySelector ? el.querySelector(sel.chapterState) : null;
  const stateText = String((stateEl && stateEl.textContent) || "").trim();
  const um = sel.unfinishedRe.exec(stateText) || sel.unfinishedRe.exec(String(el.textContent || ""));
  const done = stateText.includes(sel.finishedWord) && !um;
  return {
    courseId: m[1],
    knowledgeId: m[2],
    clazzId: m[3],
    title: String(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
    unfinished: um ? parseInt(um[1], 10) : done ? 0 : 1, // 没写状态就当有 1 个(进去再看)
    done,
    stateText,
    el,
  };
}

/** 新版章节列表 → 统一 item 结构(与旧版 parseTaskTree 对齐) */
export function parseNewChapterList(listDoc, sel = CX_STUDY_SEL.neu) {
  if (!listDoc || !listDoc.querySelectorAll) return [];
  return Array.from(listDoc.querySelectorAll(sel.chapterItem))
    .map((el, i) => {
      const it = parseNewChapterItem(el, sel);
      return it ? Object.assign({ index: i }, it) : null;
    })
    .filter(Boolean);
}

/* ---------------- cards 页: 任务点(job) ---------------- */

/**
 * 一个 cards 页里可能有**多个视频任务点**(实测 3.9 = 3 个, 各自一个 video iframe)。
 * 权威状态是 `.ans-job-icon[aria-label]`, 不是外层目录树的计数。
 * @returns {Array<{key,label,done,index,el,frameEl,ariaLabel}>}
 */
export function parseJobs(cardsDoc, sel = CX_STUDY_SEL.old) {
  if (!cardsDoc || !cardsDoc.querySelectorAll) return [];
  const icons = Array.from(cardsDoc.querySelectorAll(sel.jobIcon));
  const out = [];
  icons.forEach((icon, i) => {
    // ⚠️ 实测 aria-label 可能是空/缺失 —— 不能用 String(...) 包一层再判 null(那永远不为 null)
    const ariaRaw = (icon.getAttribute && icon.getAttribute("aria-label")) || "";
    const container = (icon.closest && icon.closest(sel.jobContainer)) || icon.parentElement || icon;
    // ⚠️ 2026-11-10: 以前这里只找「视频 iframe」, 于是课件/测验任务点的 frameEl 恒为 null、
    //   kind 也只能退回图标 class(常常是空的) → 测验任务点被当成"未知类型"白等 18 秒。
    //   现在优先认任意 ananas 模块 iframe, kind 才有 pdf/work/doc 可言。
    const anyFrame = container.querySelectorAll
      ? container.querySelector(sel.jobFrame || sel.jobVideoIframe) || container.querySelector(sel.jobVideoIframe)
      : null;
    const frameEl = anyFrame;
    const cls = String(container.className || "");
    const iconCls = String(icon.className || "");
    // 完成态优先级: aria-label(权威) > 容器 class(ans-job-finished) > 图标 class 里的完成标记
    const done = ariaRaw
      ? ariaRaw.includes(sel.finishedWord) && !ariaRaw.includes(sel.unfinishedWord)
      : cls.includes(sel.jobFinishedClass) || /ans-job-icon-clear|icon-?completed|finished|done/i.test(iconCls);
    // 任务点类型: ① 优先容器内 iframe 的 src(实测最可靠: /ananas/modules/pdf|video|work/index.html)
    //            ② 图标 class 后缀(ans-job-video 等, 注意排除 icon 自身)
    //            ③ 都没有 → "任务点"
    const frameSrc = String((frameEl && frameEl.getAttribute && frameEl.getAttribute("src")) || "");
    let kind = null;
    const fm = /ananas\/modules\/([a-z0-9]+)\//i.exec(frameSrc);
    if (fm) kind = fm[1];
    if (!kind) {
      const tm = /ans-job-(?!icon)([a-z]+)/.exec(iconCls);
      if (tm) kind = tm[1];
    }
    const kindName = { video: "视频", audio: "音频", pdf: "课件", ppt: "课件", pptx: "课件", work: "测验", doc: "文档" }[kind] || kind || "任务点";
    out.push({
      key: `job-${i}`,
      index: i,
      label: `${i + 1}${kindName}`,
      kind,
      frameSrc: frameSrc.slice(0, 120),
      done,
      ariaLabel: ariaRaw || null,
      el: icon,
      frameEl,
    });
  });
  return out;
}

/** 判断题选项里的真/假标记(ks 页: span[data=true|false]); bool 为 "true"/"false" */
export function judgeSpanSel(bool) {
  return `span[data='${bool}']`;
}


/* ---------------- 递归 iframe 工具(P0: 作业 4 层 / 课件 5 层) ---------------- */

/**
 * 递归收集 win 下所有可访问文档(BFS, 深度可限)。
 * 实测超星嵌套: top > knowledge/cards > work|pdf/index.html > api/work|screen/file
 * @returns {Array<{doc:Document, win:Window, path:string, depth:number, src:string}>}
 *   src 是该文档所属 iframe 的地址(按 src 正则找 frame 时用, path 只有末两段不够精确)
 */
export function collectDocs(win, maxDepth = 6) {
  const out = [];
  const seen = new Set();
  const walk = (w, path, depth) => {
    if (!w || depth > maxDepth) return;
    let doc;
    try {
      doc = w.document;
    } catch (e) {
      return;
    }
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    let src = "";
    try {
      src = (doc.location && doc.location.href) || "";
    } catch (e) {}
    out.push({ doc, win: w, path, depth, src });
    let frames = [];
    try {
      frames = Array.from(doc.querySelectorAll("iframe"));
    } catch (e) {}
    for (const f of frames) {
      let w2 = null;
      try {
        w2 = f.contentWindow;
      } catch (e) {}
      const fsrc = f.getAttribute("src") || "?";
      const tag = fsrc.split("?")[0].split("/").filter(Boolean).slice(-2).join("/") || "frame";
      if (w2) walk(w2, `${path}>${tag}`, depth + 1);
    }
  };
  walk(win, "top", 0);
  return out;
}

/** 在所有(递归)文档里找**含题目容器**的文档(作业/测验用) */
export function findQuestionDoc(win, sel = CX_STUDY_SEL.work, opts = {}) {
  const docs = opts.docs || collectDocs(win, opts.maxDepth || 6);
  for (const d of docs) {
    let n = 0;
    try {
      n = d.doc.querySelectorAll(sel.question).length;
    } catch (e) {}
    if (n) return { doc: d.doc, win: d.win, path: d.path, depth: d.depth, count: n };
  }
  return null;
}

/**
 * 在所有(递归)文档里找**课件渲染器**(幻灯片页)所在的文档。
 * ⚠️ 实测坑: 顶层也有个无关的 `[class*=page]`(只有 1 个) → 会误判成"1 页的课件"。
 * 所以: ① 优先 src 匹配 `pan-yz.chaoxing.com/screen` 的文档; ② 否则要求页数 ≥ 2;
 *       ③ 仍无 → 取页数最多的那个。
 */
export function findCoursewareDoc(win, sel = CX_STUDY_SEL.courseware, opts = {}) {
  const docs = opts.docs || collectDocs(win, opts.maxDepth || 6);
  const scored = [];
  for (const d of docs) {
    let n = 0;
    try {
      n = d.doc.querySelectorAll(sel.page).length;
    } catch (e) {}
    if (!n) continue;
    let href = "";
    try {
      href = d.doc.location.href || "";
    } catch (e) {}
    const isScreen = /pan-yz\.chaoxing\.com\/screen|screen\/v2\/file/i.test(href) || /screen\/v2\/file/i.test(d.path);
    // 顶层永远不是课件渲染器: 实测顶层有无关的 [class*=page](章节轮播), 会把 16/16 当成课件页码.
    // 2026-11-09 真机: 顶层被误判成 1 页课件, 结果一直翻顶层轮播(16/16 → 110/40).
    if (!d.depth) continue;
    // 只认课件模块自己的文档(pdf/ppt/doc 模块壳, 或 screen 渲染器); 别的 iframe 有页码也不算.
    const looksCourseware = isScreen || /ananas\/modules\/(pdf|ppt|pptx|doc|flash)\//i.test(href);
    if (!looksCourseware) continue;
    scored.push({ ...d, pages: n, isScreen, hasNumBar: /100%\s*-\s*\+/.test((d.doc.body && d.doc.body.innerText) || "") });
  }
  if (!scored.length) return null;
  // ① 明确的幻灯片渲染器
  const best =
    scored.find((d) => d.isScreen) ||
    scored.find((d) => d.hasNumBar) ||
    scored.find((d) => d.pages >= 2) ||
    scored.sort((a, b) => b.pages - a.pages)[0];
  return { doc: best.doc, win: best.win, path: best.path, depth: best.depth, pages: best.pages, isScreen: !!best.isScreen };
}

/** 已批阅视图? (无作答控件 + 有"我的答案") */
export function isReviewedView(doc, sel = CX_STUDY_SEL.work) {
  if (!doc) return false;
  const txt = (doc.body && doc.body.innerText) || "";
  const hasAnswerMark = txt.includes(sel.reviewedWord);
  const hasControls =
    doc.querySelectorAll("li[role=radio],li[role=checkbox],input[type=radio],input[type=checkbox],textarea,input[type=text]").length > 0;
  return hasAnswerMark && !hasControls;
}
