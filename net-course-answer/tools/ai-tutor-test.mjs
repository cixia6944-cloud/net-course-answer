#!/usr/bin/env node
// AI助教(一题一会话 + 自动评价)执行器单测 —— node tools/ai-tutor-test.mjs
//
// 全程假 DOM, 不碰真页面。覆盖真机记录(一手侦察记录(未随仓库分发))里踩过的坑:
//   · 输入写入 + 读回校验(不一致重试一次, 仍不一致就失败);
//   · 发送按钮必须跳过 button.el-button--primary(上传弹窗), 只认可见且未禁用的 .send-button;
//   · 回复完成判据(文本停止增长 / 「运行完成」 / 超时), 且「只有我的提问」要判成有问无答;
//   · 评价分支: 赞(actived 确认) / 踩(标签勾选 → 等 600ms → 理由框 → 提交按钮筛选 → 弹窗关闭);
//   · 单题失败后继续下一题; 停止后不再发。

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
 * 迷你假 DOM: 够用就行 —— 支持 tag / .class / [attr] / :not() 与后代组合
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
      const name = m[1];
      const want = m[2] ?? m[3] ?? m[4];
      const actual = name === "class" ? el.className : el.getAttribute(name);
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
  constructor(tag, { cls = "", text = "", width = 10, attrs = {} } = {}) {
    this.tagName = String(tag).toUpperCase();
    this._classes = new Set(String(cls).split(/\s+/).filter(Boolean));
    this._text = text;
    this._width = width;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.disabled = false;
    this.style = {};
    this.value = "";
    this.clicked = 0;
    this.onClick = null;
    this._writable = true;
  }
  get className() {
    return [...this._classes].join(" ");
  }
  set className(v) {
    this._classes = new Set(String(v || "").split(/\s+/).filter(Boolean));
  }
  get classList() {
    const el = this;
    return {
      contains: (c) => el._classes.has(c),
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, on) => {
        const want = on === undefined ? !el._classes.has(c) : !!on;
        if (want) el._classes.add(c);
        else el._classes.delete(c);
        return want;
      },
    };
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
    if (!this._writable) return; // 模拟「写了但页面不收」的输入框
    this.children = [];
    this._text = String(v == null ? "" : v);
  }
  get innerText() {
    return this.textContent;
  }
  set innerText(v) {
    this.textContent = v;
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
  getBoundingClientRect() {
    return { width: this._width, height: this._width, top: 0, left: 0 };
  }
  focus() {}
  click() {
    this.clicked++;
    if (typeof this.onClick === "function") this.onClick(this);
  }
  dispatchEvent(ev) {
    const ls = this._listeners || (this._listeners = {});
    (ls[ev.type] || []).forEach((fn) => fn(ev));
    return true;
  }
  addEventListener(type, fn) {
    const ls = this._listeners || (this._listeners = {});
    (ls[type] = ls[type] || []).push(fn);
  }
}

class FakeRange {
  selectNodeContents() {}
  collapse() {}
}

class FakeWin {
  constructor() {
    this.Event = class {
      constructor(type) {
        this.type = type;
      }
    };
    this.InputEvent = class extends this.Event {
      constructor(type, opts = {}) {
        super(type);
        this.bubbles = !!opts.bubbles;
        this.inputType = opts.inputType;
      }
    };
    this.MouseEvent = this.Event;
    this.getComputedStyle = (el) => ({ display: (el && el.style && el.style.display) || "block" });
  }
  getSelection() {
    return { removeAllRanges() {}, addRange() {} };
  }
}

class FakeDoc {
  constructor() {
    this.root = new FakeEl("div");
    this.children = this.root.children;
    this.defaultView = new FakeWin();
    this.execCommandCalls = 0;
    this.execCommandImpl = null;
    this.tick = null;
  }
  append(el) {
    this.root.append(el);
    return el;
  }
  querySelectorAll(sel) {
    return this.root.querySelectorAll(sel);
  }
  querySelector(sel) {
    return this.root.querySelector(sel);
  }
  createRange() {
    return new FakeRange();
  }
  execCommand(cmd, ui, text) {
    this.execCommandCalls++;
    return this.execCommandImpl ? this.execCommandImpl(cmd, text) === true : false;
  }
}

