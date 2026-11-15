/* ===== 网课答题助手 — 页面 DOM 采集脚本 (tools/dom-probe.js) =====
 * 用途: 侦查超星/智慧树答题页的真实 DOM 结构, 供适配器定位选择器。
 *      也是回归工具: 页面改版后重跑一次, 对比 selectors / candidates 是否变化。
 * 用法: 浏览器打开目标页(已登录) -> F12 -> Console -> 粘贴本脚本 -> 回车
 *      Edge 中文界面首次会拦粘贴: 在 Console 里【手打】"允许粘贴"(不要复制)回车, 再粘本脚本。
 *      若 Console 报 Refused to evaluate(CSP): 改走 Sources -> 代码片段(Snippets) -> 新建 -> 粘贴 -> Ctrl+Enter。
 * 行为: 只读, 不改页面任何东西。结果打到 Console, 并复制到剪贴板 + 右下角弹出已全选的文本框。
 */
(() => {
  const OUT = {
    url: location.href, title: document.title, readyState: document.readyState,
    time: new Date().toISOString(), docs: [],
  };

  const SELECTORS = [
    ".TiMu", ".TiMu_new", ".TiMuList", ".questionLi", ".examPaper_subject",
    ".fontLabel", ".answerBg", ".answer_p", ".colorShallow", ".Zy_TItle",
    "[class*=before-after]", ".subject_describe", ".smallStem_describe",
    "[class*=question]", "[class*=Question]", "[class*=timu]", "[class*=TiMu]",
    "[class*=stem]", "[class*=subject]", "[class*=answer]", "[class*=option]",
    "[class*=choice]", "[class*=mark]", "[class*=discuss]", "[class*=comment]",
    "[class*=topic]", "[class*=post]", "[class*=reply]", "[id*=question]", "[id*=TiMu]",
  ];
  const CONTROLS = {
    radio: "input[type=radio]", checkbox: "input[type=checkbox]", textarea: "textarea",
    contenteditable: "[contenteditable=true]", textInput: "input[type=text]",
    iframe: "iframe", video: "video", audio: "audio", ueditor: ".edui-editor",
  };

  function topClasses(doc, n) {
    const c = {};
    doc.querySelectorAll("*").forEach((el) => {
      const cn = el.className;
      if (cn && typeof cn === "string") cn.trim().split(/\s+/).forEach((x) => { if (x) c[x] = (c[x] || 0) + 1; });
    });
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  // 含"题型控件"的元素, 按其 class 归并 —— 命中数最多的通常就是题目容器
  function questionCandidates(doc) {
    const map = new Map();
    doc.querySelectorAll("*").forEach((el) => {
      const cn = el.className;
      if (!cn || typeof cn !== "string") return;
      if (!el.querySelector("input[type=radio],input[type=checkbox],textarea,[contenteditable=true]")) return;
      const key = cn.trim().split(/\s+/).filter(Boolean).join(".");
      if (!map.has(key)) map.set(key, { class: key, count: 0, sample: el.outerHTML.slice(0, 800) });
      map.get(key).count++;
    });
    return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, 12);
  }

  // 第一个疑似题目的完整片段(含选项控件), 供人工比对选项类名/role/aria-label
  function firstSampleHtml(doc) {
    for (const s of [".TiMu", ".questionLi", ".examPaper_subject", ".TiMu_new", "[class*=question]", "[class*=subject]"]) {
      try { const el = doc.querySelector(s); if (el) return { sel: s, html: el.outerHTML.slice(0, 5000) }; } catch (e) {}
    }
    return null;
  }

  function analyze(doc, label) {
    const r = { label, url: null, selectors: {}, controls: {}, iframes: [], candidates: [], topClasses: [], bodyText: "", sample: null };
    try { r.url = doc.location.href; } catch (e) {}
    for (const s of SELECTORS) { try { const n = doc.querySelectorAll(s).length; if (n) r.selectors[s] = n; } catch (e) {} }
    for (const k in CONTROLS) { try { const n = doc.querySelectorAll(CONTROLS[k]).length; if (n) r.controls[k] = n; } catch (e) {} }
    try { r.iframes = Array.from(doc.querySelectorAll("iframe")).map((f) => f.getAttribute("src") || f.src || ""); } catch (e) {}
    try { r.candidates = questionCandidates(doc); } catch (e) { r.candidates = [{ error: String(e) }]; }
    try { r.topClasses = topClasses(doc, 30); } catch (e) {}
    try { r.bodyText = (doc.body ? doc.body.innerText : "").slice(0, 2000); } catch (e) {}
    try { r.sample = firstSampleHtml(doc); } catch (e) {}
    return r;
  }

  // 递归主文档 + 所有【同源】iframe (超星题目常藏在 iframe 里); 跨域 iframe 只记录 URL
  const seen = new Set();
  function walk(doc, label, depth) {
    if (!doc || seen.has(doc) || depth > 3) return;
    seen.add(doc);
    try { OUT.docs.push(analyze(doc, label)); } catch (e) { OUT.docs.push({ label, error: String(e) }); }
    let frames = [];
    try { frames = Array.from(doc.querySelectorAll("iframe")); } catch (e) { frames = []; }
    frames.forEach((f) => {
      const src = f.getAttribute("src") || f.src || "(no src)";
      let d = null;
      try { d = f.contentDocument; } catch (e) { OUT.docs.push({ label: "iframe: " + src, note: "cross-origin: " + e.message }); return; }
      if (d) walk(d, "iframe[" + depth + "]: " + src, depth + 1);
      else OUT.docs.push({ label: "iframe: " + src, note: "contentDocument null (cross-origin?)" });
    });
  }
  walk(document, "main", 0);

  const text = JSON.stringify(OUT, null, 1);
  console.log("%c=== NCA PROBE START (" + text.length + " chars) ===", "color:#0a0;font-weight:bold");
  console.log(text);
  console.log("%c=== NCA PROBE END ===", "color:#0a0;font-weight:bold");
  window.__NCA_PROBE__ = OUT;
  try { copy(text); console.log("已复制到剪贴板, 直接粘贴给 agent 即可"); } catch (e) {}

  try {
    const old = document.getElementById("__nca_probe_box__");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "__nca_probe_box__";
    box.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;width:560px;height:340px;background:#111;color:#0f0;font:12px/1.4 monospace;border:2px solid #0a0;border-radius:8px;padding:8px;box-shadow:0 8px 30px rgba(0,0,0,.5)";
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "width:100%;height:285px;background:#000;color:#0f0;border:1px solid #0a0;font:12px/1.4 monospace";
    const btn = document.createElement("button");
    btn.textContent = "关闭 (内容已全选, Ctrl+C 后点我)";
    btn.style.cssText = "margin-top:6px;padding:4px 10px;cursor:pointer";
    btn.onclick = () => box.remove();
    box.appendChild(ta);
    box.appendChild(btn);
    (document.body || document.documentElement).appendChild(box);
    ta.focus(); ta.select();
  } catch (e) {}

  return OUT;
})();
