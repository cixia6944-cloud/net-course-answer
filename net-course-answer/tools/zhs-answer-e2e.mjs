// 智慧树练习页(weakTest)刷题联调 —— 用假桥验证「解析 → 取答案 → 填入」整条链路。
//   前置: 浏览器以 --remote-debugging-port=9222 启动并已登录智慧树; 已 node build.mjs && node tools/make-inject.mjs
//   做法: 把 GM_* 垫片 + 产物注入练习页; 用 CDP binding 截住 GM_xmlhttpRequest,
//         /health 返回 ok, /ask 返回题目里的前两个选项(只为验证「会点选项」, 不判断对错)。
//   红线: 只填不交 —— 不点「提交」。
//   用法: node tools/zhs-answer-e2e.mjs [port=9222] [urlFilter=weakTest]
import fs from "node:fs";

const PORT = Number(process.argv[2] || 9222);
const FILTER = process.argv[3] || "weakTest";
const INJECT = "tools/.cache/inject.js";

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
    let body = '{"ok":false,"error":"stub"}';
    if (/\/health/.test(req.url)) body = '{"ok":true}';
    else if (/\/ask/.test(req.url)) {
      let opts = [];
      try {
        opts = JSON.parse(req.body || "{}").options || [];
      } catch (e) {}
      body = JSON.stringify({ ok: true, answer: Array.isArray(opts) ? opts.slice(0, 2) : [] });
    }
    console.log(`[stub] ${req.method} ${req.url.split("30142")[1]} → ${body.slice(0, 90)}`);
    await send("Runtime.evaluate", { expression: `window.__ncaResolve(${JSON.stringify(req.id)}, ${JSON.stringify(body)})` }, session);
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
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, session);
  if (r.exceptionDetails) throw new Error("JS: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.filter((t) => t.type === "page" && t.url.includes(FILTER)).pop();
if (!page) throw new Error(`找不到 ${FILTER} 页面`);
session = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
await send("Runtime.enable", {}, session);
await send("Page.enable", {}, session);
await send("Runtime.addBinding", { name: "__ncaBridge" }, session);
console.log("[e2e] 页面:", page.url.slice(0, 110));
await send("Page.bringToFront", {}, session).catch(() => {});
await send("Page.setWebLifecycleState", { state: "active" }, session).catch(() => {});

console.log("[e2e] 重新加载 …");
await send("Page.navigate", { url: page.url }, session);
await new Promise((r) => setTimeout(r, 8000));
console.log("[e2e] 注入:", await evaluate(fs.readFileSync(INJECT, "utf8")));
await new Promise((r) => setTimeout(r, 2000));
// 记录实际点到的 label(诊断用)
await evaluate(`(() => {
  window.__clicks = [];
  const orig = HTMLLabelElement.prototype.click;
  HTMLLabelElement.prototype.click = function () {
    window.__clicks.push((this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24));
    return orig.call(this);
  };
  return 'wrapped';
})()`);

const click = async (sel, label) => {
  const r = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return 'missing'; b.click(); return 'clicked'; })()`);
  console.log(`[e2e] ${label}: ${r}`);
};
await click(".nca-parse", "① 解析");
await new Promise((r) => setTimeout(r, 2500));
await click(".nca-ask", "② 取答案");
await new Promise((r) => setTimeout(r, 4000));
await click(".nca-fill", "③ 填入");
await new Promise((r) => setTimeout(r, 2500));

const out = await evaluate(`JSON.stringify({
  qcount: (document.querySelector('.nca-q-count')||{}).textContent,
  logs: [...document.querySelectorAll('.nca-log > *')].map(e => (e.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(-10),
  checked: [...document.querySelectorAll('.question-preview li input')].map(i => i.checked),
  selected: [...document.querySelectorAll('.question-preview li')].filter(li => (li.querySelector('input')||{}).checked).map(li => ((li.querySelector('pre.preStyle')||{}).textContent||'').trim().slice(0, 30)),
  clicks: window.__clicks || [],
  submitted: document.body.innerText.includes('提交成功')
})`);
console.log("[e2e] 结果:", out);
ws.close();
process.exit(0);