/** 假时钟: now()/sleep() 联动, sleep 时顺带推进页面 tick */
function makeClock(doc) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (typeof doc.tick === "function") doc.tick();
    },
    advance: (ms) => {
      t += ms;
    },
    get t() {
      return t;
    },
  };
}

const { writePrompt, verifyPrompt, pickSendButton, decideVerdict, extractReply, waitForReply, rateZan, rateCai, runTutorRound, parseQuestionList, startNewChat, isEmptyChat } = await import("../src/core/ai-tutor.js");

/* ================= 1. 输入写入 + 读回校验 ================= */

function makePromptPage() {
  const doc = new FakeDoc();
  const input = new FakeEl("div", { cls: "input-body ProseMirror", attrs: { contenteditable: "true" } });
  doc.append(input);
  doc.execCommandImpl = (cmd, text) => {
    if (cmd !== "insertText") return false;
    input.textContent = input.textContent + text;
    return true;
  };
  return { doc, input };
}

{
  const { doc, input } = makePromptPage();
  const r = writePrompt(doc, "1.4 机会成本为什么不加总?");
  ok(r.ok, "写题: execCommand 成功 → 读回一致");
  eq(r.attempts, 1, "写题: 一次成功只试一次");
  ok(verifyPrompt(doc, "1.4  机会成本为什么不加总?"), "读回校验忽略空白差异(ProseMirror 末尾多 \n)");
  input.textContent = input.textContent + "\n";
  ok(verifyPrompt(doc, "1.4 机会成本为什么不加总?"), "读回校验: 末尾换行不算不一致");
}

{
  // 前一次写入被页面吞掉, 第二次才生效 → 必须重试一次并成功
  const { doc, input } = makePromptPage();
  let attemptsByPage = 0;
  doc.execCommandImpl = (cmd, text) => {
    attemptsByPage++;
    if (attemptsByPage === 1) return false;
    input._text = text; // 绕过 setter: 模拟页面自己把字写进去
    return true;
  };
  input._writable = false; // 兜底路径写不进去 → 第一次整体失败
  const r = writePrompt(doc, "1.5 需求曲线怎么平移");
  input._writable = true;
  ok(r.ok, "写题: 第一次不一致 → 重试一次后成功");
  eq(r.attempts, 2, "写题: 失败重试恰好一次");
}

{
  const { doc, input } = makePromptPage();
  doc.execCommandImpl = () => false;
  input._writable = false;
  const r = writePrompt(doc, "写不进去的题");
  ok(!r.ok, "写题: 两次都读回不一致 → 失败");
  ok(/不一致/.test(r.reason), "写题失败原因写明读回不一致");
}

/* ================= 2. 发送按钮必须跳过 el-button--primary ================= */

{
  const doc = new FakeDoc();
  const primary = new FakeEl("button", { cls: "el-button el-button--primary", text: "发送" });
  const disabled = new FakeEl("button", { cls: "send-button disabled", width: 36 });
  disabled.disabled = true;
  const zero = new FakeEl("button", { cls: "send-button", width: 0 }); // 永久 0×0 的占位
  const good = new FakeEl("button", { cls: "send-button", width: 36 });
  doc.append(primary);
  doc.append(disabled);
  doc.append(zero);
  doc.append(good);
  const picked = pickSendButton(doc);
  ok(picked === good, "发送按钮: 只挑「可见 + 未禁用」的 .send-button");
  ok(picked !== primary, "发送按钮: 绝不按文案「发送」点 el-button--primary");
  ok(picked !== zero && picked !== disabled, "发送按钮: 跳过 0×0 占位与 disabled 的 .send-button");
}

/* ================= 3. 回复完成判据 ================= */

{
  const doc = new FakeDoc();
  const list = new FakeEl("div", { cls: "message-list" });
  doc.append(list);
  const clock = makeClock(doc);
  const q = "老师, 机会成本为什么只算最高的那一个?";
  list.textContent = q;
  let grown = 0;
  doc.tick = () => {
    if (grown < 4) {
      grown++;
      list.textContent = q + "回答段落" + "。".repeat(100 * grown);
    }
  };
  const r = await waitForReply({ doc, question: q, opts: { replyTimeoutMs: 60000 }, sleep: clock.sleep, now: clock.now });
  ok(r.ok, "等回复: 文本停止增长 ≥8s → 完成");
  ok(!r.reply.includes(q), "等回复: 回复正文已剥掉自己的提问");
  ok(r.reply.length > 100, "等回复: 拿到完整正文");
}

