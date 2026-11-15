// AI陪练(超星 qbank-ai/aiPracticeAssistant)的纯逻辑:
//   读页面题目 / 判分解析 / 答案归一 / run 报告 / 错题抽样。
// 不碰网络、不碰 UEditor、不碰定时器 —— 那些在 runtime.js 的 setupPractice 里,
// 这里能在 node 里直接跑单测(见 tools/practice-test.mjs)。
//
// 页面结构依据: 2026-11-13 真机侦察(见 一手侦察记录(未随仓库分发))。
//   .questionDiv.questionWrap
//     .questionTitle > span.fl.questionTypeName(题型文本) + span.fr.redBorBtn.unKnow(不会) + 题干文本
//     .questionOption.marTop2 > ul > li.clearfix > span.fl("A.") + div.fl(选项正文)
// 判分不是 .answerRight/.answerWrong, 而是聊天式纯文本: 「你的答案是正确的，很棒！」+「正确答案:B」+「答案解析 …」。

import { normalizeJudgementText } from "./text.js";

/** 页面路径判据(超星 AI陪练页) */
export const PRACTICE_PATH = "/qbank-ai/aiPracticeAssistant";

/** 题型记号: 面板/桥都用这套字符串, 不用 0.2.4 的数字码(那边是另一条链路) */
export const PRACTICE_TYPES = ["single", "multi", "judge", "fill", "essay", "unknown"];

/** 失败原因码(白名单: 报告里只允许这几种, 排障时按码 grep) */
export const PRACTICE_FAIL_CODES = ["no-question", "no-judge", "send-fail", "bridge-fail", "stopped", "reach-limit"];

/** URL 是不是 AI陪练页 */
export function detectPracticePage(url) {
  return String(url || "").includes(PRACTICE_PATH);
}

function textOf(node) {
  return node && node.textContent != null ? String(node.textContent).replace(/\s+/g, " ").trim() : "";
}

/** 题型文本 → 记号:「单选题」→ single; 认不出就 unknown(不猜) */
export function normalizePracticeType(typeText) {
  const t = String(typeText || "");
  if (/多选/.test(t)) return "multi";
  if (/单选/.test(t)) return "single";
  if (/判断/.test(t)) return "judge";
  if (/填空/.test(t)) return "fill";
  if (/简答|主观|问答|论述/.test(t)) return "essay";
  return "unknown";
}

/**
 * 读当前这道题。
 * @returns {{ok:true,type:string,stem:string,options:Array<{key:string,text:string}>,key:string}
 *          |{ok:false,reason:"no-question"}}
 */
export function readQuestion(doc) {
  if (!doc || typeof doc.querySelector !== "function") return { ok: false, reason: "no-question" };
  const root = doc.querySelector(".questionDiv.questionWrap") || doc.querySelector(".questionDiv");
  if (!root) return { ok: false, reason: "no-question" };

  const title = root.querySelector(".questionTitle");
  const typeText = textOf(title && title.querySelector(".questionTypeName"));
  let stem = textOf(title);
  if (typeText) stem = stem.replace(typeText, " ");
  stem = stem.replace(/不会/g, " ").replace(/\s+/g, " ").trim();
  if (!stem) {
    // 有的版式题干挂在 .questionCon 里; 取它再减掉题型名, 避免两处重复
    let con = textOf(root.querySelector(".questionCon"));
    if (typeText) con = con.replace(typeText, " ");
    stem = con.replace(/不会/g, " ").replace(/\s+/g, " ").trim();
  }

  const options = [];
  const lis = root.querySelectorAll(".questionOption li.clearfix");
  for (let i = 0; i < lis.length; i++) {
    const li = lis[i];
    const keyText = textOf(li.querySelector("span.fl"));
    const m = keyText.match(/^([A-Za-z])/) || keyText.match(/([A-Za-z])\s*[.．、:：]/);
    const key = m ? m[1].toUpperCase() : String.fromCharCode(65 + i);
    let body = textOf(li.querySelector("div.fl"));
    if (!body) {
      body = textOf(li);
      if (keyText) body = body.replace(keyText, " ").replace(/\s+/g, " ").trim();
    }
    options.push({ key, text: body });
  }

  if (!stem && !options.length) return { ok: false, reason: "no-question" };
  const type = normalizePracticeType(typeText);
  return { ok: true, type, stem, options, key: stem + "|" + options.map((o) => o.key + o.text).join("|") };
}

/**
 * 从页面候选文本里挑出「这一题」的判分。
 *
 * 2026-11-13 真机踩过的坑: 判分 DOM 挂在 `.aiAnswertCon_white`, 不在 `.questionDiv` 里;
 * 而且它答完会一直留在页面上(下一题还看得见), 所以不能只看「文本变长了」——
 * 必须按内容去重: 调用方每轮持有一个 seen 集合, 只认没见过的新判分。
 *
 * @param {string[]} candidates 页面上所有可能含判分的文本(通常是每个 .aiAnswertCon_white)
 * @param {Set<string>} seen 本轮已经消费过的判分文本; 命中会被加进去
 * @returns {string} 新判分文本; 没有则空串
 */
