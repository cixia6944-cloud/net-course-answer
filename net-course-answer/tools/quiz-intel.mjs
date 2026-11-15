// 弹题(互动测验)情报提取: 从 HAR 里抠出 videojs-ext.min.js 并定位关键位置。
// 用法: node tools/quiz-intel.mjs <har路径>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 输出目录 = <项目根>\情报\api(按脚本位置推导, 跟着文件夹走)
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../一手侦察记录(未随仓库分发)");

const har = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const es = (har.log && har.log.entries) || [];
const pick = (re) =>
  es
    .filter((x) => re.test(x.request.url))
    .map((x) => ({ url: x.request.url, len: ((x.response.content && x.response.content.text) || "").length, t: (x.response.content && x.response.content.text) || "" }))
    .sort((a, b) => b.len - a.len)[0];

const ext = pick(/videojs-ext\.min\.js/);
if (!ext || ext.len < 1000) {
  console.log("没找到 videojs-ext.min.js 的响应体");
  process.exit(0);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, "videojs-ext.min.js");
fs.writeFileSync(outFile, ext.t, "utf8");
console.log(`videojs-ext.min.js: ${ext.len} B → ${outFile}`);

const t = ext.t;
const around = (kw, len = 420, before = 260) => {
  const i = t.indexOf(kw);
  if (i < 0) return console.log(`\n(未找到 ${kw})`);
  console.log(`\n── ${kw} ──\n` + t.slice(Math.max(0, i - before), i + len).replace(/\s+/g, " "));
};
around("interactiveQuestionCount");
around("corretTip1", 260, 160);

for (const re of [/getInteractive[A-Za-z]*/g, /interactiveQuiz[A-Za-z]*/g, /quizList[A-Za-z]*/g, /getQuestion[A-Za-z]*/g, /videoQuiz[A-Za-z]*/g, /Quiz[A-Za-z]{3,20}/g]) {
  const m = [...new Set(t.match(re) || [])].slice(0, 6);
  if (m.length) console.log(`\n匹配 ${re.source} → ${m.join(", ")}`);
}

const urlRe = /["'`](\/[A-Za-z0-9_/.-]{6,70})["'`]/g;
const urls = [...new Set([...t.matchAll(urlRe)].map((m) => m[1]))].filter((u) => /quiz|question|interactive|answer|job/i.test(u)).slice(0, 16);
console.log("\n候选接口路径:\n  " + (urls.length ? urls.join("\n  ") : "(无)"));

const cls = [...new Set([...t.matchAll(/class=\\?["']([^"'\\]{3,60})/g)].map((m) => m[1]))].filter((c) => /quiz|question|interactive|popup|mask|ti_/i.test(c)).slice(0, 18);
console.log("\n候选题层类名:\n  " + (cls.length ? cls.join("\n  ") : "(无)"));
