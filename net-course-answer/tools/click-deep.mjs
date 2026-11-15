// 跨 iframe 的"真实点击"(CDP Input.dispatchMouseEvent, 可信事件) —— 解决"JS .click() 点不动视频播放键"的问题。
// 用法:
//   node tools/click-deep.mjs <port> "iframe[src*=knowledge/cards]>iframe[src*=modules/video]@2>.vjs-play-control"
//   node tools/click-deep.mjs <port> --xy 640,360
// 说明: 选择器路径用 ">" 分隔, 最后一段是目标元素; "@N" 表示取第 N 个匹配(1 起)。
import fs from "node:fs";

const port = process.argv[2] || "9222";
const arg = process.argv[3] || "";
const xyArg = process.argv[4] || "";

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result || m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetInfos } = await send("Target.getTargets");
const targets = targetInfos.filter((t) => t.type === "page");
const target = targets.find((t) => /chaoxing/.test(t.url)) || targets[targets.length - 1];
const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
console.log("[target]", target.url.slice(0, 90));

/** 把 "a>b@2>c" 解析成 [{sel, idx}] */
const parsePath = (p) =>
  p.split(">").map((seg) => {
    const m = seg.trim().match(/^(.*)@(\d+)$/);
    return m ? { sel: m[1], idx: Number(m[2]) } : { sel: seg.trim(), idx: 1 };
  });

let coords = { x: 0, y: 0 };
if (/^--xy$/.test(arg)) {
  const [x, y] = xyArg.split(",").map(Number);
  coords = { x, y };
} else if (arg) {
  const path = parsePath(arg);
  const expr = `(() => {
    const path = ${JSON.stringify(path)};
    let win = window, ax = 0, ay = 0;
    for (let i = 0; i < path.length; i++) {
      const { sel, idx } = path[i];
      let doc; try { doc = win.document; } catch (e) { return JSON.stringify({ err: 'cross-origin at ' + sel }); }
      const els = doc.querySelectorAll(sel);
      const el = els[idx - 1];
      if (!el) return JSON.stringify({ err: 'not found: ' + sel + ' @' + idx + ' (matched ' + els.length + ')' });
      if (i < path.length - 1) {
        const r = el.getBoundingClientRect();
        ax += r.left; ay += r.top;
        win = el.contentWindow;
        if (!win) return JSON.stringify({ err: 'no contentWindow for ' + sel });
        continue;
      }
      if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} }
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(ax + r.left + r.width / 2), y: Math.round(ay + r.top + r.height / 2), box: [Math.round(r.width), Math.round(r.height)], text: String(el.textContent || '').trim().slice(0, 30) });
    }
  })()`;
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  const out = JSON.parse((r.result && r.result.value) || "{}");
  if (out.err) {
    console.log("✗", out.err);
    process.exit(1);
  }
  coords = { x: out.x, y: out.y };
  console.log(`[目标] ${out.text || ""} 坐标 ${out.x},${out.y}  尺寸 ${out.box.join("x")}`);
} else {
  console.log("用法: node tools/click-deep.mjs <port> \"sel>sel@2>target\"  |  --xy x,y");
  process.exit(1);
}

const base = { x: coords.x, y: coords.y, button: "left", buttons: 1, clickCount: 1 };
await send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 }, sessionId);
await send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId);
await new Promise((r) => setTimeout(r, 60));
await send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, sessionId);
console.log(`[点击] 已派发可信点击 @ ${coords.x},${coords.y}`);
ws.close();
process.exit(0);
