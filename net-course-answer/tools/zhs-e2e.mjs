// 智慧树真机联调(无需装油猴):
//   前置: 浏览器以 --remote-debugging-port=9222 + 独立 user-data-dir 启动并已登录智慧树
//        node build.mjs && node tools/make-inject.mjs
//   做法: 常驻轮询所有智慧树页面, 没装过就注入「GM_* 垫片 + 构建产物」；
//        页面跳转后脚本会丢, 这里补注入 —— 相当于 Tampermonkey 的 @match 重注入。
//        脚本自己按 localStorage 的 auto 标志接力刷课, 本工具只负责注入与观察。
//   用法: node tools/zhs-e2e.mjs [port=9222] [maxDone=1] [timeoutMin=20]
//   退出: 状态里确认完成的单元数达到 maxDone（点「停止刷课」收尾）, 或超时。
import fs from "node:fs";

const PORT = Number(process.argv[2] || 9222);
const MAX_DONE = Number(process.argv[3] || 1);
const TIMEOUT_MIN = Number(process.argv[4] || 20);
const INJECT = "tools/.cache/inject.js";
const HOST = "ai-smart-course-student-pro.zhihuishu.com";
const WATCH = /(knowledgeStudy|learnPage|weakTest)/;

const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
function send(method, params = {}, sid) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
}
async function evaluate(sid, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error("JS: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const injectSrc = fs.readFileSync(INJECT, "utf8");
const sessions = new Map(); // targetId -> sessionId
const t0 = Date.now();
const limitMs = TIMEOUT_MIN * 60 * 1000;
let lastLog = "";

// 只点「开始刷课」；按钮已是「停止刷课」时绝不动它。
// 只在目录页点：weakTest / learnPage 上也有同一个面板按钮，点了会把刷课状态搅进来。
const START_JS = `(() => {
  if (!location.pathname.includes('/singleCourse/knowledgeStudy/')) return 'not-catalog';
  const btn = document.querySelector('.nca-course');
  if (!btn) return 'no-panel';
  if (!btn.textContent.includes('开始')) return 'already';
  const tab = document.querySelector('.nca-tab[data-pane=course]');
  if (tab && !tab.classList.contains('active')) tab.click();
  btn.click();
  return 'clicked';
})()`;

const STATE_JS = `JSON.stringify((() => {
  const v = document.querySelector('.vjs-tech');
  const q = (s) => { const e = document.querySelector(s); return e ? (e.textContent||'').trim() : ''; };
  let st = {};
  try { st = JSON.parse(localStorage.getItem('nca.zhsCourse.v2') || '{}'); } catch (e) {}
  return {
    url: location.pathname,
    video: v ? { t: Math.round(v.currentTime), dur: Math.round(v.duration), paused: v.paused, rate: v.playbackRate, ended: v.ended } : null,
    state: q('.nca-course-state'), progress: q('.nca-course-progress'),
    done: Array.isArray(st.done) ? st.done.length : 0,
    skipped: Array.isArray(st.skipped) ? st.skipped.length : 0,
    auto: !!st.auto,
    logs: [...document.querySelectorAll('.nca-log *')].map(e => e.textContent).filter(t => t && t.length < 90).slice(-3)
  };
})())`;

while (Date.now() - t0 < limitMs) {
  const { targetInfos } = await send("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page" && t.url.includes(HOST) && WATCH.test(t.url));
  for (const p of pages) {
    try {
      if (!sessions.has(p.targetId)) {
        const { sessionId } = await send("Target.attachToTarget", { targetId: p.targetId, flatten: true });
        sessions.set(p.targetId, sessionId);
        // 后台标签会被 Chrome 冻结, 视频时钟不前进 —— 提前台并解冻
        await send("Page.bringToFront", {}, sessionId).catch(() => {});
        await send("Page.setWebLifecycleState", { state: "active" }, sessionId).catch(() => {});
        // 站点还看 document.hasFocus(): 没有焦点时它会自己暂停, play() 后几秒又暂停。
        // 2026-11-09 真机: 只 setWebLifecycleState 时 t 卡在 1837 不动, 加上 focus 模拟才继续走。
        await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
      }
      const sid = sessions.get(p.targetId);
      await send("Page.setWebLifecycleState", { state: "active" }, sid).catch(() => {});
      const installed = await evaluate(sid, "!!window.__NCA_BOOTSTRAP__");
      if (!installed) {
        await evaluate(sid, injectSrc);
        await new Promise((r) => setTimeout(r, 1500));
        console.log(`[inject] ${p.url.slice(0, 96)} → ${await evaluate(sid, START_JS)}`);
      } else {
        const how = await evaluate(sid, START_JS);
        if (how === "clicked") console.log(`[start] ${p.url.slice(0, 96)}`);
      }
      const raw = await evaluate(sid, STATE_JS);
      const s = JSON.parse(raw);
      const v = s.video;
      const line = v
        ? `${s.url} | ${s.state} | ${v.t}/${v.dur}s ${v.ended ? "ENDED" : v.paused ? "PAUSED" : "play@" + v.rate + "x"} | done=${s.done} skipped=${s.skipped} | ${s.progress}`
        : `${s.url} | ${s.state} | done=${s.done} skipped=${s.skipped} | ${s.progress}`;
      if (line !== lastLog) {
        console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
        if (s.logs.length) console.log("        " + s.logs.join(" | "));
        lastLog = line;
      }
      if (s.done >= MAX_DONE) {
        const how = await evaluate(sid, `(() => {
          const btn = document.querySelector('.nca-course');
          if (btn && btn.textContent.includes('停止')) { btn.click(); return 'stopped'; }
          const k = 'nca.zhsCourse.v2';
          const st = JSON.parse(localStorage.getItem(k) || '{}');
          st.auto = false; localStorage.setItem(k, JSON.stringify(st));
          return 'auto=false';
        })()`);
        console.log(`[done] 已确认完成 ${s.done} 个单元（跳过 ${s.skipped}），收尾=${how}`);
        ws.close();
        process.exit(0);
      }
    } catch (e) {
      console.log("[warn]", String((e && e.message) || e).slice(0, 160));
      sessions.delete(p.targetId);
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(`[timeout] ${TIMEOUT_MIN} 分钟未达到 ${MAX_DONE} 个完成单元`);
ws.close();
process.exit(1);
