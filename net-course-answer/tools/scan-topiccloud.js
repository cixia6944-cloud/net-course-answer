/* 只读批量扫描: 逐章拉 knowledge/cards, 找出开了"时间轴对象/互动测验"(videoTopicCloud) 的章节。
 * 前提: 当前页是某门课的 studentstudy(顶层有 .posCatalog_name 列表)。 */
(async () => {
  const items = [...document.querySelectorAll(".posCatalog_name")]
    .map((el) => {
      const oc = el.getAttribute("onclick") || "";
      const m = oc.match(/getTeacherAjax\('(\d+)','(\d+)','(\d+)'\)/);
      return m ? { knowledgeId: m[3], courseId: m[1], clazzId: m[2], name: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) } : null;
    })
    .filter(Boolean);
  if (!items.length) return JSON.stringify({ err: "没找到 .posCatalog_name" });
  const seen = new Set();
  const uniq = items.filter((i) => (seen.has(i.knowledgeId) ? false : (seen.add(i.knowledgeId), true)));
  const hits = [];
  const errs = [];
  let done = 0;
  const one = async (it) => {
    const url = `/mooc-ans/knowledge/cards?clazzid=${it.clazzId}&courseid=${it.courseId}&knowledgeid=${it.knowledgeId}&num=0&ut=s&cpi=<cpi>&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false`;
    try {
      const t = await (await fetch(url, { credentials: "include" })).text();
      done++;
      const num = (k) => (t.match(new RegExp(`"${k}"\\s*:\\s*(\\d+)`)) || [])[1];
      const vtc = num("videoTopicCloud");
      const flags = {
        videoTopicCloud: vtc,
        aiVideoInterpret: num("aiVideoInterpret"),
        playingLoopCapture: num("playingLoopCapture"),
        videoFaceCaptureEnc: num("videoFaceCaptureEnc"),
        topics: (t.match(/"topicList"\s*:\s*(\[)/) || [])[1] ? "has-topicList" : null,
        quiz: /InteractiveQuiz/i.test(t) ? "InteractiveQuiz!" : null,
      };
      if (vtc !== "0" || flags.quiz || flags.topics || flags.aiVideoInterpret !== "0") hits.push({ ...it, ...flags });
    } catch (e) {
      errs.push(it.knowledgeId + ":" + e.name);
    }
  };
  const queue = uniq.slice();
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) await one(queue.shift());
  });
  await Promise.all(workers);
  return JSON.stringify({ scanned: done, total: uniq.length, errs: errs.slice(0, 5), hits: hits.slice(0, 25) }, null, 1);
})();
