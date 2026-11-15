/* 题型契约探针: 递归进 iframe 找题目容器, 统计题型分布 + 控件 + 样本(只读) */
(() => {
  const clean = (s, n = 90) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const QSEL = ".TiMu,.questionLi,.examPaper_subject,[class*=TiMu],[class*=questionLi]";
  let found = null;
  let foundPath = "";
  const seen = new Set();
  const walk = (w, path, d) => {
    if (d > 4 || found) return;
    let doc;
    try {
      doc = w.document;
    } catch (e) {
      return;
    }
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    try {
      if (doc.querySelectorAll(QSEL).length) {
        found = doc;
        foundPath = path;
        return;
      }
    } catch (e) {}
    let fs = [];
    try {
      fs = Array.from(doc.querySelectorAll("iframe"));
    } catch (e) {}
    for (const f of fs) {
      let w2 = null;
      try {
        w2 = f.contentWindow;
      } catch (e) {}
      const src = f.getAttribute("src") || "?";
      const tag = src.split("?")[0].split("/").slice(-2).join("/");
      if (w2) walk(w2, path + ">" + tag, d + 1);
      if (found) return;
    }
  };
  walk(window, "top", 0);

  if (!found) {
    const t = document.body ? document.body.innerText || "" : "";
    return JSON.stringify(
      {
        url: location.href,
        noQuestionContainer: true,
        typeWords: Array.from(new Set(t.match(/【[^】]{2,8}】/g) || [])).slice(0, 12),
        bodyHead: clean(t, 300),
      },
      null,
      1
    );
  }

  const rows = Array.from(found.querySelectorAll(QSEL));
  const items = rows.map((el, i) => {
    const txt = clean(el.innerText, 320);
    const typeWord = (txt.match(/【([^】]{2,10})】/) || [])[1] || null;
    const radios = el.querySelectorAll("li[role=radio],input[type=radio],.before-after").length;
    const checks = el.querySelectorAll("li[role=checkbox],input[type=checkbox],.before-after-checkbox").length;
    const areas = el.querySelectorAll("textarea").length;
    const texts = el.querySelectorAll("input[type=text]").length;
    const editor = !!el.querySelector(".edui-editor,[class*=edui],[contenteditable=true]");
    const blanks = (txt.match(/_{2,}/g) || []).length;
    let guess = "?";
    if (checks > 0) guess = "多选";
    else if (radios > 0) guess = "单选";
    else if (areas > 0 || editor) guess = "填空/简答(富文本)";
    else if (texts > 0) guess = "填空(输入框)";
    const box = el.querySelector("input[id^=answer]");
    return {
      i,
      typeWord,
      guess,
      radios,
      checks,
      areas,
      texts,
      editor,
      blanks,
      ansBox: box ? box.id : null,
      cls: clean(el.className, 44),
      sample: txt.slice(0, 120),
    };
  });
  const counts = {};
  for (const r of items) {
    const k = r.typeWord || r.guess;
    counts[k] = (counts[k] || 0) + 1;
  }
  const bodyText = found.body ? found.body.innerText || "" : "";
  return JSON.stringify(
    {
      url: location.href,
      title: found.title,
      docPath: foundPath,
      total: rows.length,
      counts,
      items,
      typeHeadline: Array.from(new Set(bodyText.match(/[一二三四五六七八九十]\.\s*[^（(\n]{2,10}[（(]共\d+题[）)]/g) || [])),
      globals: { UE: typeof found.defaultView.UE !== "undefined", jQuery: typeof found.defaultView.jQuery !== "undefined" },
      inputs: {
        textarea: found.querySelectorAll("textarea").length,
        text: found.querySelectorAll("input[type=text]").length,
        hiddenAnswer: found.querySelectorAll("input[id^=answer]").length,
        radio: found.querySelectorAll("input[type=radio]").length,
        checkbox: found.querySelectorAll("input[type=checkbox]").length,
      },
    },
    null,
    1
  );
})();
