// 采集产物归一化: agent-browser eval 回来的是"JSON 字符串"(里面还有一层转义),
// 这里剥掉外层, 存成正常 JSON。用法: node tools/collect-normalize.mjs <文件>
import fs from "node:fs";

const p = process.argv[2];
if (!p) process.exit(0);
let s;
try {
  s = fs.readFileSync(p, "utf8").trim();
} catch (e) {
  process.exit(0);
}
if (!s) process.exit(0);
const tryParse = (t) => {
  try {
    return JSON.parse(t);
  } catch (e) {
    return undefined;
  }
};
let v = tryParse(s);
if (typeof v === "string") {
  const inner = tryParse(v);
  if (inner !== undefined) v = inner;
}
if (v !== undefined) {
  fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v, null, 1), "utf8");
  console.log(`[归一化] ${p}`);
} else {
  console.log(`[归一化] 跳过(不是 JSON): ${p}`);
}
