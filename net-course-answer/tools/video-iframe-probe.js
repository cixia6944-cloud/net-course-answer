/* S3 弹题线索: 递归找到"含 video 的 iframe", dump 弹层/danmu/popup/脚本清单(只读) */
(() => {
  const clean = (s, n = 70) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  let target = null;
  const seen = new Set();
  const walk = (win, depth) => {
    if (depth > 3 || target) return;
    let doc;
    try {
      doc = win.document;
    } catch (e) {
      return;
    }
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    for (const f of doc.querySelectorAll("iframe")) {
      let w = null;
      try {
        w = f.contentWindow;
      } catch (e) {}
      if (!w) continue;
      try {
        const d2 = w.document;
        if (d2 && d2.querySelector("video")) {
          target = d2;
          return;
        }
      } catch (e) {}
      walk(w, depth + 1);
      if (target) return;
    }
  };
  walk(window, 0);
  if (!target) return "no-video-frame";
  const pick = (sel, n = 8) =>
    [...target.querySelectorAll(sel)].slice(0, n).map((e) => ({
      tag: e.tagName,
      cls: clean(e.className, 70),
      id: e.id || null,
      txt: clean(e.textContent, 60),
      vis: !!(e.offsetWidth || e.offsetHeight),
      html: clean(e.outerHTML, 220),
    }));
  const v = target.querySelector("video");
  return JSON.stringify(
    {
      frameUrl: clean(target.location.href, 120),
      video: v
        ? {
            id: v.id,
            cls: clean(v.className, 60),
            src: clean(v.currentSrc || v.src, 120),
            duration: v.duration,
            currentTime: v.currentTime,
            paused: v.paused,
            readyState: v.readyState,
            playbackRate: v.playbackRate,
          }
        : null,
      danmu: pick("[class*=danmu]"),
      popup: pick("[class*=popup]", 8),
      dialog: pick("[class*=dialog]", 6),
      mask: pick("[class*=mask]", 4),
      quizLike: pick("[class*=quiz],[class*=question],[class*=exam],[class*=timu]", 6),
      buttons: [...target.querySelectorAll("a,button,div,span")]
        .map((e) => clean(e.textContent, 14))
        .filter((t) => t && t.length < 14 && /弹|题|确定|提交|继续|播放|笔记|知道了|下一/.test(t))
        .slice(0, 20),
      scripts: [...target.querySelectorAll("script[src]")].map((s) => s.src.split("/").slice(-1)[0]).slice(0, 18),
      winKeys: Object.keys(target.defaultView)
        .filter((k) => /^(ans|video|check|popup|danmu|question|quiz|object)/i.test(k))
        .slice(0, 20),
    },
    null,
    1
  );
})();
