#!/usr/bin/env node
// 答题桥 —— 把「网课答题助手」油猴脚本的答题请求转给任意 OpenAI Chat Completions 兼容接口。
//
// 用法:
//   1) 复制 bridge.config.example.json 为 bridge.config.json，填 baseUrl / model / apiKey
//      （也可以用环境变量 ANSWER_BASE_URL / ANSWER_MODEL / ANSWER_API_KEY，环境变量优先）
//   2) node server.mjs [--port 30142]
//
// 只要对方是 OpenAI Chat Completions 格式（POST /v1/chat/completions，返回 choices[0].message.content）
// 就能用：DeepSeek 官方、任意中转站、本地 Ollama / LM Studio 都算。
//
// 依赖: Node.js >= 18（自带 fetch）。不需要装任何 agent 框架。

import http from "node:http";
import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 端口: --port N > BRIDGE_PORT > 30142
// (勿写成 argv[argv.indexOf("--port")+1] ?? ... : 无 --port 时 indexOf=-1 → argv[0]=node 路径 → Number(...)=NaN 直接崩)
const PORT = (() => {
  const i = process.argv.indexOf("--port");
  if (i >= 0) return Number(process.argv[i + 1]);
  return Number(process.env.BRIDGE_PORT || 30142);
})();
// 题目 → 拼成提示词。
// 分工(2026-11-13): 角色与硬约束全在系统提示词里(见下), 这里只放题目与选项。
// 以前两处都写「只输出答案/不要解释/输出格式」—— 重复的话一改就打架, 只留系统提示词那份。
const TYPE_NAMES = {
  "0": "单选题", "1": "多选题", "2": "填空题",
  "3": "判断题", "4": "简答题", "999": "未知题型",
};
const TYPE_HINTS = {
  "0": "单选(从选项里选一个)",
  "1": "多选(可能不止一个, 有几个选几个)",
  "2": "填空(按空顺序作答)",
  "3": "判断",
  "4": "简答",
  "999": "未知题型(按最合适的方式作答)",
};
function buildPrompt(q) {
  const typeName = TYPE_NAMES[q.type] ?? String(q.type);
  const opts = Array.isArray(q.options) && q.options.length
    ? "\n选项:\n" + q.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "";
  return [`请解答这道题。`, `题型: ${typeName}${TYPE_HINTS[q.type] ? `(${TYPE_HINTS[q.type]})` : ""}`, `题目: ${q.title ?? ""}${opts}`].join("\n");
}

// 固定的“答题器”系统提示词 —— 把角色和硬约束写死在这里, 不靠模型自己的默认人设。
// 为什么(2026-11-13 实测): 通用 agent 提示词 + 工具对答题没用,
// 还白烧 token; 直接给角色和格式约束, 单题明显变快、也更容易只输出答案。
const ANSWER_SYSTEM_PROMPT = [
  "你只负责答题。只输出答案本身: 不要解释, 不要思考过程, 不要调用任何工具, 不要读写文件, 不要执行命令。",
  "格式要求:",
  "- 单选与判断: 只输出最终选项的完整文本(判断题输出 正确 或 错误)",
  "- 多选: 每行一个选项文本",
  "- 填空: 每行一个空的内容",
  "- 简答: 直接输出作答内容",
  "不要输出题号、序号前缀或任何额外说明。",
].join("\n");

// 固定的「讨论区回帖」系统提示词 —— 与 ANSWER_SYSTEM_PROMPT 一样写死、不走工具。
// 风格依据: 2026-11-13 实读课程讨论区 16 条回复(字数主体 40-150 字; 多为一句话定义 + 1./2./3. 分点;
// 没有称呼语/开场白/收尾套话)。所以这里把「像不像学生回帖」写成硬约束, 而不是让模型自由发挥。
const COMPOSE_SYSTEM_PROMPT = [
  "你在课程讨论区以学生身份回一条帖子。用学生口吻, 不要自称老师/助教/管理员。",
  "要求:",
  "- 紧扣标题与正文里提出的具体问题作答, 讲清机制与原因(为什么), 不要只抛结论, 不要复述已有回复的措辞。",
  "- 长度 80-150 个汉字(含标点), 最稳的区间是 110-140; 一段连写或「一句定义 + 1./2./3. 分点」都可以。",
  "- 不要称呼语和开场白(不要「同学你好」「关于这个问题」「这个问题问得好」), 不要收尾套话(不要「首先/其次/最后/综上所述/希望对你有帮助/以上」)。",
  "- 不要提到 AI、模型、助手, 不要说自己是机器人或助教。",
  "- 只输出回复正文本身: 不要引号、不要标题、不要解释你在做什么, 不要调用任何工具。",
].join("\n");

