/* 算出"嵌套 iframe 里某个元素"在**顶层页面坐标**里的位置(供 CDP 真实点击用)。
 * 改 PATH 即可复用: 每段 [选择器, 第几个匹配(1起)], 最后一段是目标元素。
 */
(() => {
  const PATH = [
    ["iframe[src*=knowledge/cards]", 1],
    ["iframe[src*=modules/video]", 2],
    [".vjs-play-control", 1],
  ];
  let win = window;
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < PATH.length; i++) {
    const sel = PATH[i][0];
    const idx = PATH[i][1];
    let doc;
    try {
      doc = win.document;
    } catch (e) {
      return JSON.stringify({ err: "cross-origin at " + sel });
    }
    const els = doc.querySelectorAll(sel);
    const el = els[idx - 1];
    if (!el) return JSON.stringify({ err: "not found: " + sel + " @" + idx + " (matched " + els.length + ")" });
    if (i < PATH.length - 1) {
      const r = el.getBoundingClientRect();
      ax += r.left;
      ay += r.top;
      win = el.contentWindow;
      continue;
    }
    const r = el.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(ax + r.left + r.width / 2),
      y: Math.round(ay + r.top + r.height / 2),
      box: [Math.round(r.width), Math.round(r.height)],
      cls: String(el.className).slice(0, 50),
      text: String(el.textContent || "").trim().slice(0, 20),
    });
  }
  return JSON.stringify({ err: "empty path" });
})();
