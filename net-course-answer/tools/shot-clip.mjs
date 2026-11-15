// 元素级截图(CDP Page.captureScreenshot + clip): 只截某个元素, 可放大 / 模拟深色。
// 用法: node tools/shot-clip.mjs <port> <选择器> <输出png> [scale=2] [dark=0|1] [padding=0]
import fs from "node:fs";

const [, , port = "9222", sel, out, scaleArg = "2", darkArg = "0", padArg = "0"] = process.argv;
if (!sel || !out) {
  console.log("用法: node tools/shot-clip.mjs <port> <选择器> <输出png> [scale] [dark 0|1] [padding]");
  process.exit(1);
}
const scale = Number(scaleArg) || 2;
const dark = String(darkArg) === "1";
const pad = Number(padArg) || 0;

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
const targets = (targetInfos || []).filter((t) => t.type === "page");
const target = targets.find((t) => /chaoxing|127\.0\.0\.1/.test(t.url)) || targets[targets.length - 1];
const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
if (dark) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);

const box = await send(
  "Runtime.evaluate",
  {
    expression: `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return JSON.stringify({err:'not found'});const r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height})})()`,
    returnByValue: true,
  },
  sessionId
);
const b = JSON.parse((box.result && box.result.value) || "{}");
if (b.err) {
  console.log("✗", b.err);
  process.exit(1);
}
const shot = await send(
  "Page.captureScreenshot",
  {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.w + pad * 2, height: b.h + pad * 2, scale },
  },
  sessionId
);
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
if (dark) await send("Emulation.setEmulatedMedia", { features: [] }, sessionId);
console.log(`✓ ${out}  (${Math.round(b.w)}x${Math.round(b.h)} @${scale}x${dark ? " 深色" : ""})`);
ws.close();
process.exit(0);
