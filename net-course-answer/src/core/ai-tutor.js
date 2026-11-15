// 「AI助教」一题一会话 + 自动评价的执行器(平台无关, 只碰传入的 doc/win)。
// 目标页: robot-lc.chaoxing.com/courseCozeV3/web (Vue SPA, 标题「AI助教」)。
//
// 选择器与坑全部来自 2026-11-13 真机 10/10 执行记录
// (一手侦察记录(未随仓库分发) §3)。要点:
//   · 输入框是 ProseMirror, 必须走 execCommand('insertText'), 直接改 textContent 不解锁发送;
//   · 页面有两个 .send-button, 只能按「可见 + 未禁用」挑 —— 绝不能按文案「发送」点 el-button--primary(上传弹窗);
//   · 赞没有理由框; 踩才弹 .el-popover.feed-back, 理由框是 div.feed-back__detail > textarea, 勾标签后要等约 600ms;
//   · 「等回复」光看文本长度会骗人(有问无答时长度稳定在只剩提问), 所以必须校验回复正文非空。
// 依赖注入: doc/win/now/sleep 都可换 —— 单测用假 DOM(tools/ai-tutor-test.mjs), 无需 jsdom。
import { sleepMs } from "../vendor/gm.js";

/** 默认参数(面板可改阈值, 其余留常量) */
export const AI_TUTOR_DEFAULTS = {
  praise: "结论正确、用上了课程概念，可以直接照着做题",
  criticize: "只给了结论没有解释机制，我问的第二部分没答",
  /** 回复少于这么多字 → 踩, 否则赞 */
  minChars: 300,
  /** 单题总超时 */
  replyTimeoutMs: 180000,
  /** 文本停止增长这么久即认为流结束 */
  stableMs: 8000,
  /** 文本稳定但没有回复正文时, 再等这么久才判「有问无答」(纯长度判据会把没回复当成答完) */
  noReplyGraceMs: 30000,
  /** 轮询间隔 */
  pollMs: 1000,
  /** 点新建会话后等会话变空的上限 */
  newChatWaitMs: 8000,
  /** 参考答案: 踩的标签优先级(真机只验证了 也没有帮助 / 其他 两个枚举码) */
  tags: ["没有帮助", "其他"],
};

/** 选择器集中表(grep 得到; 页面改版时只改这里) */
export const AI_TUTOR_SEL = {
  newChat: "div.new-chat-btn",
  input: 'div.input-body.ProseMirror[contenteditable="true"], .input-body.ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"]',
  sendButton: ".send-button",
  messageList: ".message-list",
  emptyState: ".message-list .empty, .message-list .empty-state, .empty-state, .message-empty",
  zan: "span.message-action-icon.icon-zan, i.iconfont.icon-zan, .icon-zan",
  cai: "span.message-action-icon.icon-cai, i.iconfont.icon-cai, .icon-cai",
  popover: ".el-popover.feed-back",
  tag: ".feed-back__tag",
  reasonBox: "div.feed-back__detail textarea, div.feed-back__detail textarea.el-textarea__inner, textarea.el-textarea__inner",
  submit: ".feed-back__action-submit",
  stop: ".stop",
};

/* ------------------------------------------------------------------ *
 * 纯逻辑(单测直接调)
 * ------------------------------------------------------------------ */

/** 一行一题: 去掉空行与整行注释(#), 保留原文(包括题号) */
export function parseQuestionList(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

/** 去空白(读回校验用: ProseMirror 末尾常多一个 \n) */
export function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, "").trim();
}

/** 回复字数(按码点算, 忽略空白) */
export function countChars(text) {
  return Array.from(normalizeSpaces(text)).length;
}

/**
 * 判分策略: 回复少于 minChars → 踩, 否则赞。
 * @returns {{verdict:"zan"|"cai", chars:number, reason:string}}
 */
