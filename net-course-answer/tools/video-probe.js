/* ===== 网课「刷课」侦查探针 (tools/video-probe.js) =====
 * 用途: 采集超星「视频/文档任务点」页的真实结构 + 真实心跳上报请求, 供刷课模块定位选择器/核对接口。
 * 用法: 浏览器(已登录)打开【章节页 studentstudy 并点进一个视频任务点】-> F12 -> Console -> 粘贴本脚本 -> 回车
 *      Edge 中文界面首次会拦粘贴: 在 Console 里【手打】"允许粘贴" 回车, 再粘本脚本。
 *      Console 报 CSP 时改走 Sources -> 代码片段(Snippets) -> 新建 -> 粘贴 -> Ctrl+Enter。
 * 行为:
 *   1) 只读遍历同源 iframe 树, 采集 video 元素 / 播放器 / 任务点列表 / 疑似弹题节点;
 *   2) 只读挂钩 XMLHttpRequest / fetch, 记录此后 60 秒内命中 /multimedia/log 的真实请求 URL(不改写、不重放);
 *   3) 60 秒后自动汇总: 打到 Console + 复制到剪贴板 + 暴露 window.__NCA_VIDEO_PROBE__。
 *   想提前拿结果: 控制台输入 __ncaDump()
 */
(() => {
  const WAIT_MS = 60000;
  const OUT = { url: location.href, title: document.title, time: new Date().toISOString(), frames: [], heartbeats: [], notes: [] };

  const VIDEO_SEL = "video, #video_html5_api, .vjs-tech, .vjs-big-play-button, [class*='vjs-']";
  const TASK_NODE_SEL = [".posCatalog_select", ".posCatalog_name", ".catalog_points_yi", ".jobUnfinishCount", ".orangeNew", ".posCatalog_level", "#content1 .chapter a"];
  const NEXT_SEL = "[onclick*='next'], .nextChapter, .orientationright, a, span";
  const TASK_SEL = ".posCatalog_name, .posCatalog_level, [onclick*='getTeacherAjax'], .chapter_item, .catalog_section li, .timeline li, .current, .active, .currents";
  const DOC_SEL = "iframe[src*='document'], iframe[src*='pdf'], #panViewer, .pdfViewer, .reader, [class*='docReader'], .ans-attach-online";
  const QUIZ_HINT = ["弹题", "答题", "题目", "选一选", "课堂测验", "ans-videoquiz", "videoquiz", "popup", "questionBox", "tk_", "topic"];

  const brief = (el) => {
    if (!el) return null;
    const cls = (typeof el.className === "string" ? el.className : "").trim().slice(0, 120);
    return { tag: el.tagName, id: el.id || null, cls: cls || null, text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) };
  };

  function collectDoc(doc, depth, path) {
    const rec = { depth, path, url: doc.location ? doc.location.href : "(cross-origin)", videos: [], tasks: [], docs: [], quizSuspects: [] };
    try {
      doc.querySelectorAll(VIDEO_SEL).forEach((el) => {
        const r = brief(el);
        if (el.tagName === "VIDEO") {
          r.src = (el.currentSrc || el.src || "").slice(-120);
          r.duration = Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null;
          r.currentTime = +el.currentTime.toFixed(2);
          r.paused = el.paused;
          r.playbackRate = el.playbackRate;
          r.muted = el.muted;
          r.videoWidth = el.videoWidth;
          r.namespaceURI = el.namespaceURI;
        }
        rec.videos.push(r);
      });
      doc.querySelectorAll(TASK_SEL).forEach((el) => {
        const r = brief(el);
        r.onclick = (el.getAttribute("onclick") || "").slice(0, 200) || null;
        r.href = el.getAttribute && el.getAttribute("href") || null;
        // 完成状态线索: 类名/图片名里常见的 completed/orange/已完成
        const html = el.outerHTML || "";
        r.stateHint = /complete|finished|pass|done|orange|green/i.test(html) ? "maybe-done" : "unknown";
        rec.tasks.push(r);
      });
      doc.querySelectorAll(DOC_SEL).forEach((el) => rec.docs.push(brief(el)));
      doc.querySelectorAll("div,section,aside").forEach((el) => {
        if (el.children.length > 12 || rec.quizSuspects.length > 40) return;
        const t = (el.textContent || "");
        if (t.length < 400 && QUIZ_HINT.some((k) => (el.id + " " + (typeof el.className === "string" ? el.className : "") + " " + t).includes(k))) {
          rec.quizSuspects.push(brief(el));
        }
      });
      // 任务点节点样本(刷课编排要用)
      rec.taskNodes = [];
      TASK_NODE_SEL.forEach((sel) => {
        const els = [...doc.querySelectorAll(sel)].slice(0, 3);
        if (!els.length) return;
        rec.taskNodes.push({ sel, count: doc.querySelectorAll(sel).length, samples: els.map((el) => (el.outerHTML || "").replace(/\s+/g, " ").slice(0, 700)) });
      });
      // 任务点分支标签(一个目录项里可能有多个: li#dct1 / onclick=changeDisplayContent(...))
      const tabEls = [...doc.querySelectorAll('li[id^="dct"], [onclick*="changeDisplayContent("]')];
      if (tabEls.length) {
        const seen = new Set();
        rec.taskTabs = [];
        for (const el of tabEls) {
          if (seen.has(el)) continue;
          seen.add(el);
          rec.taskTabs.push({
            id: el.id || null,
            cls: String(el.className || "").slice(0, 60),
            text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30),
            onclick: (el.getAttribute("onclick") || "").slice(0, 160),
            doneHint: /incomplete|uncomplete|notComplete/i.test(el.outerHTML || "") ? "has-incomplete" : (/icon_?Completed|icon-completed|isComplete|finished/i.test(el.outerHTML || "") ? "looks-done" : "unknown"),
            html: (el.outerHTML || "").replace(/\s+/g, " ").slice(0, 500),
          });
        }
      }
      // 「下一节」按钮(做完任务点后要点的东西)
      rec.nextButtons = [];
      [...doc.querySelectorAll(NEXT_SEL)].forEach((el) => {
        const t = (el.textContent || "").trim();
        if (t === "下一节" || t === "下一章" || /nextChapter/i.test(el.className || "") || /next/i.test(el.getAttribute("onclick") || "")) {
          rec.nextButtons.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 80), onclick: (el.getAttribute("onclick") || "").slice(0, 160), href: el.getAttribute("href"), text: t.slice(0, 30) });
        }
      });
      // 隐藏参数(接口用得到: cpi/clazzId/knowledgeId/cardId/objectId…)
      rec.hiddenInputs = {};
      doc.querySelectorAll("input[type=hidden]").forEach((el) => { if (el.id) rec.hiddenInputs[el.id] = String(el.value).slice(0, 60); });
      // 播放器细节(倍速菜单项 / 当前倍速)
      rec.player = {};
      const anyVideo = doc.querySelector("video");
      if (anyVideo) rec.player.playbackRate = anyVideo.playbackRate;
      const rateItems = [...doc.querySelectorAll(".vjs-playback-rate .vjs-menu-item, .vjs-playback-rate-value, [class*='rate']")].map((el) => (el.textContent || "").trim().slice(0, 20));
      if (rateItems.length) rec.player.rateMenu = rateItems.slice(0, 12);
      try {
        if (doc.defaultView && doc.defaultView.videojs && doc.defaultView.videojs.getPlayers) rec.player.videojsPlayers = Object.keys(doc.defaultView.videojs.getPlayers());
      } catch (e) {}
      // 视频全局对象线索(video.js / jwplayer 等)
      const gl = [];
      for (const k of ["videojs", "jwplayer", "player", "ans", "Y", "CKEDITOR", "dplayer"]) if (k in (doc.defaultView || {})) gl.push(k);
      rec.globals = gl;
    } catch (e) {
      rec.error = String(e && e.message || e);
    }
    return rec;
  }

  function walk(win, depth, path, seen) {
    let doc;
    try { doc = win.document; } catch (e) { return; }
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    OUT.frames.push(collectDoc(doc, depth, path));
    doc.querySelectorAll("iframe").forEach((f, i) => {
      let w = null;
      try { w = f.contentWindow; } catch (e) {}
      if (!w) { OUT.notes.push("跨域 iframe: " + (f.src || "").slice(0, 120)); return; }
      try { walk(w, depth + 1, path + "/" + i, seen); } catch (e) {}
    });
  }

  // ---- 只读网络记录 ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    try { this.__ncaUrl = String(u); this.__ncaMethod = m; } catch (e) {}
    return origOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const u = this.__ncaUrl || "";
      if (/multimedia\/log|ananas\/status|insertlog|work\/|api\//.test(u)) {
        OUT.heartbeats.push({ via: "xhr", method: this.__ncaMethod, url: u, body: args[0] ? String(args[0]).slice(0, 400) : null, t: new Date().toISOString() });
      }
    } catch (e) {}
    return origSend.apply(this, args);
  };
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (/multimedia\/log|ananas\/status|insertlog|work\/|api\//.test(u)) {
          OUT.heartbeats.push({ via: "fetch", method: (init && init.method) || "GET", url: u, body: init && init.body ? String(init.body).slice(0, 400) : null, t: new Date().toISOString() });
        }
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }

  const dump = () => {
    walk(window, 0, "top", new Set());
    const text = JSON.stringify(OUT, null, 1);
    window.__NCA_VIDEO_PROBE__ = OUT;
    try { copy(text); console.log("[nca] 已复制到剪贴板, 直接粘贴给 agent"); } catch (e) {}
    console.log("[nca] 视频页结构探针结果:", OUT);
    console.log("[nca] 文本版:\n" + text.slice(0, 20000));
    return OUT;
  };
  window.__ncaDump = dump;

  setTimeout(dump, WAIT_MS);
  console.log(`[nca] 已开始采集(只读)。请让视频播放/触发一次心跳, ${WAIT_MS / 1000}s 后自动汇总; 想提前: 输入 __ncaDump()`);
  return "[nca] video-probe installed";
})();
