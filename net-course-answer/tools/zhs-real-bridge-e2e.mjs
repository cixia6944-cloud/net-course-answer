// 智慧树刷题 · 真桥端到端联调（v0.6.1）
//
// 前置:
//   - Edge 以 --remote-debugging-port=9222 启动, 已登录智慧树, 并停在 weakTest 练习页
//   - 真桥已在 127.0.0.1:30142 起来(它要能 spawn `pi --mode rpc`; DSH 沙箱 workspace-write 下会 EPERM)
//   - 已 node build.mjs && node tools/make-inject.mjs
//
// 做什么:
//   重载练习页 → 装 GM_xmlhttpRequest → CDP binding 转发到真桥 → 注入注入包 →
//   ① 解析 → ② 取答案(真 pi) → 手动勾上 A 制造残留 → ③ 填入 →
//   断言: A 被清掉、答案项被勾上、没有点提交。只填不交。
//
// 用法: node tools/zhs-real-bridge-e2e.mjs [9222] [weakTest]
import fs from "node:fs";

const PORT = Number(process.argv[2] || 9222);
const FILTER = process.argv[3] || "weakTest";
const BRIDGE = "http://127.0.0.1:30142";
const INJECT = "tools/.cache/inject.js";

const health = await fetch(`${BRIDGE}/health`).then((r) => r.json()).catch(() => null);
if (!health || !health.ok) {
  console.error(`[e2e] 真桥没起或不可用: ${BRIDGE}/health`);
  process.exit(2);
}

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
    const req = (() => { try { return JSON.parse(m.params.payload) } catch (e) { return { url: "/", id: "" } } })();
    let text = JSON.stringify({ ok: false, error: "proxy-failed" });
    try {
      const path = String(req.url || "").replace(/^https?:\/\/127\.0\.0\.1:30142/, "") || "/";
      const init = { method: req.method || "GET" };
      if (req.headers) init.headers = req.headers;
      if (req.body !== undefined && req.body !== null) init.body = req.body;
      const r = await fetch(BRIDGE + path, init);
      text = await r.text();
      console.log(`[bridge] ${init.method} ${path} → ${r.status} ${text.slice(0, 200)}`);
    } catch (e) {
      text = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
      console.log("[bridge] error", text);
    }
    await send("Runtime.evaluate", { expression: `window.__ncaResolve(${JSON.stringify(req.id)}, ${JSON.stringify(text)})` }, session).catch(() => {});
  }
});
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.filter((t) => t.type === "page" && t.url.includes(FILTER)).pop();
if (!page) throw new Error(`找不到 ${FILTER} 页面`);
session = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
await send("Runtime.enable", {}, session);
await send("Page.enable", {}, session);
await send("Runtime.addBinding", { name: "__ncaBridge" }, session);
await send("Page.bringToFront", {}, session).catch(() => {});
await send("Page.setWebLifecycleState", { state: "active" }, session).catch(() => {});
await send("Emulation.setFocusEmulationEnabled", { enabled: true }, session).catch(() => {});

const url = page.url;
console.log("[e2e] 重载:", url.slice(0, 110));
await send("Page.navigate", { url }, session);
await sleep(9000);
console.log("[e2e] 装 GM 桥:", await evaluate(`(() => {
  if (window.__ncaInstalled) return 'already'; window.__ncaInstalled = true;
  const pending = new Map(); let n = 0;
  window.__ncaResolve = (id, text) => { const p = pending.get(id); if (!p) return 'no-pending'; pending.delete(id);
    try { const r = JSON.parse(text); if (r && r.ok === false) { p.onerror && p.onerror(r); } else { p.onload && p.onload({ status: 200, responseText: text }); } }
    catch (e) { p.onerror && p.onerror(e); } return 'ok'; };
  window.GM_xmlhttpRequest = (opts) => { const id = String(++n); pending.set(id, opts);
    window.__ncaBridge(JSON.stringify({ id, url: opts.url, method: opts.method || 'GET', headers: opts.headers, body: opts.data })); return { abort() {} }; };
  return 'ok';
})()`));
// weakTest 是异步拉题的, 注入前先等题目出现
for (let i = 0; i < 10; i++) {
  if (await evaluate(`document.querySelectorAll('.question-preview').length`)) break;
  await sleep(2000);
}
console.log("[e2e] 注入:", await evaluate(fs.readFileSync(INJECT, "utf8")));
await sleep(2000);