{
  // 有问无答: 消息区从头到尾只有我的提问(真机第 4 题原措辞)
  const doc = new FakeDoc();
  const list = new FakeEl("div", { cls: "message-list" });
  doc.append(list);
  const clock = makeClock(doc);
  const q = "1.14 节算需求价格弹性时用的是中点法, 为什么不用变化量除以初始价格?";
  list.textContent = q;
  const r = await waitForReply({ doc, question: q, opts: { replyTimeoutMs: 180000, noReplyGraceMs: 30000 }, sleep: clock.sleep, now: clock.now });
  ok(!r.ok, "等回复: 只有我的提问 → 判失败");
  ok(/有问无答/.test(r.reason), "等回复: 失败原因写「有问无答」");
  ok(clock.t < 60000, "等回复: 有问无答在宽限期就收手, 不烧满 180s");
}

{
  // 一直增长 → 超时
  const doc = new FakeDoc();
  const list = new FakeEl("div", { cls: "message-list" });
  doc.append(list);
  const clock = makeClock(doc);
  const q = "2.5 乘数为什么不是重复计算";
  let n = 0;
  list.textContent = q;
  doc.tick = () => {
    n++;
    list.textContent = q + "还在写".repeat(n) + "。";
  };
  const r = await waitForReply({ doc, question: q, opts: { replyTimeoutMs: 30000 }, sleep: clock.sleep, now: clock.now });
  ok(!r.ok, "等回复: 一直增长到总超时 → 失败");
  ok(/超时/.test(r.reason), "等回复: 超时原因写明超时");
}

{
  const doc = new FakeDoc();
  const list = new FakeEl("div", { cls: "message-list", text: "我的提问" });
  doc.append(list);
  const clock = makeClock(doc);
  doc.tick = () => {
    if (clock.t === 1000) list.textContent = "我的提问运行完成";
  };
  const r = await waitForReply({ doc, question: "我的提问", opts: {}, sleep: clock.sleep, now: clock.now });
  ok(!r.ok, "等回复: 出现「运行完成」但没有正文 → 有问无答(不硬当成功)");
}

/* ================= 4. 判分策略 ================= */

{
  eq(decideVerdict("字".repeat(299), { minChars: 300 }).verdict, "cai", "判分: 299 字 → 踩");
  eq(decideVerdict("字".repeat(300), { minChars: 300 }).verdict, "zan", "判分: 300 字 → 赞");
  const d = decideVerdict("  空 白 不 计 ".repeat(50), { minChars: 300, praise: "P", criticize: "C" });
  ok(d.chars > 0 && d.verdict === "cai", "判分: 按非空白字符数算, 空白凑不够字数");
  eq(decideVerdict("字".repeat(400), { minChars: 300, praise: "结论正确" }).reason, "结论正确", "判分: 赞使用面板里的赞理由");
  eq(decideVerdict("字".repeat(50), { minChars: 300, criticize: "没讲机制" }).reason, "没讲机制", "判分: 踩使用面板里的踩理由");
}

{
  eq(parseQuestionList("第一题\n\n# 注释\n  \n第二题  \n").length, 2, "清单: 一行一题, 跳过空行与 # 注释");
  eq(extractReply("我的提问回复正文", "我的提问"), "回复正文", "剥离提问: 拼接文本里取回复部分");
  eq(extractReply("只有提 问", "只有提问"), "", "剥离提问: 空白差异也算「只有我的提问」");
}

/* ================= 5. 评价分支 ================= */

{
  const doc = new FakeDoc();
  const icon = new FakeEl("i", { cls: "iconfont icon-zan" });
  icon.onClick = (el) => el.classList.add("actived");
  doc.append(icon);
  const clock = makeClock(doc);
  const r = await rateZan({ doc, sleep: clock.sleep, now: clock.now });
  ok(r.ok, "赞: 点 icon-zan 后变 actived → 成功");
  eq(icon.clicked, 1, "赞: 只点一次");
}

