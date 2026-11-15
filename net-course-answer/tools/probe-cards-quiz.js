/* 只读: 复用页面自己发过的 knowledge/cards 请求, 看这一章视频有没有开"时间轴对象/互动测验" */
(async () => {
  const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /knowledge\/cards/.test(u));
  if (!urls.length) return JSON.stringify({ err: "页面没发过 knowledge/cards" });
  const url = urls[urls.length - 1];
  try {
    const r = await fetch(url, { credentials: "include" });
    const t = await r.text();
    const keys = [...new Set((t.match(/"[a-zA-Z_]{3,30}"\s*:/g) || []).map((s) => s.replace(/["\s:]/g, "")))];
    const num = (k) => (t.match(new RegExp(`"${k}"\\s*:\\s*(\\d+)`)) || [])[1];
    return JSON.stringify(
      {
        status: r.status,
        url: url.replace(/^https?:\/\/[^/]+/, "").slice(0, 150),
        len: t.length,
        videoTopicCloud: num("videoTopicCloud"),
        aiVideoInterpret: num("aiVideoInterpret"),
        playingLoopCapture: num("playingLoopCapture"),
        startCapture: num("startCapture"),
        hasInteractiveQuiz: /InteractiveQuiz/i.test(t),
        hasTimeline: /timeline/i.test(t),
        quizKeys: keys.filter((k) => /quiz|interactive|timeline|topic|danmu/i.test(k)),
        reportUrl: (t.match(/"reportUrl"\s*:\s*"([^"]+)"/) || [])[1],
        initdataUrl: (t.match(/"initdataUrl"\s*:\s*"([^"]+)"/) || [])[1],
      },
      null,
      1
    );
  } catch (e) {
    return JSON.stringify({ err: String(e) });
  }
})();
