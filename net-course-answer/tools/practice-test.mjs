#!/usr/bin/env node
// AI陪练(自动化作答 + 判分记录)单测 —— node tools/practice-test.mjs
//
// 全程纯函数 + 迷你假 DOM, 不碰真页面、不联网、不写 GM。
// 覆盖: 路由识别 / 三个题型读题(用 2026-11-13 实测 DOM 结构) / 判分文本解析 /
//       答案归一(单选/多选/判断映射/填空) / 报告统计(跳过不计入分母) / 错题抽样 /
//       凭据过滤 / 面板契约类名。
globalThis.window = globalThis;
globalThis.document = globalThis.document || { readyState: "loading", body: null };
const { createAdapterForUrl } = await import("../src/adapters/index.js");
const { detectPracticePage, readQuestion, parseJudge, pickJudgeText, normalizeAnswer, createPracticeReport, reportAnswer, reportSkip, reportFail, practiceStats, samplePracticeForReview, formatPracticeSamples, practiceReportToJson, PRACTICE_FAIL_CODES } = await import("../src/core/practice.js");
const { Panel } = await import("../src/ui/panel.js");
const fs = await import("node:fs");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✅ " + msg);
  } else {
    fail++;
    console.log("  ❌ " + msg);
  }
};
const eq = (a, b, msg) => ok(a === b, `${msg}(实际 ${JSON.stringify(a)})`);

/* ------------------------------------------------------------------ *
 * 迷你假 DOM: 支持 tag / .class / [attr] / :not() 与后代组合
 * ------------------------------------------------------------------ */

function matchesCompound(el, comp) {
  const nots = [...comp.matchAll(/:not\(([^)]+)\)/g)].map((m) => m[1]);
  let rest = comp.replace(/:not\([^)]+\)/g, "");
  const tag = rest.match(/^[a-zA-Z][\w-]*/);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  rest = rest.slice(tag ? tag[0].length : 0);
  const tokens = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  for (const t of tokens) {
    if (t.startsWith(".")) {
      if (!el._classes.has(t.slice(1))) return false;
    } else {
      const m = t.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
      if (!m) return false;
      const actual = m[1] === "class" ? el.className : el.getAttribute(m[1]);
      const want = m[2] ?? m[3] ?? m[4];
      if (want === undefined) {
        if (actual == null) return false;
      } else if (String(actual) !== want) return false;
    }
  }
  for (const n of nots) if (matchesCompound(el, n)) return false;
  return true;
}

function matchesSelector(el, sel) {
  const groups = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
  return groups.some((group) => {
    const parts = group.split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    if (!matchesCompound(el, parts[parts.length - 1])) return false;
    let cur = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (cur && !matchesCompound(cur, parts[i])) cur = cur.parentElement;
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  });
}

class FakeEl {
  constructor(tag, { cls = "", text = "", attrs = {} } = {}) {
    this.tagName = String(tag).toUpperCase();
    this._classes = new Set(String(cls).split(/\s+/).filter(Boolean));
    this._text = text;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.clicked = 0;
  }
  get className() {
    return [...this._classes].join(" ");
  }
  set className(v) {
    this._classes = new Set(String(v || "").split(/\s+/).filter(Boolean));
  }
  getAttribute(name) {
    if (name === "class") return this.className || null;
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name, v) {
    this.attrs[name] = v;
  }
  append(...kids) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v == null ? "" : v);
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matchesSelector(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  click() {
    this.clicked += 1;
  }
  dispatchEvent() {
    return true;
  }
  addEventListener() {}
}

const el = (tag, cls, text, attrs) => new FakeEl(tag, { cls, text, attrs });

/** 造一道题(结构照 2026-11-13 真机) */
function makeQuestionDoc(typeName, stem, options) {
  const doc = el("div");
  const root = el("div", "questionDiv questionWrap");
  const title = el("div", "questionTitle");
  title.append(el("span", "fl questionTypeName fontBold", typeName));
  title.append(el("span", "fr redBorBtn unKnow", "不会"));
  title._text = stem; // 题干纯文本接在 .questionTitle 里
  root.append(title);
  const con = el("div", "questionCon marTop20");
  con._text = stem;
  root.append(con);
  const box = el("div", "questionOption marTop2");
  const ul = el("ul");
  for (const [key, text] of options) {
    const li = el("li", "clearfix marBom16");
    li.append(el("span", "fl", `${key}.`));
    li.append(el("div", "fl", text));
    ul.append(li);
  }
  box.append(ul);
  root.append(box);
  doc.append(root);
  return doc;
}