export function pickJudgeText(candidates, seen) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (const raw of list) {
    const t = String(raw || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    // 「请在输入框输入你的答案并发送」这种提示语也含「你的答案」, 所以要求更具体
    if (!/正确答案|答案解析|你的答案是|答对了|回答正确/.test(t)) continue;
    if (seen && typeof seen.has === "function" && seen.has(t)) continue;
    if (seen && typeof seen.add === "function") seen.add(t);
    return t;
  }
  return "";
}

/**
 * 判分文本解析。判据顺序(2026-11-13 实测文本):
 *   「你的答案是正确的，很棒！」/「你的答案是错误的」→ 正误
 *   「正确答案:B」/「正确答案:AC」/「正确答案:对」→ 参考答案
 *   「答案解析 …」→ 解析正文(到「疑问」为止)
 * 正误只认「你的答案…正确/错误」这类判分句; 两者都没有 → unknown(不猜成 wrong)。
 */
export function parseJudge(text) {
  const t = String(text || "");
  const out = { result: "unknown", correct: "", analysis: "" };

  const majors = [
    { re: /正确答案\s*[:：]\s*([A-Za-z]+|对|错|正确|错误)/, hit: (m) => (out.correct = m[1]) },
    { re: /你的答案[^。！!\n]{0,6}?(不正确|错误|不对)/, hit: () => (out.result = "wrong") },
    { re: /你的答案[^。！!\n]{0,6}?(正确|对)/, hit: () => (out.result = "right") },
    { re: /答(错|对)了/, hit: (m) => (out.result = m[1] === "对" ? "right" : "wrong") },
  ];
  for (const rule of majors) {
    const m = t.match(rule.re);
    if (m) rule.hit(m);
  }

  const idx = t.indexOf("答案解析");
  if (idx >= 0) {
    let body = t.slice(idx).replace(/^答案解析\s*[:：]?\s*/, "");
    // 解析后面紧跟「疑问 您是否有理解的地方？… 继续 / 结束陪练」, 那是 UI 提示不是解析
    const tail = body.search(/疑问\s*您是否有理解的地方/);
    if (tail >= 0) body = body.slice(0, tail);
    out.analysis = body.replace(/\s+/g, " ").trim().slice(0, 800);
  }
  return out;
}

