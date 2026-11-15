/* 只读检测: 列出所有视频 iframe 的状态 + 是否出现"疑似弹题"层(排除弹幕/video.js控件/AI答疑) */
(() => {
  const clean = (s, n = 60) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const frames = [];
  const seen = new Set();
  const walk = (w, d) => {
    if (d > 3) return;
    let doc;
    try { doc = w.document; } catch (e) { return; }
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    for (const f of doc.querySelectorAll("iframe")) {
      let w2 = null;
      try { w2 = f.contentWindow; } catch (e) {}
      if (!w2) continue;
      let d2 = null;
      try { d2 = w2.document; } catch (e) {}
      if (d2 && d2.querySelector("video")) frames.push({ w: w2, doc: d2 });
      walk(w2, d + 1);
    }
  };
  walk(window, 0);
  let anyQuiz = false;
  const out = frames.map((fr, i) => {
    const v = fr.doc.querySelector("video");
    const quiz = [];
    for (const el of fr.doc.querySelectorAll("div,section,form,ul,li,h1,h2,h3,p")) {
      if (!(el.offsetWidth || el.offsetHeight)) continue;
      const cls = String(el.className || "");
      if (/vjs-/.test(cls)) continue;
      const txt = clean(el.textContent, 90);
      if (txt.length < 8) continue;
      if (/ai_quiz|aiQuiz|写笔记|不懂|知道了/.test(cls + txt)) continue;
      const quizCls = /quiz|timu|ti_mu|question_?box|videoquiz|subject|exam|customIframe|innerPage|tkParsing|interactive/i.test(cls);
      const quizTxt = /请选择|下列.{0,10}(正确|错误|属于)|单选|多选|判断|提交答案|继续观看|回答正确|回答错误|答对|答错|请作答|互动测验|答对了/.test(txt);
      if (quizCls || quizTxt) quiz.push({ tag: el.tagName, id: el.id || null, cls: clean(cls, 60), area: el.offsetWidth + "x" + el.offsetHeight, txt: txt.slice(0, 80) });
    }
    const subFrames = [...fr.doc.querySelectorAll("iframe")].map((f) => (f.getAttribute("src") || "(空)").slice(0, 80));
    const overlays = [...fr.doc.querySelectorAll("div")].filter((e) => {
      if (!(e.offsetWidth > 200 && e.offsetHeight > 120)) return false;
      const st = (fr.doc.defaultView.getComputedStyle && fr.doc.defaultView.getComputedStyle(e)) || {};
      const bg = String(st.backgroundColor || "");
      return /rgba?\(0, 0, 0/.test(bg) && Number(st.zIndex || 0) > 1;
    }).length;
    if (quiz.length) anyQuiz = true;
    return {
      i,
      objectId: fr.w.videoObjectId || null,
      jobId: fr.w.videoJobId || null,
      cur: Math.round(v.currentTime),
      dur: Math.round(v.duration || 0),
      paused: v.paused,
      rate: v.playbackRate,
      quiz: quiz.slice(0, 8),
      subFrames,
      darkOverlays: overlays,
    };
  });
  return JSON.stringify({ videoFrames: out.length, anyQuiz, frames: out }, null, 1);
})();