// 固定的「AI陪练」系统提示词 —— 与 ANSWER_SYSTEM_PROMPT 一样写死、不走工具。
// 陪练页是「经济学导论(双语)」课程的题库, 题型在页面上写死; 这里只规定输出形状,
// 题目与选项由 buildPracticePrompt 拼。答案归一(如多选排序)在油猴侧 core/practice.js。
const PRACTICE_SYSTEM_PROMPT = [
  "你是经济学导论(双语)课程的答题器。只输出答案本身, 不要解释、不要引号、不要『答案：』前缀。",
  "单选题 → 一个选项字母; 多选题 → 选项字母连写(如 ABD); 判断题 → 只写 对 或 错;",
  "填空题 → 按空顺序用 | 分隔; 主观题/简答 → 60 字以内。",
].join("\n");

// 三个入口各一套系统提示词，按槽位名取
const PROMPTS = {
  ask: ANSWER_SYSTEM_PROMPT,
  compose: COMPOSE_SYSTEM_PROMPT,
  practice: PRACTICE_SYSTEM_PROMPT,
};

// ---------------------------------------------------------------------------
// 后端配置：优先环境变量, 其次同目录的 bridge.config.json
//
// 只认 OpenAI Chat Completions 格式。实测提醒: 现在很多模型默认开推理,
// 一句「正确」也可能先烧几百个 reasoning token; max_tokens 给小了正文会是空字符串。
// ---------------------------------------------------------------------------
function readConfigFile() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "bridge.config.json"), path.join(process.cwd(), "bridge.config.json")]) {
    if (!existsSync(p)) continue;
    try {
      return { path: p, data: JSON.parse(readFileSync(p, "utf8")) };
    } catch (e) {
      console.error(`配置文件解析失败: ${p}\n  ${e.message}`);
      process.exit(1);
    }
  }
  return null;
}
const CONF = readConfigFile();
const conf = (name) => (CONF && CONF.data && Object.prototype.hasOwnProperty.call(CONF.data, name) ? CONF.data[name] : undefined);
// apiKey 允许写成 "${DEEPSEEK_API_KEY}"，从环境变量取，key 就不落盘
function expandSecret(v) {
  if (typeof v !== "string" || !v) return "";
  const m = /\$\{(\w+)\}/.exec(v);
  return m ? (process.env[m[1]] || "") : v;
}

const LLM = {
  base: process.env.ANSWER_BASE_URL || conf("baseUrl") || "https://api.openai.com/v1",
  model: process.env.ANSWER_MODEL || conf("model") || "gpt-4o-mini",
  key: expandSecret(process.env.ANSWER_API_KEY || conf("apiKey") || ""),
  maxTokens: Number(process.env.ANSWER_MAX_TOKENS || conf("maxTokens") || 1024),
  timeoutMs: Number(process.env.ANSWER_TIMEOUT_MS || conf("timeoutMs") || 90000),
};

// 最近一次 HTTP 调用的用量, 给 /health 和日志用(排查「答案为什么是空的」主要看 reasoning)
let lastLlmUsage = null;


// ---------------------------------------------------------------------------
// /compose: 讨论区回复正文生成(只出正文, 不解析成答案行)
// ---------------------------------------------------------------------------

/** 把一条已有回复压成单行(喂给模型当"别重复"的参照) */
function clipOneLine(s, max = 120) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 组 prompt: 这里只放话题本身与"别重复"的参照, 角色/风格/字数全在 COMPOSE_SYSTEM_PROMPT。
 * 两处都写风格要求的话, 改一处必然和另一处打架(与 buildPrompt 同理)。
 */
function buildComposePrompt(p) {
  const existing = (Array.isArray(p.existingReplies) ? p.existingReplies : [])
    .map((s) => clipOneLine(s))
    .filter(Boolean)
    .slice(0, 12);
  const existingBlock = existing.length
    ? existing.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "(这个话题还没有回复)";
  return [
    `话题标题: ${p.topicTitle}`,
    `话题正文: ${clipOneLine(p.topicBody, 800) || "(只有标题, 没有正文)"}`,
    `已有回复(不要重复或改写它们的说法):`,
    existingBlock,
    `字数: ${p.minChars}-${p.maxChars} 个汉字(含标点); 建议写到 ${Math.min(p.maxChars, Math.round((p.minChars + p.maxChars) / 2) + 10)} 字左右, 超出范围会被丢弃。`,
    `直接输出这条回复的正文。`,
  ].join("\n");
}