export function decideVerdict(reply, opts = {}) {
  const o = { ...AI_TUTOR_DEFAULTS, ...opts };
  const chars = countChars(reply);
  const min = Number.isFinite(Number(o.minChars)) ? Number(o.minChars) : AI_TUTOR_DEFAULTS.minChars;
  const useCai = chars < min;
  return { verdict: useCai ? "cai" : "zan", chars, reason: useCai ? o.criticize : o.praise };
}

/**
 * 从消息区文本里剥掉自己的提问, 得到回复正文。
 * 「只有我的提问」必须判成空 —— 这正是真机上「有问无答」骗过长度轮询的那一态。
 */
export function extractReply(listText, question) {
  const raw = String(listText || "");
  if (!raw.trim()) return "";
  const q = String(question || "").trim();
  if (q && normalizeSpaces(raw) === normalizeSpaces(q)) return "";
  let t = raw;
  const idx = q ? t.indexOf(q) : -1;
  if (idx >= 0) t = t.slice(0, idx) + t.slice(idx + q.length);
  // 「运行完成」是界面状态文案, 不是回复正文
  t = t.replace(/运行完成/g, " ");
  const out = t.replace(/\s+/g, " ").trim();
  if (q && normalizeSpaces(out) === normalizeSpaces(q)) return "";
  return out;
}

/* ------------------------------------------------------------------ *
 * DOM 原语
 * ------------------------------------------------------------------ */

/** window 兜底(单测/无 window 环境) */
export function resolveWin(doc, win) {
  if (win) return win;
  if (doc && doc.defaultView) return doc.defaultView;
  return typeof window !== "undefined" ? window : null;
}

export function findAll(doc, sel) {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  try {
    return Array.from(doc.querySelectorAll(sel) || []);
  } catch (e) {
    return [];
  }
}

export function findOne(doc, sel) {
  const all = findAll(doc, sel);
  return all.length ? all[0] : null;
}

export function readText(el) {
  if (!el) return "";
  if (typeof el.innerText === "string" && el.innerText) return el.innerText;
  return typeof el.textContent === "string" ? el.textContent : "";
}

/** 元素是否可见(真机判据: getBoundingClientRect().width > 0) */
export function isVisible(el) {
  if (!el) return false;
  try {
    const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    if (!r) return true;
    return Number(r.width) > 0;
  } catch (e) {
    return false;
  }
}

/** 统一的点击(假 DOM 里就是 click()) */
export function clickEl(el, win) {
  if (!el) return false;
  try {
    if (typeof el.click === "function") {
      el.click();
      return true;
    }
  } catch (e) {}
  const w = win || (typeof window !== "undefined" ? window : null);
  try {
    if (w && w.MouseEvent) {
      el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      return true;
    }
  } catch (e) {}
  return false;
}

