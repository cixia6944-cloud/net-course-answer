// 在 HAR 的 JS/HTML 响应体里搜关键字(定位弹题/接口实现)。用法: node tools/har-grep.mjs <har> <正则> [最多打印条数]
import fs from "node:fs";
const har = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const re = new RegExp(process.argv[3] || "quiz", "i");
const max = Number(process.argv[4] || 14);
const es = (har.log && har.log.entries) || [];
let printed = 0;
const perFile = new Map();
for (const e of es) {
  const url = e.request.url;
  if (!/\.js|\.html|\.css|json/.test(url)) continue;
  const text = (e.response && e.response.content && e.response.content.text) || "";
  if (!text) continue;
  const short = url.replace(/^https?:\/\/[^/]+/, "");
  let m;
  const grep = new RegExp(re.source, "gi");
  while ((m = grep.exec(text))) {
    if (printed >= max) break;
    const cnt = perFile.get(short) || 0;
    if (cnt >= 3) continue;
    perFile.set(short, cnt + 1);
    printed++;
    const s = Math.max(0, m.index - 110);
    console.log(`\n[${short.slice(0, 80)}] …${text.slice(s, m.index + 150).replace(/\s+/g, " ")}…`);
  }
  if (printed >= max) break;
}
console.log(`\n共打印 ${printed} 处匹配`);
