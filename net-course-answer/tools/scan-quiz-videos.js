/* 只读全课扫描: 每章 cards → 取视频 objectid → 调 richvideo/initdatawithviewerV2 → 找 InteractiveQuiz(弹题) */
(async () => {
  const items = [...document.querySelectorAll(".posCatalog_name")]
    .map((el) => {
      const m = (el.getAttribute("onclick") || "").match(/getTeacherAjax\('(\d+)','(\d+)','(\d+)'\)/);
      return m ? { knowledgeId: m[3], courseId: m[1], clazzId: m[2], name: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 34) } : null;
    })
    .filter(Boolean);
  const seen = new Set();
  const uniq = items.filter((i) => (seen.has(i.knowledgeId) ? false : (seen.add(i.knowledgeId), true)));
  const objs = new Map(); // objectId -> {chapter}
  const q = uniq.slice();
  const cardsWorker = async () => {
    while (q.length) {
      const it = q.shift();
      try {
        const url = `/mooc-ans/knowledge/cards?clazzid=${it.clazzId}&courseid=${it.courseId}&knowledgeid=${it.knowledgeId}&num=0&ut=s&cpi=<cpi>&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false`;
        const t = await (await fetch(url, { credentials: "include" })).text();
        for (const m of t.matchAll(/"objectid"\s*:\s*"([a-f0-9]{16,})"/g)) {
          if (!objs.has(m[1])) objs.set(m[1], it.name);
        }
      } catch (e) {}
    }
  };
  await Promise.all(Array.from({ length: 5 }, cardsWorker));

  const list = [...objs.entries()];
  const hits = [];
  const errs = [];
  let done = 0;
  const qi = list.slice();
  const infoWorker = async () => {
    while (qi.length) {
      const [objectId, chapter] = qi.shift();
      try {
        const r = await fetch(`/mooc-ans/richvideo/initdatawithviewerV2?mid=${objectId}`, { credentials: "include" });
        const t = await r.text();
        done++;
        if (/InteractiveQuiz/i.test(t)) {
          hits.push({ objectId, chapter, len: t.length, snippet: t.slice(0, 400) });
        }
        if (/quiz/i.test(t) && !/InteractiveQuiz/i.test(t)) {
          errs.push({ objectId, chapter, note: "含 quiz 字样(非 InteractiveQuiz)", len: t.length });
        }
      } catch (e) {
        errs.push({ objectId, err: e.name });
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, infoWorker));
  return JSON.stringify({ chapters: uniq.length, videoObjects: list.length, initdataDone: done, quizHits: hits.slice(0, 8), notes: errs.slice(0, 6) }, null, 1);
})();