/** 派 input 事件(ProseMirror 兜底路径) */
function dispatchInput(doc, el, win) {
  const w = resolveWin(doc, win);
  if (!el || typeof el.dispatchEvent !== "function") return false;
  try {
    if (w && typeof w.InputEvent === "function") {
      el.dispatchEvent(new w.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return true;
    }
    if (w && typeof w.Event === "function") {
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      return true;
    }
  } catch (e) {}
  return false;
}

export function findInput(doc) {
  return findOne(doc, AI_TUTOR_SEL.input);
}

/** 读输入框当前文本 */
export function readPrompt(doc) {
  const el = findInput(doc);
  return el ? readText(el) : "";
}

/** 读回校验: 输入框文本必须与题目一致(空白差异不算) */
export function verifyPrompt(doc, text) {
  const el = findInput(doc);
  if (!el) return false;
  const want = normalizeSpaces(text);
  return !!want && normalizeSpaces(readText(el)) === want;
}

/**
 * 写一次(execCommand → 失败再改文本 + 派 InputEvent)。不校验, 由外层判断。
 */
function insertPromptOnce(doc, el, text, win) {
  const w = resolveWin(doc, win);
  try {
    if (typeof el.focus === "function") el.focus();
  } catch (e) {}
  // 光标移到内容末尾, 否则 execCommand 会插在旧文本前面
  try {
    if (typeof doc.createRange === "function") {
      const r = doc.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const sel = w && typeof w.getSelection === "function" ? w.getSelection() : null;
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
  } catch (e) {}
  let ok = false;
  try {
    ok = typeof doc.execCommand === "function" ? doc.execCommand("insertText", false, text) === true : false;
  } catch (e) {
    ok = false;
  }
  if (!ok || !verifyPrompt(doc, text)) {
    // 兜底: 直接写文本 + 派 InputEvent(某些构建里 execCommand 被基线禁用)
    try {
      el.textContent = text;
    } catch (e) {}
    dispatchInput(doc, el, win);
  }
}

/**
 * 写题 + 读回校验; 不一致重试一次, 仍不一致就失败(该题不发送)。
 * @returns {{ok:boolean, reason:string, attempts:number, text:string}}
 */
export function writePrompt(doc, text, { win } = {}) {
  const el = findInput(doc);
  if (!el) return { ok: false, reason: "没找到输入框(div.input-body.ProseMirror)", attempts: 0, text: "" };
  let attempts = 0;
  for (let i = 0; i < 2; i++) {
    attempts++;
    insertPromptOnce(doc, el, text, win);
    if (verifyPrompt(doc, text)) return { ok: true, reason: "", attempts, text: readText(el) };
  }
  return {
    ok: false,
    reason: `输入框读回与题目不一致(期望 ${countChars(text)} 字, 实际 ${countChars(readText(el))} 字)`,
    attempts,
    text: readText(el),
  };
}

/**
 * 发送按钮: 页面有两个 .send-button, 只能按「可见 + 未禁用」挑;
 * 绝不能按文案「发送」去点 button.el-button--primary(那是上传弹窗的按钮)。
 */
export function pickSendButton(doc) {
  const all = findAll(doc, AI_TUTOR_SEL.sendButton);
  for (const b of all) {
    const cls = String((b && b.className) || "");
    if (/\bdisabled\b/.test(cls)) continue; // :not(.disabled)
    if (b.disabled) continue;
    if (!isVisible(b)) continue; // 0×0 的那个是永久占位
    return b;
  }
  return null;
}

/** 消息区全文 */
export function readMessageText(doc) {
  const list = findOne(doc, AI_TUTOR_SEL.messageList);
  return list ? readText(list) : "";
}

/** 会话是否为空(新建后判据) */
export function isEmptyChat(doc) {
  if (findOne(doc, AI_TUTOR_SEL.emptyState)) return true;
  const text = readMessageText(doc);
  return normalizeSpaces(text).length <= 2;
}

/** 生成是否已收尾(「运行完成」文案 / 停止按钮不可见) */
export function isGenerateFinished(doc, listText) {
  const text = typeof listText === "string" ? listText : readMessageText(doc);
  if (/运行完成/.test(text)) return true;
  const stop = findOne(doc, AI_TUTOR_SEL.stop);
  if (stop && !isVisible(stop)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 异步步骤
 * ------------------------------------------------------------------ */

/**
 * 新建会话并等它变空。等不到就别硬发 —— 返回 ok:false, 由调用方记失败并跳到下一题。
 */
export async function startNewChat(doc, { win, sleep = sleepMs, now = Date.now, waitMs, shouldStop = () => false } = {}) {
  const o = { ...AI_TUTOR_DEFAULTS };
  const btn = findOne(doc, AI_TUTOR_SEL.newChat);
  if (!btn) return { ok: false, reason: "页面没找到「新建会话」(div.new-chat-btn)" };
  clickEl(btn, resolveWin(doc, win));
  const limit = Number.isFinite(Number(waitMs)) ? Number(waitMs) : o.newChatWaitMs;
  const t0 = now();
  while (now() - t0 <= limit) {
    if (shouldStop()) return { ok: false, reason: "已停止" };
    if (isEmptyChat(doc)) return { ok: true, reason: "" };
    await sleep(Math.min(o.pollMs, 500));
  }
  return { ok: false, reason: `点新建会话后 ${Math.round(limit / 1000)}s 内会话没变空` };
}

/**
 * 等一条回复收完。
 * 完成判据: 文本停止增长 ≥ stableMs, 或出现「运行完成」/停止按钮消失 —— 且剥掉提问后正文非空。
 * 纯长度稳定但正文为空 = 有问无答(真机第 4 题原措辞), 此时再等 noReplyGraceMs 才判失败。
 * @returns {Promise<{ok:boolean, reply:string, reason:string, elapsedMs:number}>}
 */
export async function waitForReply({ doc, question, opts = {}, sleep = sleepMs, now = Date.now, shouldStop = () => false }) {
  const o = { ...AI_TUTOR_DEFAULTS, ...opts };
  const t0 = now();
  let last = readMessageText(doc);
  let lastChange = t0;
  for (;;) {
    if (shouldStop()) return { ok: false, reply: "", reason: "已停止", elapsedMs: now() - t0 };
    const text = readMessageText(doc);
    if (text !== last) {
      last = text;
      lastChange = now();
    }
    const reply = extractReply(text, question);
    const finished = isGenerateFinished(doc, text);
    const idle = now() - lastChange;
    if (finished) {
      if (reply) return { ok: true, reply, reason: "", elapsedMs: now() - t0 };
      return { ok: false, reply: "", reason: "有问无答(生成已结束但没有回复正文)", elapsedMs: now() - t0 };
    }
    if (reply && idle >= o.stableMs) return { ok: true, reply, reason: "", elapsedMs: now() - t0 };
    if (!reply && idle >= Math.max(o.stableMs, o.noReplyGraceMs)) {
      return { ok: false, reply: "", reason: `有问无答(${Math.round(idle / 1000)}s 没有回复正文)`, elapsedMs: now() - t0 };
    }
    if (now() - t0 >= o.replyTimeoutMs) {
      return { ok: false, reply, reason: reply ? "回复超时未收尾" : "有问无答(超时)", elapsedMs: now() - t0 };
    }
    await sleep(o.pollMs);
  }
}

/** 等某个条件成立(评价动作用: 图标的 actived / 弹窗关闭) */
async function waitUntil(fn, { sleep = sleepMs, now = Date.now, timeoutMs = 2000, intervalMs = 100 } = {}) {
  const t0 = now();
  for (;;) {
    let ok = false;
    try {
      ok = !!fn();
    } catch (e) {
      ok = false;
    }
    if (ok) return true;
    if (now() - t0 >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

/** 赞: 点 icon-zan, 成功后该元素带 actived 类 */
export async function rateZan({ doc, win, sleep = sleepMs, now = Date.now } = {}) {
  const el = findOne(doc, AI_TUTOR_SEL.zan);
  if (!el) return { ok: false, reason: "没找到「赞」图标" };
  if (hasClass(el, "actived")) return { ok: true, reason: "", already: true };
  clickEl(el, resolveWin(doc, win));
  const on = await waitUntil(() => hasClass(el, "actived"), { sleep, now, timeoutMs: 2500 });
  return on ? { ok: true, reason: "" } : { ok: false, reason: "点了赞但图标没变成 actived" };
}

/**
 * 踩: 点 icon-cai → 勾标签 → 等约 600ms 再读 checked → 填理由 → 点「提交」且不带 disabled →
 * 用父级 .el-popover 的 display 确认弹窗已关。
 */
export async function rateCai({ doc, win, reason = "", opts = {}, sleep = sleepMs, now = Date.now } = {}) {
  const o = { ...AI_TUTOR_DEFAULTS, ...opts };
  const w = resolveWin(doc, win);
  const icon = findOne(doc, AI_TUTOR_SEL.cai);
  if (!icon) return { ok: false, reason: "没找到「踩」图标" };
  if (hasClass(icon, "actived")) return { ok: true, reason: "", already: true };
  clickEl(icon, w);
  const popover = await waitUntil(() => findOne(doc, AI_TUTOR_SEL.popover), { sleep, now, timeoutMs: 2500 })
    ? findOne(doc, AI_TUTOR_SEL.popover)
    : null;
  if (!popover) return { ok: false, reason: "点了踩但没弹出评价框(.el-popover.feed-back)" };

  const tags = findAll(doc, AI_TUTOR_SEL.tag);
  if (!tags.length) return { ok: false, reason: "评价框里没有标签(.feed-back__tag)" };
  const tag = pickTag(tags, o.tags);
  if (!tag) return { ok: false, reason: "评价框里没找到可用标签" };
  clickEl(tag, w);
  // 时序坑: 勾完要等一个 tick 才看得到 checked / 理由框显示, 同步读会误判「没勾上」
  await sleep(600);
  const checked = hasClass(tag, "checked") || tag.getAttribute && tag.getAttribute("aria-checked") === "true";
  if (!checked) return { ok: false, reason: `标签「${readText(tag).trim() || "?"}」没勾上` };

  const box = findOne(doc, AI_TUTOR_SEL.reasonBox);
  if (box && reason) {
    setTextareaValue(box, reason, w);
    await sleep(120);
  }
  const submit = findAll(doc, AI_TUTOR_SEL.submit).find(
    (b) => String((b && b.innerText) || (b && b.textContent) || "").trim() === "提交" && !isDisabled(b)
  );
  if (!submit) return { ok: false, reason: "没找到可用的「提交」按钮(可能被 disabled)" };
  clickEl(submit, w);
  const closed = await waitUntil(() => popoverClosed(doc, popover, w), { sleep, now, timeoutMs: 2500 });
  return closed ? { ok: true, reason: "" } : { ok: false, reason: "点了提交但评价框没关" };
}

/** 标签按优先级挑(优先「没有帮助」, 再「其他」) */
export function pickTag(tags, preferred = AI_TUTOR_DEFAULTS.tags) {
  for (const want of preferred) {
    const hit = tags.find((t) => readText(t).trim().includes(want));
    if (hit) return hit;
  }
  return tags[0] || null;
}

function hasClass(el, name) {
  if (!el) return false;
  const cls = String((el && el.className) || "");
  if (new RegExp(`(^|\\s)${name}(\\s|$)`).test(cls)) return true;
  return !!(el.classList && typeof el.classList.contains === "function" && el.classList.contains(name));
}

function isDisabled(el) {
  if (!el) return true;
  if (el.disabled) return true;
  return /\bdisabled\b/.test(String((el && el.className) || ""));
}

/** 理由框要用原生 setter + input 事件, 直接赋值 Vue 不认 */
export function setTextareaValue(el, value, win) {
  const w = win || (typeof window !== "undefined" ? window : null);
  let setter = null;
  try {
    setter = w && w.HTMLTextAreaElement && Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value");
  } catch (e) {
    setter = null;
  }
  try {
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  } catch (e) {}
  try {
    el.dispatchEvent(new (w && w.Event ? w.Event : Event)("input", { bubbles: true }));
  } catch (e) {}
  return el.value;
}

/** 弹窗是否已关: 看父级 .el-popover.feed-back 的 display(.feed-back__wrapper 自身永远是 block) */
export function popoverClosed(doc, popover, win) {
  const el = popover || findOne(doc, AI_TUTOR_SEL.popover);
  if (!el) return true; // 已经不在 DOM 里 = 关了
  const w = win || resolveWin(doc, win);
  let display = "";
  try {
    if (el.style && el.style.display) display = el.style.display;
    else if (w && typeof w.getComputedStyle === "function") display = w.getComputedStyle(el).display;
  } catch (e) {}
  return display === "none";
}

/* ------------------------------------------------------------------ *
 * 串行编排
 * ------------------------------------------------------------------ */

/**
 * 逐题串行跑一轮: 一题一会话 → 提问 → 等回复 → 评价。
 * 任何一题失败(新建会话没好 / 写入不一致 / 有问无答 / 超时)只记录并继续下一题, 不中断整轮。
 * 停止语义: 立即收手 —— 正在等的那题不再等、不评价, 后面的题不再发(已发出的提问留在平台上)。
 * @returns {{asked:number, replied:number, rated:number, zan:number, cai:number, failed:number, total:number, stopped:boolean}}
 */
export async function runTutorRound({ doc, win, items, opts = {}, log = () => {}, onItem = () => {}, shouldStop = () => false, sleep = sleepMs, now = Date.now }) {
  const o = { ...AI_TUTOR_DEFAULTS, ...opts };
  const list = (items || []).map((s) => String(s || "").trim()).filter(Boolean);
  const stats = { asked: 0, replied: 0, rated: 0, zan: 0, cai: 0, failed: 0, total: list.length, stopped: false };
  const fail = (i, reason) => {
    stats.failed++;
    onItem(i, "失败", { note: reason });
    log(`第${i + 1}/${list.length}题失败: ${reason}`, "danger");
  };

  for (let i = 0; i < list.length; i++) {
    if (shouldStop()) {
      stats.stopped = true;
      break;
    }
    const question = list[i];
    onItem(i, "待发");
    const chat = await startNewChat(doc, { win, sleep, now, waitMs: o.newChatWaitMs, shouldStop });
    if (!chat.ok) {
      if (chat.reason === "已停止") {
        stats.stopped = true;
        break;
      }
      fail(i, chat.reason);
      continue;
    }
    if (shouldStop()) {
      stats.stopped = true;
      break;
    }
    const wrote = writePrompt(doc, question, { win });
    if (!wrote.ok) {
      fail(i, wrote.reason);
      continue;
    }
    const btn = pickSendButton(doc);
    if (!btn) {
      fail(i, "发送按钮不可用(可见的 .send-button 都带 disabled)");
      continue;
    }
    clickEl(btn, resolveWin(doc, win));
    stats.asked++;
    onItem(i, "已提问");
    log(`第${i + 1}/${list.length}题已发送, 等回复…`, "primary");

    const r = await waitForReply({ doc, question, opts: o, sleep, now, shouldStop });
    if (!r.ok) {
      if (r.reason === "已停止") {
        stats.stopped = true;
        break;
      }
      fail(i, r.reason);
      continue;
    }
    stats.replied++;
    const d = decideVerdict(r.reply, o);
    onItem(i, "已回复", { chars: d.chars });
    log(`第${i + 1}题已回复 ${d.chars} 字(${Math.round(r.elapsedMs / 1000)}s) → 判${d.verdict === "zan" ? "赞" : "踩"}`, "primary");

    let rating;
    try {
      rating = d.verdict === "zan" ? await rateZan({ doc, win, sleep, now }) : await rateCai({ doc, win, reason: d.reason, opts: o, sleep, now });
    } catch (e) {
      rating = { ok: false, reason: (e && e.message) || String(e) };
    }
    if (rating.ok) {
      stats.rated++;
      stats[d.verdict]++;
      onItem(i, "已评价", { verdict: d.verdict, chars: d.chars, already: !!rating.already });
      log(`第${i + 1}题已${d.verdict === "zan" ? "赞" : "踩"}${rating.already ? "(之前已评过)" : ""}`, "success");
    } else {
      // 评价失败只记日志, 不影响后续题目
      onItem(i, "已回复", { verdict: d.verdict, chars: d.chars, note: `评价失败: ${rating.reason}` });
      log(`第${i + 1}题评价失败(不影响后续): ${rating.reason}`, "warning");
    }
  }
  if (shouldStop()) stats.stopped = true;
  return stats;
}