{
  // 踩的完整链路(真机 §3.4 的五个坑)
  const doc = new FakeDoc();
  const icon = new FakeEl("i", { cls: "iconfont icon-cai" });
  const pop = new FakeEl("div", { cls: "el-popover feed-back" });
  pop.style.display = "block";
  const tagNoHelp = new FakeEl("div", { cls: "feed-back__tag", text: "没有帮助" });
  const tagOther = new FakeEl("div", { cls: "feed-back__tag", text: "其他" });
  const tagFake = new FakeEl("div", { cls: "feed-back__tag", text: "虚假信息" });
  const detail = new FakeEl("div", { cls: "feed-back__detail" });
  const box = new FakeEl("textarea", { cls: "el-textarea__inner" });
  detail.append(box);
  const cancel = new FakeEl("div", { cls: "feed-back__action-submit", text: "取消" });
  const submit = new FakeEl("div", { cls: "feed-back__action-submit disabled", text: "提交" });
  pop.append(tagNoHelp, tagOther, tagFake, detail, cancel, submit);
  doc.append(icon);
  doc.append(pop);

  let tagTimer = null;
  icon.onClick = () => {
    pop.style.display = "block";
  };
  tagNoHelp.onClick = (el) => {
    // 时序坑: 勾上后要等约 600ms 才看得到 checked 与可提交
    el.classList.add("checked");
    if (tagTimer) return;
    tagTimer = setTimeout(() => {
      submit.className = "feed-back__action-submit";
    }, 0);
  };
  submit.onClick = () => {
    pop.style.display = "none";
  };

  const clock = makeClock(doc);
  // applyPending: 假时钟推进时执行一次排队的 class 变化(模拟 600ms 后 Vue 更新)
  const origSleep = clock.sleep;
  const r = await rateCai({
    doc,
    reason: "只给结论没有解释机制",
    sleep: async (ms) => {
      await origSleep(ms);
      if (tagTimer) {
        const t = tagTimer;
        tagTimer = null;
        clearTimeout(t);
        submit.className = "feed-back__action-submit";
      }
    },
    now: clock.now,
  });
  ok(tagNoHelp.classList.contains("checked"), "踩: 勾的是「没有帮助」标签");
  ok(!tagFake.classList.contains("checked"), "踩: 没有误勾其它标签");
  eq(box.value, "只给结论没有解释机制", "踩: 理由写进 feed-back__detail 里的 textarea");
  eq(cancel.clicked, 0, "踩: 「取消」一次都没点");
  eq(submit.clicked, 1, "踩: 提交按钮按文案挑且跳过了 disabled");
  ok(r.ok, "踩: 提交后 .el-popover 的 display 变 none → 成功");
}

{
  // 提交按钮一直 disabled → 不点「取消」, 报错
  const doc = new FakeDoc();
  const icon = new FakeEl("i", { cls: "iconfont icon-cai" });
  const pop = new FakeEl("div", { cls: "el-popover feed-back" });
  const tag = new FakeEl("div", { cls: "feed-back__tag", text: "没有帮助" });
  const cancel = new FakeEl("div", { cls: "feed-back__action-submit", text: "取消" });
  const submit = new FakeEl("div", { cls: "feed-back__action-submit disabled", text: "提交" });
  pop.append(tag, cancel, submit);
  doc.append(icon);
  doc.append(pop);
  icon.onClick = () => {};
  tag.onClick = (el) => el.classList.add("checked");
  const clock = makeClock(doc);
  const r = await rateCai({ doc, reason: "x", sleep: clock.sleep, now: clock.now });
  ok(!r.ok, "踩: 没有可用「提交」(disabled) → 失败");
  eq(cancel.clicked, 0, "踩: 失败时也没有误点「取消」");
}

{
  // 标签没勾上 → 失败, 不提交
  const doc = new FakeDoc();
  const icon = new FakeEl("i", { cls: "iconfont icon-cai" });
  const pop = new FakeEl("div", { cls: "el-popover feed-back" });
  const tag = new FakeEl("div", { cls: "feed-back__tag", text: "没有帮助" });
  const submit = new FakeEl("div", { cls: "feed-back__action-submit", text: "提交" });
  pop.append(tag, submit);
  doc.append(icon);
  doc.append(pop);
  const clock = makeClock(doc);
  const r = await rateCai({ doc, reason: "x", sleep: clock.sleep, now: clock.now });
  ok(!r.ok && /勾上/.test(r.reason), "踩: 标签没勾上 → 失败并写明原因");
  eq(submit.clicked, 0, "踩: 标签没勾上时不去点提交");
}

