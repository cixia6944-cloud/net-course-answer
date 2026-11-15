#!/usr/bin/env node
// 测试/真机联调用的小型 CDP 客户端(零依赖, 用 node 自带 WebSocket)。
// 用途: 在没有装 Tampermonkey 的情况下驱动一个已开启 --remote-debugging-port 的 Edge/Chrome,
//       把油猴脚本 + GM_* 垫片注入页面, 做真实环境验证。
//
// 用法:
//   node tools/cdp.mjs <port> targets [urlFilter]
//   node tools/cdp.mjs <port> eval <file.js> [urlFilter]     # 在页面里执行文件(awaitPromise, 返回值打印)
//   node tools/cdp.mjs <port> grant-lna <origin>             # 尝试授予 Local Network Access 权限
//   node tools/cdp.mjs <port> navigate <url> [urlFilter]
import fs from "node:fs";

const [port, cmd, arg1, arg2] = process.argv.slice(2);
if (!port || !cmd) {
  console.error("usage: node tools/cdp.mjs <port> <targets|eval|grant-lna|navigate> [arg] [urlFilter]");
  process.exit(1);
}

async function browserWsUrl() {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const j = await res.json();
  return j.webSocketDebuggerUrl;
}

const ws = new WebSocket(await browserWsUrl());
let nextId = 1;
const pending = new Map();

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

/** 找到目标 page 并 attach, 返回 {sessionId, target} */
async function attachPage(urlFilter = "") {
  const { targetInfos } = await send("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page" && (!urlFilter || t.url.includes(urlFilter)));
  if (!pages.length) throw new Error(`no page target matching "${urlFilter}"; pages=${targetInfos.filter((t) => t.type === "page").map((t) => t.url.slice(0, 80)).join(" | ")}`);
  const target = pages[pages.length - 1];
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  return { sessionId, target };
}

async function evaluate(sessionId, expression) {
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId
  );
  if (r.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

if (cmd === "targets") {
  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos) console.log(t.type, "|", (t.title || "").slice(0, 40), "|", (t.url || "").slice(0, 120));
} else if (cmd === "grant-lna") {
  const origin = arg1 || "https://mooc1.chaoxing.com";
  for (const name of ["localNetworkAccess", "local-network-access", "privateNetworkAccess"]) {
    try {
      await send("Browser.grantPermissions", { origin, permissions: [name] });
      console.log(`✅ grantPermissions 成功: ${name} @ ${origin}`);
      break;
    } catch (e) {
      console.log(`✗ ${name}: ${e.message.slice(0, 120)}`);
    }
  }
} else if (cmd === "activate") {
  // 把标签页提到前台并解冻(后台标签会被 Chrome 冻结, 视频时钟不前进)
  const { sessionId, target } = await attachPage(arg1 || "");
  await send("Page.bringToFront", {}, sessionId);
  try {
    await send("Page.setWebLifecycleState", { state: "active" }, sessionId);
  } catch (e) {
    console.log("lifecycle:", e.message.slice(0, 100));
  }
  try {
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  } catch (e) {}
  const r = await evaluate(
    sessionId,
    `JSON.stringify({vis:document.visibilityState, hidden:document.hidden, t:(document.querySelector('video')||{}).currentTime, paused:(document.querySelector('video')||{}).paused})`
  );
  console.log("activated:", target.url.slice(0, 100), r);
} else if (cmd === "eval") {
  const { sessionId, target } = await attachPage(arg2 || "");
  console.error(`[cdp] 页面: ${target.url.slice(0, 100)}`);
  const value = await evaluate(sessionId, fs.readFileSync(arg1, "utf8"));
  console.log(typeof value === "string" ? value : JSON.stringify(value));
} else if (cmd === "navigate") {
  const { sessionId } = await attachPage(arg2 || "");
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: arg1 }, sessionId);
  console.log("navigating →", arg1);
} else {
  console.error("unknown cmd", cmd);
  process.exit(1);
}
ws.close();
process.exit(0);
