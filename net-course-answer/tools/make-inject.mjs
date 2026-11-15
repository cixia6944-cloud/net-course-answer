#!/usr/bin/env node
// 生成「无油猴注入包」: 把 GM_* 垫片 + dist 产物 拼成一个可在页面里 eval 的脚本。
// GM_xmlhttpRequest 用 CDP binding(__ncaBridge) 转给 node 执行 —— 绕开浏览器 Local Network Access
// 对「公网页面 → 127.0.0.1」的限制(真实油猴环境用 GM_xmlhttpRequest, 不受此限)。
// 用法: node tools/make-inject.mjs [输出路径, 默认 tools/.cache/inject.js]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] || path.join(ROOT, "tools/.cache/inject.js");
const table = fs.readFileSync(path.join(ROOT, "tools/.cache/table.json"), "utf8");
const dist = fs.readFileSync(path.join(ROOT, "dist/net-course-answer.user.js"), "utf8");

const js = `(() => {
  window.__errors = window.__errors || [];
  window.addEventListener('error', e => window.__errors.push(String(e.message||e.error)));
  window.addEventListener('unhandledrejection', e => window.__errors.push('unhandledrejection: ' + String(e.reason)));
  window.__NCA_TTF = ${JSON.stringify(table)};
  window.GM_getResourceText = (n) => (n === 'ttf' ? window.__NCA_TTF : null);
  window.GM_getValue = (k, d) => { try { const v = localStorage.getItem('nca_' + k); return v === null ? d : v; } catch (e) { return d; } };
  window.GM_setValue = (k, v) => { try { localStorage.setItem('nca_' + k, v); } catch (e) {} };
  window.GM_addStyle = (css) => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); return s; };
  window.GM_info = { script: { name: 'net-course-answer (injected via CDP)', version: '0.1.0' } };
  window.__ncaPending = {};
  window.__ncaResolve = (id, text) => { const cb = window.__ncaPending[id]; if (cb) { delete window.__ncaPending[id]; cb(text); } };
  window.GM_xmlhttpRequest = (o) => {
    const id = 'r' + Math.random().toString(36).slice(2) + Date.now();
    window.__ncaPending[id] = (text) => { try { o.onload && o.onload({ responseText: text, status: 200, readyState: 4 }); } catch (e) { o.onerror && o.onerror(e); } };
    const payload = JSON.stringify({ id, url: o.url, method: o.method || 'GET', headers: o.headers || {}, body: o.data || null });
    if (typeof window.__ncaBridge === 'function') { window.__ncaBridge(payload); return; }
    // 没有 CDP binding(纯 agent-browser 冒烟) → 直接 fetch: 桥已发 Access-Control-Allow-Origin:*, 放行
    fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, body: o.data || undefined })
      .then(r => r.text()).then(t => window.__ncaResolve(id, t))
      .catch(() => window.__ncaResolve(id, ''));
  };
  window.unsafeWindow = window;
  const s = document.createElement('script');
  s.textContent = ${JSON.stringify(dist)};
  document.head.appendChild(s);
  return 'injected, bootstrap=' + typeof window.__NCA_BOOTSTRAP__;
})()`;
fs.writeFileSync(out, js, "utf8");
console.log(`已生成 ${out} (${Buffer.byteLength(js)} bytes)`);