/* ================= 6. 串行整轮: 单题失败继续下一题 ================= */

function makeTutorPage({ newChatFailures = 0, shortReplyFor = -1 } = {}) {
  const doc = new FakeDoc();
  const win = doc.defaultView;
  const list = new FakeEl("div", { cls: "message-list", text: "旧会话" });
  const newChat = new FakeEl("div", { cls: "new-chat-btn" });
  const input = new FakeEl("div", { cls: "input-body ProseMirror", attrs: { contenteditable: "true" } });
  const send = new FakeEl("button", { cls: "send-button", width: 36 });
  const primary = new FakeEl("button", { cls: "el-button el-button--primary", text: "发送" });
  const zan = new FakeEl("i", { cls: "iconfont icon-zan" });
  const cai = new FakeEl("i", { cls: "iconfont icon-cai" });
  const pop = new FakeEl("div", { cls: "el-popover feed-back" });
  pop.style.display = "block";
  const tag = new FakeEl("div", { cls: "feed-back__tag", text: "没有帮助" });
  const reasonBox = new FakeEl("textarea", { cls: "el-textarea__inner" });
  const submitBtn = new FakeEl("div", { cls: "feed-back__action-submit", text: "提交" });
  pop.append(tag, reasonBox, submitBtn);
  doc.append(list);
  doc.append(newChat);
  doc.append(input);
  doc.append(send);
  doc.append(primary);
  doc.append(zan);
  doc.append(cai);
  doc.append(pop);
  cai.onClick = () => {
    pop.style.display = "block";
  };
  tag.onClick = (el) => el.classList.add("checked");
  submitBtn.onClick = () => {
    pop.style.display = "none";
  };

  doc.execCommandImpl = (cmd, text) => {
    if (cmd !== "insertText") return false;
    input.textContent = text;
    return true;
  };
  let nChat = 0;
  newChat.onClick = () => {
    nChat++;
    if (nChat <= newChatFailures) {
      list.textContent = "旧会话还在"; // 会话没变空
      return;
    }
    list.textContent = "";
  };
  zan.onClick = (el) => el.classList.add("actived");

  let asked = 0;
  let growth = 0;
  const clock = makeClock(doc);
  send.onClick = () => {
    asked++;
    input.textContent = "";
    const q = input._lastQuestion;
    list.textContent = q;
    growth = 0;
    doc.tick = () => {
      if (growth < 3) {
        growth++;
        const body = shortReplyFor === asked ? "短答案" : "完整解释".repeat(80);
        list.textContent = q + body.repeat(growth);
      }
    };
  };
  return { doc, win, list, newChat, input, send, primary, zan, clock, state: () => ({ asked }) };
}

{
  const page = makeTutorPage({ newChatFailures: 1, shortReplyFor: 2 });
  const { doc, clock } = page;
  // 记录每题写入的题目, 供 send 回显
  const origWrite = doc.execCommandImpl;
  let lastText = "";
  doc.execCommandImpl = (cmd, text) => {
    lastText = text;
    page.input._lastQuestion = text;
    return origWrite(cmd, text);
  };
  const items = ["第一题: 机会成本", "第二题: 需求曲线", "第三题: 乘数"];
  const events = [];
  const stats = await runTutorRound({
    doc,
    win: page.win,
    items,
    opts: { minChars: 300, stableMs: 8000, replyTimeoutMs: 180000, noReplyGraceMs: 30000, newChatWaitMs: 8000 },
    log: () => {},
    onItem: (i, st, extra) => events.push([i, st, (extra && extra.note) || ""]),
    sleep: clock.sleep,
    now: clock.now,
  });
  eq(stats.total, 3, "整轮: 3 题都进清单");
  ok(stats.failed >= 1, "整轮: 第 1 题新建会话失败 → 记失败");
  ok(events.some(([i, st]) => i === 0 && st === "失败"), "整轮: 第 1 题状态是「失败」");
  ok(events.some(([i, st]) => i === 1 && st === "已评价"), "整轮: 第 1 题失败后仍然做了第 2 题");
  ok(events.some(([i, st]) => i === 2 && st === "已评价"), "整轮: 第 3 题也做了(不中断整轮)");
  ok(stats.cai >= 1, "整轮: 短回复被踩");
  ok(stats.zan >= 1, "整轮: 长回复被赞");
  eq(stats.rated, stats.zan + stats.cai, "整轮: 已评价数 = 赞 + 踩");
  eq(page.primary.clicked, 0, "整轮: 上传弹窗的 el-button--primary 一次都没点");
}

