#!/usr/bin/env node
// 本地静态服务器: 给"无登录态冒烟测试"提供页面/产物/ESM 源码(仅监听 127.0.0.1)。
// 用法: node tools/serve-fixture.mjs [port]
//   GET /                        → tools/fixtures/mock-homework.html(模拟答题页)
//   GET /dist/...                → 构建产物(可被 <script src> 注入)
//   GET /src/...                 → ESM 源码
//   GET /tools/fixtures/...      → 测试用字体/脚本
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 30145);
const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".css": "text/css",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = url === "/" ? "tools/fixtures/mock-homework.html" : url.replace(/^\//, "");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("404");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`));