function stripAnswerDecorations(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  s = s.replace(/^\s*(?:答案|答|answer)\s*[:：]\s*/i, "");
  s = s.replace(/^["'“”‘’「」『』]+/, "").replace(/["'“”‘’「」『』]+$/, "");
  return s.trim();
}

/**
 * 把桥/模型返回的东西收拾成能直接塞进编辑器的答案。
 *  - single: 第一个 A-Z
 *  - multi: 所有 A-Z 去重排序(「B,D,A」→「ABD」)
 *  - judge: 对/错; 模型回 A/B 时按选项正文映射(「A. 正确」→ 对)
 *  - fill/essay/unknown: 原文(去首尾引号/「答案：」前缀), 填空按 | 归并
 */
export function normalizeAnswer(raw, type, options) {
  const s = stripAnswerDecorations(raw);
  const opts = Array.isArray(options) ? options : [];
  if (type === "single") {
    const m = s.match(/[A-Za-z]/);
    return m ? m[0].toUpperCase() : s;
  }
  if (type === "multi") {
    const letters = (s.match(/[A-Za-z]/g) || []).map((c) => c.toUpperCase());
    const uniq = [...new Set(letters)].sort();
    return uniq.length ? uniq.join("") : s;
  }
  if (type === "judge") {
    const flat = s.replace(/[.．、:：\s]/g, "");
    if (/^(对|正确|是|√|t|true|right)$/i.test(flat)) return "对";
    if (/^(错|错误|否|×|x|f|false|wrong)$/i.test(flat)) return "错";
    const letter = flat.match(/^([A-Za-z])$/);
    if (letter) {
      const opt = opts.find((o) => String(o && o.key).toUpperCase() === letter[1].toUpperCase());
      if (opt) {
        const verdict = normalizeJudgementText(opt.text);
        if (verdict === "true") return "对";
        if (verdict === "false") return "错";
        return String(opt.text || "").trim();
      }
    }
    return s;
  }
  if (type === "fill") {
    const parts = s.split(/\n|\|/).map((x) => x.trim()).filter(Boolean);
    return (parts.length ? parts.join("|") : s).replace(/\s*\|\s*/g, "|");
  }
  return s;
}

/* ---------------------------------------------------------- run 报告 */

/** 空报告(字段固定; 导出前再滤一遍凭据类键) */
export function createPracticeReport({ startedAt, direction, maxQuestions, mode } = {}) {
  return {
    startedAt: Number(startedAt) || Date.now(),
    endedAt: 0,
    direction: String(direction || "").slice(0, 300),
    maxQuestions: Number(maxQuestions) || 0,
    mode: mode === "auto" ? "auto" : "confirm",
    answers: [],
    skipped: [],
    failed: [],
  };
}

/** 记一道答过的题(对/错/判不出都记, result 三选一) */
export function reportAnswer(report, entry = {}) {
  if (!report || !Array.isArray(report.answers)) return null;
  const result = entry.result === "right" || entry.result === "wrong" ? entry.result : "unknown";
  const row = {
    index: Number(entry.index) || report.answers.length + 1,
    type: PRACTICE_TYPES.includes(entry.type) ? entry.type : "unknown",
    stem: String(entry.stem || "").slice(0, 160),
    answer: String(entry.answer || "").slice(0, 300),
    correct: String(entry.correct || "").slice(0, 120),
    result,
    analysis: String(entry.analysis || "").slice(0, 800),
    at: Number(entry.at) || Date.now(),
  };
  report.answers.push(row);
  return row;
}

/** 记一道跳过的题(「不会」) */
export function reportSkip(report, entry = {}) {
  if (!report || !Array.isArray(report.skipped)) return null;
  const row = {
    index: Number(entry.index) || 0,
    type: PRACTICE_TYPES.includes(entry.type) ? entry.type : "unknown",
    stem: String(entry.stem || "").slice(0, 160),
    reason: "userSkipped",
    at: Number(entry.at) || Date.now(),
  };
  report.skipped.push(row);
  return row;
}

/** 记一次失败(原因码限 PRACTICE_FAIL_CODES, 对不上归 no-question) */
export function reportFail(report, entry = {}) {
  if (!report || !Array.isArray(report.failed)) return null;
  const code = PRACTICE_FAIL_CODES.includes(entry.reasonCode) ? entry.reasonCode : "no-question";
  const row = {
    index: Number(entry.index) || 0,
    type: PRACTICE_TYPES.includes(entry.type) ? entry.type : "unknown",
    stem: String(entry.stem || "").slice(0, 160),
    reasonCode: code,
    reason: String(entry.reason || "").slice(0, 200),
    at: Number(entry.at) || Date.now(),
  };
  report.failed.push(row);
  return row;
}

/**
 * 统计: 跳过 / 判不出都不进正确率分母 —— 分母只有「判出对错」的题。
 * @returns {{answered:number,right:number,wrong:number,unknown:number,skipped:number,graded:number,accuracy:number}}
 */
export function practiceStats(report) {
  const answers = (report && report.answers) || [];
  const right = answers.filter((a) => a && a.result === "right").length;
  const wrong = answers.filter((a) => a && a.result === "wrong").length;
  const unknown = answers.filter((a) => a && a.result === "unknown").length;
  const skipped = ((report && report.skipped) || []).length;
  const graded = right + wrong;
  return {
    answered: answers.length,
    right,
    wrong,
    unknown,
    skipped,
    graded,
    accuracy: graded ? Math.round((right / graded) * 100) : 0,
  };
}

/** 报告里不许出现的键(凭据地毯式过滤, 与讨论区同一套) */
const PRACTICE_SECRET_KEY_RE = /(cookie|url_?token|visitor|passwd|password|session|ticket|\bcpi\b|\benc\b|\but\b)/i;

export function sanitizePracticeReport(report, depth = 0) {
  const walk = (v, d) => {
    if (v == null) return v;
    if (d > 8) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        if (PRACTICE_SECRET_KEY_RE.test(k)) continue;
        out[k] = walk(v[k], d + 1);
      }
      return out;
    }
    return v;
  };
  return walk(report, depth);
}

/** 导出给外层 agent 的 JSON 文本 */
export function practiceReportToJson(report) {
  try {
    return JSON.stringify(sanitizePracticeReport(report), null, 2);
  } catch (e) {
    return "{}";
  }
}

/** 等距抽 1/5 错题(本地拼文本, 不花 token); 错题少于 1 道返回空 */
export function samplePracticeForReview(report, ratio = 0.2) {
  const wrong = ((report && report.answers) || []).filter((a) => a && a.result === "wrong");
  if (!wrong.length) return [];
  const n = Math.max(1, Math.round(wrong.length * (Number(ratio) || 0.2)));
  const picked = [];
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round((i * (wrong.length - 1)) / (n - 1));
    const row = wrong[idx];
    if (row && !picked.includes(row)) picked.push(row);
  }
  return picked;
}

/** 把抽出来的错题拼成可复制文本 */
export function formatPracticeSamples(rows) {
  return (rows || [])
    .map((r, i) => `${i + 1}. [第${r.index}题/${r.type}] ${r.stem}\n   我的答案: ${r.answer || "(空)"}   正确答案: ${r.correct || "(未取到)"}`)
    .join("\n");
}