// 页面可能有两个面板(注入包自举 + 手动注入), 一律取最后一个
const snap = async () => JSON.parse(await evaluate(`(() => {
  const panels = [...document.querySelectorAll('.nca-panel')]; const root = panels[panels.length - 1] || document;
  const q = root.querySelector('.nca-q-count');
  const opts = [...document.querySelectorAll('ul.checkbox-view li, ul.radio-view li')].map(li => {
    const i = li.querySelector('input'); const lab = li.querySelector('.el-checkbox__label, .el-radio__label'); const pre = li.querySelector('pre.preStyle');
    return { text: ((lab && lab.textContent) || '').trim() + ' ' + ((pre && pre.textContent) || '').trim().slice(0, 24), checked: !!(i && i.checked) };
  });
  const logs = [...root.querySelectorAll('.nca-log *')].map(e => (e.textContent || '').trim()).filter(t => t && t.length < 160).slice(-6);
  return JSON.stringify({ panels: panels.length, qcount: q ? q.textContent.trim() : '', logs, opts });
})()`));
const clickLast = async (sel) => evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(sel)})]; const b = all[all.length - 1]; if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()`);
const waitFor = async (label, pred, seconds) => {
  for (let i = 0; i < Math.ceil(seconds / 3); i++) {
    await sleep(3000);
    const s = await snap();
    if (pred(s)) return s;
    if (i % 4 === 0) console.log(`[e2e] ${label}… ${(i + 1) * 3}s ${JSON.stringify(s.logs.slice(-1))}`);
  }
  return undefined;
};

console.log("[e2e] ① 解析:", await clickLast(".nca-parse"));
let s = await waitFor("解析", (x) => x.logs.some((t) => /解析完成: [1-9]\d* 题/.test(t)), 40);
if (!s) { console.log("[e2e] FAIL 解析超时"); ws.close(); process.exit(1); }
console.log("[e2e] 解析 ok:", s.qcount);

console.log("[e2e] ② 取答案:", await clickLast(".nca-ask"));
s = await waitFor("等答案", (x) => x.logs.some((t) => /拿到答案|取答案失败|超时/.test(t)), 150);
if (!s) { console.log("[e2e] FAIL 等答案超时"); ws.close(); process.exit(1); }
console.log("[e2e] 答案 ok:", JSON.stringify(s.logs.slice(-2)));

console.log("[e2e] 先手动勾 A(制造残留):", await evaluate(`(() => { const li = document.querySelector('ul.checkbox-view li, ul.radio-view li'); (li.querySelector('label') || li).click(); return 'clicked'; })()`));
await sleep(700);
const pre = await snap();
console.log("[e2e] 勾 A 后:", JSON.stringify(pre.opts));

console.log("[e2e] ③ 填入:", await clickLast(".nca-fill"));
await sleep(6000);
const out = await snap();
console.log("[e2e] 最终:", JSON.stringify(out, null, 2));

const letters = Object.fromEntries(out.opts.map((o) => [o.text.trim()[0], o.checked]));
const checkedCount = out.opts.filter((o) => o.checked).length;
const noSubmit = !/提交成功|已提交/.test(out.logs.join(" "));
const pass = letters.A === false && checkedCount >= 1 && noSubmit && out.logs.some((t) => /填入完成/.test(t));
console.log(pass ? "[e2e] PASS 残留 A 已清、答案项已勾、未提交" : "[e2e] FAIL 见上面的选项与日志");
ws.close();
process.exit(pass ? 0 : 1);
