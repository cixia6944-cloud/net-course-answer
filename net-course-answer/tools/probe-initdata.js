/* 只读: 用页面里视频的 objectId 试调 richvideo/initdata* 接口, 看返回里有没有弹题(InteractiveQuiz) */
(async () => {
  const seen = new Set();
  const frames = [];
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
      if (d2 && d2.querySelector("video")) frames.push(w2);
      walk(w2, d + 1);
    }
  };
  walk(window, 0);
  if (!frames.length) return JSON.stringify({ err: "没找到视频 iframe" });
  const out = [];
  for (const w of frames) {
    const objectId = w.videoObjectId || null;
    const jobId = w.videoJobId || null;
    const rec = { objectId, jobId, tries: [] };
    if (objectId) {
      const cands = [
        `/mooc-ans/richvideo/initdatawithviewerV2?mid=${objectId}&clazzId=<clazzId>&courseId=<courseId>&cpi=<cpi>&view=pc&ut=s`,
        `/mooc-ans/richvideo/initdatawithviewer?mid=${objectId}&clazzId=<clazzId>&courseId=<courseId>&cpi=<cpi>&view=pc&ut=s`,
        `/mooc-ans/richvideo/initdatawithviewerV2?mid=${objectId}`,
        `/mooc-ans/richvideo/initdatawithviewer?objectId=${objectId}&clazzId=<clazzId>&courseId=<courseId>&cpi=<cpi>&view=pc`,
      ];
      for (const u of cands) {
        try {
          const r = await fetch(u, { credentials: "include" });
          const t = await r.text();
          const keys = [...new Set((t.match(/"[a-zA-Z_]{3,28}"\s*:/g) || []).map((s) => s.replace(/["\s:]/g, "")))];
          rec.tries.push({
            u: u.replace("/mooc-ans/richvideo/", "").slice(0, 70),
            status: r.status,
            len: t.length,
            interactiveQuiz: /InteractiveQuiz/i.test(t),
            timeline: /timeline/i.test(t),
            head: t.slice(0, 120).replace(/\s+/g, " "),
            keys: keys.slice(0, 18),
          });
        } catch (e) {
          rec.tries.push({ u: u.slice(0, 60), err: e.name });
        }
      }
    }
    out.push(rec);
  }
  return JSON.stringify(out, null, 1);
})();