/** 把模型输出收拾成「一段正文」: 去代码围栏 / 「回复:」前缀 / 首尾引号 / 空行 */
function cleanComposeText(raw) {
  let t = String(raw ?? "");
  t = t.replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/, "");
  t = t.replace(/^\s*(回复|答案|正文)\s*[:：]\s*/i, "");
  t = t.replace(/^["'“”‘’「」『』]+/, "").replace(/["'“”‘’「」『』]+$/, "");
  t = t.replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();
  return t;
}

/** 讨论区回复的字数(按码点算, 忽略空白) —— 与油猴侧算法一致 */
function composeCharCount(text) {
  return Array.from(String(text ?? "").replace(/\s+/g, "")).length;
}

/** 数值参数归一(请求体里的脏值不往 prompt 里带) */
function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

async function composeReply(p) {
  const prompt = buildComposePrompt(p);
  const mid = Math.min(p.maxChars, Math.round((p.minChars + p.maxChars) / 2) + 10);
  let text = "";
  let chars = 0;
  let attempts = 0;
  const t0 = Date.now();
  for (let round = 1; round <= 2; round++) {
    // 字数超范围时把「上一版多少字、目标多少字」回嗂给模型再写一次 ——
    // 模型对字数的估计不可靠(实测常飘到 15x-17x), 靠提示词一次就落在区间里的概率只有一半左右。
    const fixHint =
      round === 1
        ? ""
        : `\n\n上一版正文 ${chars} 字, 不在 ${p.minChars}-${p.maxChars} 字之间。请重写一遍, 控制在 ${mid} 字左右, 内容仍然只针对标题与正文的问题, 不要重复上一版的措辞, 只输出正文。`;
    const r = await promptPi(prompt + fixHint, {
      tag: "compose",
      slot: "compose",
      fields: `titleLen=${(p.topicTitle ?? "").length} existing=${(p.existingReplies || []).length}${round > 1 ? ` retryChars=${chars}` : ""}`,
    });
    attempts += r.attempts;
    text = cleanComposeText(r.text);
    chars = composeCharCount(text);
    if (chars >= p.minChars && chars <= p.maxChars) break;
    if (round === 1) logLine("WARN", `compose out of range: ${chars} 字(目标 ${p.minChars}-${p.maxChars}), 重写一次`);
  }
  logLine("INFO", `compose ok: attempt=${attempts} chars=${chars} elapsed=${Date.now() - t0}ms`);
  return { text, chars };
}

// ---------------------------------------------------------------
// /practice-answer: AI陪练(超星 qbank-ai/aiPracticeAssistant)单题作答
// 只出答案本身: 题型/选项由脚本给, 输出形状全在 PRACTICE_SYSTEM_PROMPT。
// ---------------------------------------------------------------

const PRACTICE_TYPE_NAMES = {
  single: "单选题",
  multi: "多选题",
  judge: "判断题",
  fill: "填空题",
  essay: "主观题/简答",
  unknown: "题型未识别(按最合适的方式作答)",
};

function buildPracticePrompt(p) {
  const opts = Array.isArray(p.options) && p.options.length
    ? "\n选项:\n" + p.options.map((o) => `${String(o && o.key || "").toUpperCase()}. ${String(o && o.text || "")}`).join("\n")
    : "";
  const direction = typeof p.direction === "string" && p.direction.trim() ? `\n练习方向: ${p.direction.trim().slice(0, 200)}` : "";
  return [
    `题型: ${PRACTICE_TYPE_NAMES[p.type] ?? PRACTICE_TYPE_NAMES.unknown}`,
    `题目: ${String(p.stem ?? "").slice(0, 2000)}${opts}${direction}`,
  ].join("\n");
}

/** 把模型输出收拾成答案: 去代码围栏 / 「答案：」前缀 / 首尾引号, 返回非空行 */
function cleanPracticeAnswer(raw) {
  let t = String(raw ?? "").replace(/^\s*```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  t = t.replace(/^\s*(?:答案|答|answer)\s*[:：]\s*/i, "");
  t = t.replace(/^["'“”‘’「」『』]+/, "").replace(/["'“”‘’「」『』]+$/, "");
  return t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function practiceAnswer(p) {
  const r = await promptPi(buildPracticePrompt(p), {
    tag: "practice",
    slot: "practice",
    fields: `type=${p.type} stemLen=${String(p.stem ?? "").length} options=${(p.options || []).length}`,
  });
  const lines = cleanPracticeAnswer(r.text);
  // 填空题按空顺序用 | 分隔; 其它题型合一行(选项字母/对错/短简答)
  const answer = (p.type === "fill" ? lines.join("|") : lines.join(" ")).slice(0, 600);
  logLine("INFO", `practice ok: attempt=${r.attempts} elapsed=${r.elapsedMs}ms answerLen=${answer.length}`);
  return { ok: !!answer, answer };
}

// 从模型回复文本解析答案行
function parseAnswers(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const raw of lines) {
    let l = raw
      .replace(/^[-*•▪]\s*/, "")
      .replace(/^\d+\s*[.、:：)]\s*/, "")
      .replace(/^(答案|答|answer)\s*[:：]\s*/i, "")
      .trim();
    if (!l) continue;
    if (/^(好的|好的[,，]?|以下是|根据|这道题|解析|解释|答案[:：]?$)/i.test(l)) continue;
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 日志: 一律带 ISO 时间戳写 stderr(桥由 start.ps1 重定向到 bridge.err.log)
// ---------------------------------------------------------------------------
function logLine(level, msg) {
  process.stderr.write(`[${new Date().toISOString()}] ${level} ${String(msg ?? "")}\n`);
}
function logErrorWithStack(level, msg, err) {
  const stack = err?.stack ?? (err instanceof Error ? err.message : String(err));
  logLine(level, `${msg}: ${stack}`);
}

/** 一次 POST 就完事; 系统提示词按槽位取 */
async function promptPi(prompt, { attempt = 1, tag = "ask", fields = "", slot = "ask" } = {}) {
  const systemPrompt = PROMPTS[slot] ?? PROMPTS.ask;
  const url = /\/v1$/.test(LLM.base) ? `${LLM.base}/chat/completions` : `${LLM.base}/v1/chat/completions`;
  const where = fields ? ` ${fields}` : "";
  const t0 = Date.now();

  async function once() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LLM.timeoutMs);
    try {
      const headers = { "Content-Type": "application/json" };
      if (LLM.key) headers.Authorization = `Bearer ${LLM.key}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: LLM.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          stream: false,
          max_tokens: LLM.maxTokens,
        }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      const choice = json?.choices?.[0];
      const text = choice?.message?.content;
      lastLlmUsage = {
        finish: choice?.finish_reason ?? null,
        completionTokens: json?.usage?.completion_tokens ?? null,
        reasoningTokens: json?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        cost: json?.usage?.cost ?? null,
        at: new Date().toISOString(),
      };
      if (!text) throw new Error(`后端没返回正文 (finish=${choice?.finish_reason}); 若为 length, 多半是推理吃满了 max_tokens`);
      return String(text);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const text = await once();
    const elapsedMs = Date.now() - t0;
    logLine("INFO", `${tag} ok(http): ${where.trim()} elapsed=${elapsedMs}ms model=${LLM.model} reasoning=${lastLlmUsage?.reasoningTokens ?? "?"} chars=${text.length}`);
    return { text, elapsedMs, attempts: attempt };
  } catch (err) {
    logLine("ERROR", `${tag} failed(http): attempt=${attempt}${where} elapsed=${Date.now() - t0}ms err=${err?.message ?? err}`);
    // 4xx 是请求本身的问题(模型名/key), 重试没意义; 超时与 5xx 重试一次
    if (attempt === 1 && !/HTTP 4\d\d/.test(err?.message ?? "")) {
      return promptPi(prompt, { attempt: attempt + 1, tag, fields, slot });
    }
    throw err;
  }
}