/* ---------------------------------------------------------------- 路由 */

console.log("路由识别");
{
  ok(detectPracticePage("https://mooc2-ans.chaoxing.com/mooc2-ans/qbank-ai/aiPracticeAssistant?courseid=1"), "detectPracticePage 认出陪练页");
  ok(!detectPracticePage("https://mooc2-ans.chaoxing.com/mooc2-ans/coursemanagev3/stu-base-info"), "别把别的超星页认成陪练页");
  const r = createAdapterForUrl("https://mooc2-ans.chaoxing.com/mooc2-ans/qbank-ai/aiPracticeAssistant?courseid=100000005&clazzid=100000003");
  eq(r && r.workType, "practice", "路由表给 workType=practice");
  eq(r && r.platform, "cx", "路由表 platform=cx");
  ok(r && r.makeHandler && r.makeHandler() === null, "陪练页不套答题适配器(makeHandler 返回 null)");
}

/* ---------------------------------------------------------------- 读题 */

console.log("readQuestion");
{
  const doc = makeQuestionDoc("单选题", "某初创新能源汽车企业原本可将一笔10亿元资金投向A项目，下列说法正确的是（ ）", [
    ["A", "机会成本是放弃掉的A项目的收益"],
    ["B", "机会成本等于会计成本"],
    ["C", "沉没成本应计入决策"],
    ["D", "以上都不对"],
  ]);
  const q = readQuestion(doc);
  ok(q.ok, "单选题读得出来");
  eq(q.type, "single", "题型=单选题 → single");
  ok(q.stem.includes("某初创新能源汽车企业") && !q.stem.includes("单选题") && !q.stem.includes("不会"), "题干去掉了题型名和「不会」");
  eq(q.options.length, 4, "四个选项");
  eq(q.options[0].key, "A", "选项序号从 span.fl 取(A.)");
  ok(q.options[0].text.includes("机会成本"), "选项正文从 div.fl 取");
  ok(!/^[A-D][.．]/.test(q.options[2].text), "选项正文不带编号前缀");

  const multi = readQuestion(makeQuestionDoc("多选题", "下列属于固定成本的有（ ）", [["A", "厂房租金"], ["B", "原材料"], ["C", "设备折旧"]]));
  eq(multi.type, "multi", "题型=多选题 → multi");
  eq(multi.options.length, 3, "多选题三个选项");

  const judge = readQuestion(makeQuestionDoc("判断题", "需求曲线总是向右下方倾斜。", [["A", "正确"], ["B", "错误"]]));
  eq(judge.type, "judge", "题型=判断题 → judge");
  eq(judge.options[1].key, "B", "判断题选项号 B");

  ok(!readQuestion(el("div")).ok, "空页面 → ok:false");
  eq(readQuestion(el("div")).reason, "no-question", "空页面原因码 no-question");
}

/* ---------------------------------------------------------------- 判分 */

console.log("parseJudge");
{
  const right = parseJudge("你的答案是正确的，很棒！\n正确答案:B\n答案解析 机会成本是放弃的最高价值选项。\n疑问 您是否有理解的地方？继续 / 结束陪练");
  eq(right.result, "right", "「你的答案是正确的」→ right");
  eq(right.correct, "B", "正确答案:B → B");
  ok(right.analysis.includes("机会成本") && !right.analysis.includes("疑问"), "解析取到「疑问」之前");

  const wrong = parseJudge("你的答案是错误的\n正确答案:AC\n答案解析 多选要全选对。");
  eq(wrong.result, "wrong", "「你的答案是错误的」→ wrong");
  eq(wrong.correct, "AC", "正确答案:AC → AC");

  const none = parseJudge("请在输入框输入你的答案并发送");
  eq(none.result, "unknown", "没有判分词 → unknown(不猜成 wrong)");
  eq(none.correct, "", "没有正确答案 → correct 空");

  const tf = parseJudge("正确答案:对");
  eq(tf.result, "unknown", "只有「正确答案」时正误仍 unknown");
  eq(tf.correct, "对", "判断题参考答案保留「对」");
}

