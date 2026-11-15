// 从 HAR 里抽出「API 层契约」: 请求清单 + 关键接口的响应体(离线可读)。
// 用法: node tools/har-extract.mjs <har路径> <输出目录> [名字]
// 注意: 路径要传 Windows 风格(C:/...), 因为跑在 Windows node 上。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 默认输出目录 = <项目根>\情报\api(按脚本位置推导, 跟着文件夹走)
const DEFAULT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../一手侦察记录(未随仓库分发)");

const harPath = process.argv[2];
const outDir = process.argv[3] || DEFAULT_OUT;
const tag = process.argv[4] || path.basename(harPath).replace(/\.har$/i, "");
if (!harPath) {
  console.log("用法: node tools/har-extract.mjs <har路径> [输出目录] [名字]");
  process.exit(1);
}
const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
const entries = (har.log && har.log.entries) || [];
fs.mkdirSync(outDir, { recursive: true });

/** 想要响应体的接口(正则) */
const WANT = [
  [/knowledge\/cards/i, "knowledge-cards"],
  [/studentstudyAjax/i, "studentstudyAjax"],
  [/studentstudycourselist/i, "studentstudycourselist"],
  [/ananas\/status/i, "ananas-status"],
  [/multimedia\/log/i, "multimedia-log"],
  [/modules\/video\/.*\.html|modules\/video\/index/i, "video-module-html"],
  [/getTeacherAjax|teacher/i, "teacherAjax"],
  [/work\/|doHomeWorkNew/i, "work"],
];

const list = [];
const saved = [];
for (const e of entries) {
  const url = e.request.url;
  const res = e.response || {};
  const mime = (res.content && res.content.mimeType) || "";
  const text = (res.content && res.content.text) || "";
  const short = url.replace(/^https?:\/\/[^/]+/, "");
  list.push(`${e.request.method}\t${res.status}\t${text.length}\t${mime.split(";")[0]}\t${short}`);
  for (const [re, name] of WANT) {
    if (!re.test(url)) continue;
    if (!text) continue;
    const f = path.join(outDir, `${tag}__${name}.txt`);
    const head = `// ${e.request.method} ${url}\n// status=${res.status} mime=${mime} len=${text.length}\n\n`;
    if (fs.existsSync(f)) continue; // 同一接口只留第一次
    fs.writeFileSync(f, head + text.slice(0, 400000), "utf8");
    saved.push(`${name} (${text.length} B) → ${path.basename(f)}`);
  }
}
fs.writeFileSync(path.join(outDir, `${tag}__请求清单.txt`), `共 ${entries.length} 条请求\nmethod\tstatus\tbodyLen\tmime\turl\n` + list.join("\n"), "utf8");
console.log(`请求清单 → ${tag}__请求清单.txt (${entries.length} 条)`);
if (saved.length) saved.forEach((s) => console.log("  抽取 " + s));
else console.log("  (没有匹配到关键接口)");
