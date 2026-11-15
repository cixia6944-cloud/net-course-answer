// 真机端到端联调(无需装油猴):
//   前置: ① 浏览器以 --remote-debugging-port=9222 + 非默认 user-data-dir 启动并已登录超星
//        ② 桥在跑  ③ 已生成注入包(node tools/make-inject.mjs)
//   做法: 把「GM_* 垫片 + 构建产物」注入真实答题页; GM_xmlhttpRequest 经 Runtime.addBinding
//         回传给 node 发 HTTP, 绕开浏览器 Local Network Access 对「公网页面 → 127.0.0.1」的拦截。
//   用法: node tools/edge-e2e.mjs [port=9222] [urlFilter=doHomeWorkNew] [inject=tools/.cache/inject.js]
import fs from "node:fs";

const PORT = Number(process.argv[2] || 9222);
const URL_FILTER = process.argv[3] || "doHomeWorkNew";
const INJECT = process.argv[4] || "tools/.cache/inject.js";
const BRIDGE = "http://127.0.0.1:30142/ask";

const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
let session = null;

ws.addEventListener("message", async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === "Runtime.bindingCalled" && m.params.name === "__ncaBridge") {
    const req = JSON.parse(m.params.payload);
    try {
      const r = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" ? undefined : req.body,
      });
      const text = await r.text();
      console.log(`[bridge] ${req.method} ${req.url.slice(-24)} → ${r.status} (${text.length}B) ${text.slice(0, 100)}`);
      await send("Runtime.evaluate", { expression: `window.__ncaResolve(${JSON.stringify(req.id)}, ${JSON.stringify(text)})` }, session);
    } catch (e) {
      console.error("[bridge] 请求失败", e.message);
      await send("Runtime.evaluate", { expression: `window.__ncaResolve(${JSON.stringify(req.id)}, ${JSON.stringify(JSON.stringify({ ok: false, error: e.message }))})` }, session);
    }
  }
});
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
function send(method, params = {}, sid) {
  const i = id++;
  return new Promise((resolve, reject) => {
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error("JS: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.filter((t) => t.type === "page" && t.url.includes(URL_FILTER)).pop();
if (!page) throw new Error("找不到答题页 target");
console.log("[e2e] 目标页:", page.url.slice(0, 110));
session = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
await send("Runtime.enable", {}, session);
await send("Page.enable", {}, session);
await send("Runtime.addBinding", { name: "__ncaBridge" }, session);

console.log("[e2e] 重新加载页面 …");
await send("Page.navigate", { url: page.url }, session);
await new Promise((r) => setTimeout(r, 12000));

const q = await evaluate(
  `JSON.stringify({tiMu:document.querySelectorAll('.TiMu').length, secret:document.querySelectorAll('.font-cxsecret').length, styleHasSecret:[...document.querySelectorAll('style')].some(s=>(s.textContent||'').includes('font-cxsecret'))})`
);
console.log("[e2e] 页面就绪检查:", q);

console.log("[e2e] 注入垫片 + 产物 …");
console.log("[e2e] 注入返回:", await evaluate(fs.readFileSync(INJECT, "utf8")));

const t0 = Date.now();
let lastLog = "";
let done = false;
while (Date.now() - t0 < 14 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 6000));
  const state = await evaluate(`JSON.stringify({
    secretLeft: document.querySelectorAll('.font-cxsecret').length,
    answeredLogs: [...document.querySelectorAll('.nca-panel *')].map(e=>e.textContent).filter(t=>/第\\d+道题/.test(t||'')).length,
    unfinished: [...document.querySelectorAll('.TiMu')].filter(tm => ![...tm.querySelectorAll('[class*="before-after"]')].some(li => li.getAttribute('aria-checked')==='true' || /cur|active|checked|selected/i.test(li.className))).length,
    total: document.querySelectorAll('.TiMu').length,
    logs: [...document.querySelectorAll('.nca-panel *')].map(e=>e.textContent).filter(t=>t && t.length<70 && /\\d\\d:\\d\\d:\\d\\d/.test(t)).slice(-3),
    errors: (window.__errors||[]).slice(-3)
  })`);
  const s = JSON.parse(state);
  const line = (s.logs || []).join(" | ");
  if (line !== lastLog) { console.log("[e2e] " + line); lastLog = line; }
  if ((s.total > 0 && s.unfinished === 0) || /本轮答题完成/.test(line)) { console.log("[e2e] 全部题目已处理"); done = true; break; }
}
console.log("[e2e] done=" + done);

// 回填结果: 统计已勾选选项 + 截图
const summary = await evaluate(`JSON.stringify({
  selected: [...document.querySelectorAll('.TiMu')].map(tm => [...tm.querySelectorAll('[class*="before-after"]')].filter(li => li.getAttribute('aria-checked')==='true' || /cur|active|checked|selected/i.test(li.className)).map(li => (li.querySelector('.fl.after')||{}).textContent ? li.querySelector('.fl.after').textContent.trim().slice(0,20) : '?')),
  logs: [...document.querySelectorAll('.nca-panel *')].map(e=>e.textContent).filter(t=>t && t.length<70 && /\\d\\d:\\d\\d:\\d\\d/.test(t)).slice(-30),
  errors: (window.__errors||[])
})`);
console.log("[e2e] 结果摘要:", summary);
const shot = await send("Page.captureScreenshot", { format: "png" }, session);
fs.writeFileSync("tools/.cache/e2e-work-page.png", Buffer.from(shot.data, "base64"));
console.log("[e2e] 截图: tools/.cache/e2e-work-page.png");
ws.close();
process.exit(0);