/* ---------------------------------------------------------------- 判分去重 */
/*
 * 真机回归(2026-11-13): 判分挂在 .aiAnswertCon_white, 不在 .questionDiv 里;
 * 而且答完会一直留在页面上。原来按「整页文本变长」判断 → 5 题 5 次 no-judge。
 */
console.log("pickJudgeText");
{
  const seen = new Set();
  const first = "你的答案是正确的，很棒！ 正确答案:B 答案解析 生产要素分四类。";
  const second = "你的答案是错误的 正确答案:A 答案解析 机会成本只算最高的替代。";

  eq(pickJudgeText([], seen), "", "没有候选 → 空串");
  eq(pickJudgeText(["请在输入框输入你的答案并发送"], seen), "", "不含判分词 → 跳过");
  eq(pickJudgeText(["   ", first], seen), first, "空白候选跳过, 取到判分");
  eq(pickJudgeText([first, second], seen), second, "同一段判分只认一次(旧判分不会重复消费)");
  ok(seen.has(first) && seen.has(second), "命中的判分被记进 seen");
  eq(pickJudgeText([first, second], seen), "", "全都消费过 → 空串(等下一题新判分)");
}

/* ---------------------------------------------------------------- 归一 */

console.log("normalizeAnswer");
{
  const opts = [
    { key: "A", text: "正确" },
    { key: "B", text: "错误" },
  ];
  eq(normalizeAnswer("B。", "single", opts), "B", "单选「B。」→ B");
  eq(normalizeAnswer("答案：c", "single", opts), "C", "单选去「答案：」前缀并大写");
  eq(normalizeAnswer("B,D,A", "multi", opts), "ABD", "多选「B,D,A」→ 去重排序 ABD");
  eq(normalizeAnswer("b b d", "multi", opts), "BD", "多选重复字母去重");
  eq(normalizeAnswer("A", "judge", opts), "对", "判断题回 A 按选项正文映射成 对");
  eq(normalizeAnswer("b", "judge", opts), "错", "判断题回 B 按选项正文映射成 错");
  eq(normalizeAnswer("错", "judge", opts), "错", "判断题回「错」原样");
  eq(normalizeAnswer("答案：机会成本", "fill", []), "机会成本", "填空去「答案：」前缀");
  eq(normalizeAnswer("价格\n数量", "fill", []), "价格|数量", "填空按空顺序用 | 连起来");
  eq(normalizeAnswer("答案：“边际效用递减”", "essay", []), "边际效用递减", "主观题去前缀与引号");
}

/* ---------------------------------------------------------------- 报告 */

console.log("run 报告");
{
  const rep = createPracticeReport({ startedAt: 1000, direction: "机会成本", maxQuestions: 10, mode: "confirm" });
  reportAnswer(rep, { index: 1, type: "single", stem: "第一题", answer: "B", correct: "B", result: "right" });
  reportAnswer(rep, { index: 2, type: "multi", stem: "第二题", answer: "AB", correct: "ABC", result: "wrong" });
  reportAnswer(rep, { index: 3, type: "judge", stem: "第三题", answer: "对", result: "unknown" });
  reportSkip(rep, { index: 4, type: "single", stem: "第四题" });
  reportFail(rep, { index: 5, reasonCode: "no-judge", reason: "45s 超时" });

  const st = practiceStats(rep);
  eq(st.answered, 3, "答过 3 题");
  eq(st.right, 1, "正确 1");
  eq(st.wrong, 1, "错误 1");
  eq(st.unknown, 1, "判不出 1");
  eq(st.skipped, 1, "跳过 1");
  eq(st.graded, 2, "分母只算判出对错的(2)");
  eq(st.accuracy, 50, "正确率 50%");
  eq(rep.failed[0].reasonCode, "no-judge", "失败原因码原样记下");
  eq(practiceStats(createPracticeReport({})).accuracy, 0, "空报告正确率 0 不崩");

  ok(PRACTICE_FAIL_CODES.includes("bridge-fail"), "原因码白名单含 bridge-fail");
  const bad = reportFail(rep, { reasonCode: "乱写" });
  eq(bad.reasonCode, "no-question", "不在白名单的原因码归 no-question");

  // 抽样: 10 道错题 → 抽 1/5 = 2 道, 等距
  const rep2 = createPracticeReport({});
  for (let i = 1; i <= 10; i++) reportAnswer(rep2, { index: i, type: "single", stem: `错题${i}`, answer: "A", correct: "B", result: "wrong" });
  for (let i = 11; i <= 12; i++) reportAnswer(rep2, { index: i, type: "single", stem: `对题${i}`, answer: "A", correct: "A", result: "right" });
  const picked = samplePracticeForReview(rep2);
  eq(picked.length, 2, "10 道错题抽 1/5 = 2 道");
  ok(picked.every((r) => r.result === "wrong"), "只抽错题");
  ok(formatPracticeSamples(picked).includes("我的答案"), "抽样文本含「我的答案」");
  eq(samplePracticeForReview(createPracticeReport({})).length, 0, "没有错题 → 空数组");

  // 凭据过滤: 报告里塞 cpi/cookie 也不许导出去
  const leaky = createPracticeReport({});
  leaky.cpi = "100000001";
  leaky.cookie = "a=b";
  leaky.answers.push({ index: 1, stem: "题", answer: "A", correct: "A", result: "right", cpi: "1", enc: "x" });
  const json = practiceReportToJson(leaky);
  ok(!/"cpi"|"cookie"|"enc"/.test(json), "导出 JSON 去掉 cpi/cookie/enc 键");
  ok(json.includes('"answers"'), "导出 JSON 仍保留 answers");
}