{
  // 停止: 第一题发完就停 → 后面不再发
  const page = makeTutorPage();
  const { doc, clock } = page;
  const orig = doc.execCommandImpl;
  doc.execCommandImpl = (cmd, text) => {
    page.input._lastQuestion = text;
    return orig(cmd, text);
  };
  let stop = false;
  const events = [];
  const stats = await runTutorRound({
    doc,
    win: page.win,
    items: ["甲", "乙", "丙"],
    opts: {},
    log: () => {},
    onItem: (i, st) => events.push([i, st]),
    shouldStop: () => stop,
    sleep: async (ms) => {
      await clock.sleep(ms);
      if (events.some(([i, st]) => i === 0 && st === "已提问")) stop = true; // 第一题发出后立刻停
    },
    now: clock.now,
  });
  ok(stats.stopped, "停止: 本轮标记为已停止");
  eq(page.state().asked, 1, "停止: 只发了第一题");
  ok(!events.some(([i]) => i === 1 || i === 2), "停止: 第二、三题一行都没动");
}

/* ================= 7. 新建会话等待 ================= */

{
  const doc = new FakeDoc();
  const list = new FakeEl("div", { cls: "message-list", text: "旧会话内容" });
  const btn = new FakeEl("div", { cls: "new-chat-btn" });
  doc.append(list);
  doc.append(btn);
  btn.onClick = () => {
    list.textContent = "";
  };
  const clock = makeClock(doc);
  const r = await startNewChat(doc, { sleep: clock.sleep, now: clock.now });
  ok(r.ok, "新建会话: 点击后会话变空 → 成功");
  ok(isEmptyChat(doc), "新建会话: 会话为空态");
}

{
  const doc = new FakeDoc();
  const list = new FakeEl("div", { cls: "message-list", text: "旧会话内容" });
  const btn = new FakeEl("div", { cls: "new-chat-btn" });
  doc.append(list);
  doc.append(btn);
  const clock = makeClock(doc);
  const r = await startNewChat(doc, { sleep: clock.sleep, now: clock.now, waitMs: 4000 });
  ok(!r.ok, "新建会话: 一直没变空 → 失败(不硬发)");
  ok(/没变空/.test(r.reason), "新建会话: 失败原因写明会话没变空");
}

/* ================= 8. 路由识别(不与 zj/zy/ks/chapter 冲突) ================= */

{
  globalThis.window = globalThis; // adapters/vendor 里的 typr 读 window
  const { createAdapterForUrl } = await import("../src/adapters/index.js");
  const base = "https://robot-lc.chaoxing.com/courseCozeV3/web?scene=course&unitId=1838&robotId=4a3e9287854b48758ca75289df6ea28b";
  const r = createAdapterForUrl(base);
  ok(r && r.platform === "cx" && r.workType === "ai-tutor", "路由: AI助教页 → cx/ai-tutor");
  ok(r && r.makeHandler() === null, "路由: AI助教不走答题适配器(面板按钮才适用)");
  const zj = createAdapterForUrl("https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=1");
  ok(zj.workType === "zj", "路由: 章节作业页仍是 zj(没被抢)");
  const ks = createAdapterForUrl("https://mooc1.chaoxing.com/mooc-ans/exam-ans/exam?x=1");
  ok(ks.workType === "ks", "路由: 考试页仍是 ks");
  const other = createAdapterForUrl("https://robot-lc.chaoxing.com/other/page");
  ok(!other || other.workType !== "ai-tutor", "路由: 同域其它路径不当 AI助教");
}

console.log(`\n${fail ? "❌" : "✅"} AI助教: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
