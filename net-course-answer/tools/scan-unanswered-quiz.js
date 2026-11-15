/* 扫描: 遍历当前课程所有章节的任务点类型标签, 找出"测验类且未完成"的任务点(只读)
 * 前提: 顶层是旧版 studentstudy(有 .posCatalog_name + li[id^=dct])
 * 输出: {chapters:[{chapterId,title,unfinished,tabs:[{id,label,onclick,done}]}], quizCandidates:[...]}
 */
(async () => {
  const clean = (s, n = 60) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const items = [...document.querySelectorAll(".posCatalog_name")]
    .map((el) => {
      const m = (el.getAttribute("onclick") || "").match(/getTeacherAjax\('(\d+)','(\d+)','(\d+)'\)/);
      if (!m) return null;
      const row = el.closest(".posCatalog_select") || el.parentElement;
      const cnt = row ? row.querySelector(".jobUnfinishCount") : null;
      const yi = row ? row.querySelector(".catalog_points_yi") : null;
      const unfin = cnt ? Number(String(cnt.textContent).replace(/\D/g, "") || 0) : Number(((yi ? yi.textContent : "").match(/个待完成任务点\s*(\d+)/) || [])[1] || 0);
      return { courseId: m[1], clazzId: m[2], knowledgeId: m[3], title: clean(el.textContent, 44), unfinished: unfin, el };
    })
    .filter(Boolean);

  // 只挑"有未完成"的章节(其他不用看)
  const pending = items.filter((i) => i.unfinished > 0);
  return JSON.stringify(
    {
      url: location.href,
      total: items.length,
      pendingCount: pending.length,
      pending: pending.map((p) => ({ knowledgeId: p.knowledgeId, title: p.title, unfinished: p.unfinished })),
    },
    null,
    1
  );
})();