/* ---------------------------------------------------------------- 面板契约 */

console.log("面板契约");
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = fs.readFileSync(path.join(ROOT, "src/ui/panel.js"), "utf8");
  for (const cls of [
    "nca-practice-status",
    "nca-practice-direction",
    "nca-practice-weak",
    "nca-practice-clear",
    "nca-practice-max",
    "nca-practice-mode",
    "nca-practice-start",
    "nca-practice-stop",
    "nca-practice-skip",
    "nca-practice-send",
    "nca-practice-progress",
    "nca-practice-stats",
    "nca-practice-items",
    "nca-practice-report",
    "nca-practice-sample",
    "nca-practice-export-text",
    "nca-practice-count",
  ]) {
    ok(src.includes(cls), `面板含 .${cls}`);
  }
  ok(/data-pane="practice"/.test(src) && /data-pane-body="practice"/.test(src), "「AI陪练」页签与面板都挂上了");
  for (const m of ["getPracticeConfig", "setPracticeStatus", "setPracticeRunning", "setPracticeProgress", "setPracticeStats", "setPracticePoints", "showPracticeCurrent", "clearPracticeCurrent", "resetPracticeItems", "renderPracticeItem", "showPracticeExport", "setPracticeDirection"]) {
    ok(typeof Panel.prototype[m] === "function", `Panel 实现 ${m}`);
  }
  const p = new Panel({ log: () => {} });
  const thrown = [];
  for (const [name, args] of [
    ["setPracticeStatus", ["未开始", false]],
    ["setPracticeRunning", [true]],
    ["setPracticeProgress", [1, 10, "第 1 题"]],
    ["setPracticeStats", [{ right: 1, wrong: 0, skipped: 0, graded: 1, accuracy: 100 }, 1]],
    ["setPracticePoints", [3]],
    ["showPracticeCurrent", [{ index: 1, type: "single", stem: "题", options: [] }]],
    ["clearPracticeCurrent", []],
    ["resetPracticeItems", []],
    ["renderPracticeItem", [{ index: 1, stem: "题", answer: "A", correct: "B", result: "wrong" }]],
    ["showPracticeExport", ["{}", ""]],
    ["setPracticeDirection", ["x"]],
  ]) {
    try {
      Panel.prototype[name].apply(p, args);
    } catch (e) {
      thrown.push(`${name}: ${e.message}`);
    }
  }
  ok(thrown.length === 0, `未挂载时 AI陪练方法不抛异常${thrown.length ? " —— " + thrown.join(" | ") : ""}`);
  const cfg = p.getPracticeConfig();
  eq(cfg.maxQuestions, 10, "未挂载时默认最多 10 题");
  eq(cfg.mode, "confirm", "未挂载时默认逐题确认");
}

console.log(`\n${fail ? "❌" : "✅"} 全部通过: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
