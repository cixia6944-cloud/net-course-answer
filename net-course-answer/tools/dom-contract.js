/* 超星/网课页面「契约采集」探针(只读, 不改页面)。
 * 用法 A(推荐, 自动化): bash tools/collect.sh end <名字>   —— 由采集器 eval 本文件
 * 用法 B(手动): F12 Console 粘贴本文件内容, 会打印一份 JSON 契约
 * 采集内容: URL/标题 + 关键选择器计数 + 交互元素样本 + 按钮/状态文案 + iframe 树(递归 2 层)
 */
(() => {
  const clean = (s, n = 70) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

  // 关键选择器清单(按本项目已知契约 + 常见超星结构)
  const SELS = [
    ".TiMu", ".newTiMu", ".fontLabel", ".font-cxsecret", ".Zy_ulTop", ".Zy_TItle",
    ".before-after", ".before-after-checkbox", ".answerBg", ".answer_p", ".check_answer",
    "li[role=radio]", "li[role=checkbox]", "li[qid]", "input[id^=answer]", "textarea",
    ".questionLi", ".examPaper_subject",
    // 提交相关
    ".btnSubmit", "#submitBtn", ".btnBlueSubmit", ".btnSave", "#saveBtn", ".layui-layer", ".layui-layer-btn0",
    // 章节页/任务点(旧界面 studentstudy)
    ".posCatalog_select", ".posCatalog_name", ".posCatalog_level", ".jobUnfinishCount", ".catalog_points_yi",
    "li[id^=dct]", "[onclick*='changeDisplayContent']", "[onclick*='getTeacherAjax']",
    // 章节页(新泛雅3 列表: studentcourse + fanyav3)
    ".chapter_item", ".catalog_task", "[onclick*='toOld']", "[class*='catalog_']", "[class*='chapter_']",
    "[class*='fanya']", ".el-collapse", ".van-collapse", "[class*='nav']",
    // 媒体/任务
    "video", "audio", "iframe", "#panView", ".swiper-slide", ".ans-job-icon", ".ans-job-finish",
    // 弹题/弹层
    ".popup", ".maskDiv", ".TiMu", ".questionWrap", "[class*='danmu']", "[class*='popup']", "[class*='dialog']",
  ];

  const counts = {};
  const samples = {};
  for (const sel of SELS) {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch (e) {}
    if (!els.length) continue;
    counts[sel] = els.length;
    samples[sel] = els.slice(0, 4).map((e) => ({
      tag: e.tagName,
      id: e.id || null,
      cls: clean(e.className, 60) || null,
      text: clean(e.textContent, 50),
      onclick: clean(e.getAttribute && e.getAttribute("onclick"), 120) || null,
      visible: !!(e.offsetWidth || e.offsetHeight || (e.getClientRects && e.getClientRects().length)),
    }));
  }

  // 可点交互元素(按钮类) —— 用来找"提交/暂存/下一节/继续"等
  const clickable = [];
  try {
    for (const e of document.querySelectorAll("a, button, input[type=button], input[type=submit], [onclick]")) {
      const t = clean(e.tagName === "INPUT" ? e.value : e.textContent, 20);
      if (!t) continue;
      if (!/提交|交卷|暂存|保存|下一|继续|开始|播放|确定|确认|提交作业|重新|返回|答题|查看/.test(t)) continue;
      clickable.push({ tag: e.tagName, id: e.id || null, cls: clean(e.className, 40) || null, text: t, onclick: clean(e.getAttribute("onclick"), 120) || null });
    }
  } catch (e) {}

  // 页面级函数(超星自带, 提交/播放用)
  const fns = {};
  for (const k of ["btnBlueSubmit", "submitCheckTimes", "noSubmit", "getTeacherAjax", "changeDisplayContent", "toOld", "toNew", "playVideo", "videojs", "UE", "saveWork", "submitWork"]) {
    try {
      fns[k] = typeof window[k];
    } catch (e) {
      fns[k] = "err";
    }
  }

  // iframe 树(同源才进得去; 递归 2 层, 汇总子页契约摘要)
  const frames = [];
  const walk = (win, path, depth) => {
    if (depth > 2) return;
    let doc;
    try {
      doc = win.document;
    } catch (e) {
      return;
    }
    if (!doc) return;
    let ifr = [];
    try {
      ifr = Array.from(doc.querySelectorAll("iframe"));
    } catch (e) {}
    for (const f of ifr) {
      const src = clean(f.getAttribute("src"), 200);
      const rec = { path: path + ">iframe", src: src || "(空/JS注入)", cls: clean(f.className, 40) || null };
      let w = null;
      try {
        w = f.contentWindow;
        const d2 = w && w.document;
        if (d2) {
          rec.sub = {
            title: clean(d2.title, 60),
            counts: {},
            text: clean(d2.body && d2.body.innerText, 400),
          };
          for (const sel of SELS) {
            try {
              const n = d2.querySelectorAll(sel).length;
              if (n) rec.sub.counts[sel] = n;
            } catch (e) {}
          }
        }
      } catch (e) {
        rec.crossOrigin = true;
      }
      frames.push(rec);
      if (w) walk(w, rec.path, depth + 1);
    }
  };
  walk(window, "top", 0);

  const out = {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    counts,
    samples,
    clickable: clickable.slice(0, 25),
    pageFns: fns,
    iframes: frames,
    bodyTextHead: clean(document.body && document.body.innerText, 1500),
    hiddenInputs: (() => {
      try {
        return Array.from(document.querySelectorAll("input[type=hidden]")).slice(0, 20).map((i) => ({ id: i.id, name: i.name, value: clean(i.value, 60) }));
      } catch (e) {
        return [];
      }
    })(),
  };
  return JSON.stringify(out, null, 1);
})();