async function askPi(q) {
  const fields = `type=${q.type} titleLen=${(q.title ?? "").length}`;
  const r = await promptPi(buildPrompt(q), { tag: "ask", fields });
  const answers = parseAnswers(r.text);
  logLine("INFO", `ask ok: attempt=${r.attempts} ${fields} elapsed=${r.elapsedMs}ms answers=${answers.length}`);
  return { ok: answers.length > 0, answers, raw: r.text };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(body);
  };

  // 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  if (req.method === "GET" && (req.url === "/health" || req.url.startsWith("/health?"))) {
    return send(200, {
      ok: true,
      service: "answer-bridge",
      port: PORT,
      backend: "http",
      llm: { model: LLM.model, base: LLM.base, maxTokens: LLM.maxTokens, hasKey: !!LLM.key, configFile: CONF ? CONF.path : null },
      lastLlmUsage,
    });
  }

  const path = String(req.url || "").split("?")[0];
  if (req.method !== "POST" || (path !== "/ask" && path !== "/compose" && path !== "/practice-answer")) {
    return send(404, { ok: false, error: "not found" });
  }

  let bodyText = "";
  for await (const chunk of req) bodyText += chunk;
  let q;
  try {
    q = JSON.parse(bodyText || "{}");
  } catch {
    return send(400, { ok: false, error: "invalid json" });
  }

  if (path === "/compose") {
    if (!q || typeof q.topicTitle !== "string" || !q.topicTitle.trim()) {
      return send(400, { ok: false, error: "topicTitle is required" });
    }
    const minChars = clampInt(q.minChars, 20, 400, 80);
    const maxChars = Math.max(minChars, clampInt(q.maxChars, 20, 400, 150));
    const existingReplies = Array.isArray(q.existingReplies)
      ? q.existingReplies.map((s) => String(s ?? "")).filter((s) => s.trim()).slice(0, 20)
      : [];
    try {
      const r = await composeReply({
        topicTitle: q.topicTitle.trim(),
        topicBody: typeof q.topicBody === "string" ? q.topicBody : "",
        existingReplies,
        minChars,
        maxChars,
      });
      if (!r.text) return send(200, { ok: false, error: "模型没返回正文" });
      // 字数越界不在这里拒 —— 油猴侧会重新生成一次并自己判不合格(那边有面板可以提示)
      send(200, { ok: true, text: r.text });
    } catch (e) {
      send(500, { ok: false, error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/practice-answer") {
    if (!q || typeof q.stem !== "string" || !q.stem.trim()) {
      return send(400, { ok: false, error: "practice.stem is required" });
    }
    const type = ["single", "multi", "judge", "fill", "essay"].includes(q.type) ? q.type : "unknown";
    const options = Array.isArray(q.options)
      ? q.options
          .map((o, i) => ({
            key: String((o && o.key) || String.fromCharCode(65 + i)).toUpperCase().slice(0, 1),
            text: String((o && o.text) ?? "").slice(0, 500),
          }))
          .filter((o) => o.text)
          .slice(0, 12)
      : [];
    try {
      const r = await practiceAnswer({ type, stem: q.stem.trim(), options, direction: typeof q.direction === "string" ? q.direction : "" });
      if (!r.ok) return send(200, { ok: false, error: "模型没返回答案" });
      return send(200, { ok: true, answer: r.answer });
    } catch (e) {
      return send(500, { ok: false, error: e?.message ?? String(e) });
    }
  }

  if (!q || typeof q.title !== "string" || !q.title.trim()) {
    return send(400, { ok: false, error: "question.title is required" });
  }

  try {
    const r = await askPi(q);
    if (r.ok) {
      send(200, { ok: true, answer: r.answers });
    } else {
      send(200, { ok: false, error: "模型未返回可解析答案", raw: r.raw });
    }
  } catch (e) {
    send(500, { ok: false, error: e?.message ?? String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`pi-answer-bridge 已启动: http://127.0.0.1:${PORT}  (答题源 → OpenAI 兼容接口)`);
  logLine("INFO", `bridge listening: 127.0.0.1:${PORT} pid=${process.pid} node=${process.version} cwd=${process.cwd()}`);
});

// D. 端口被占 / listen 失败之类: 先落日志, 不再静默
server.on("error", (err) => {
  logErrorWithStack("FATAL", "http server error", err);
  if (err?.code === "EADDRINUSE" || err?.code === "EACCES") {
    logLine("FATAL", `无法监听 127.0.0.1:${PORT} (${err.code}), 退出`);
    process.exitCode = 1;
    process.exit(1);
  }
});

server.on("clientError", (err, socket) => {
  logErrorWithStack("WARN", "http clientError", err);
  try { socket?.destroy?.(); } catch {}
});

// D. 进程级兜底: 先落全栈再决定。桥是常驻服务, 安静消失比带病存活更难查,
// 所以这里记完日志继续跑; 单条请求仍由 askPi 的 90s 超时兜底。
process.on("uncaughtException", (err) => {
  logErrorWithStack("FATAL", "uncaughtException (继续运行)", err);
});
process.on("unhandledRejection", (reason) => {
  logErrorWithStack("FATAL", "unhandledRejection (继续运行)", reason);
});

async function shutdown(signal) {
  logLine("INFO", `收到 ${signal}, 退出`);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
