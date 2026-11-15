#!/usr/bin/env node
// P1 自动提交单元自测(纯 node, 假 DOM) —— node tools/submit-test.mjs
// 覆盖: 页面函数式提交 / DOM 兜底 / 二次确认层 / 已完成不重复提交 /
//       低阈值暂存 / 找不到按钮 / 提交后未能验证 / 文本兜底找按钮 / alert 静音。
import { autoSubmitWork, findDoneWord, findSubmitButton, findDraftButton, SUBMIT_SEL, DRAFT_SEL, CONFIRM_SEL, DONE_WORDS } from "../src/core/submit.js";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 极简假 DOM ---------- */
function mkEl(label = "", { tag = "a", onclick = "" } = {}) {
  return {
    tagName: tag.toUpperCase(),
    textContent: label,
    value: label,
    clicks: 0,
    getAttribute: (n) => (n === "onclick" ? onclick : null),
    click() {
      this.clicks++;
      this._on && this._on();
    },
  };
}
/** @param {string} text 页面可见文字 @param {Object} sels {选择器: 元素[]} */
function mkDoc(text = "", sels = {}) {
  const doc = {
    documentElement: { innerText: text },
    body: { innerText: text },
    _sels: sels,
    querySelector(sel) {
      return (sels[sel] || [])[0] || null;
    },
    querySelectorAll(sel) {
      if (sels[sel]) return sels[sel];
      return [];
    },
    // 供"提交后页面变字"用
    setText(t) {
      this.documentElement.innerText = t;
      this.body.innerText = t;
    },
  };
  return doc;
}
const logs = [];
const log = (m, t) => logs.push(`${t || "info"}|${m}`);
const has = (kw) => logs.some((l) => l.includes(kw));

async function main() {
  console.log("== 1) 页面函数式: btnBlueSubmit + submitCheckTimes, 提交后页面变「待批阅」");
  {
    logs.length = 0;
    const doc = mkDoc("");
    let submitted = 0;
    const win = {
      btnBlueSubmit: () => {
        win._blue = (win._blue || 0) + 1;
      },
      submitCheckTimes: () => {
        submitted++;
        doc.setText("作业已提交 待批阅");
      },
      alert: (m) => logs.push("ALERT|" + m),
    };
    const origAlert = win.alert;
    const r = await autoSubmitWork({ win, doc, log, sleep, threshold: 85, correctRate: 100, confirmTimeoutMs: 300 });
    ok(r.ok && r.reason === "submitted", `提交成功(reason=${r.reason})`);
    ok(win._blue === 1 && submitted === 1, "两个页面函数各调 1 次");
    ok(has("提交成功"), "日志写了提交成功");
    ok(win.alert !== origAlert, "alert 被静音(替换成空函数)");
  }

  console.log("== 2) DOM 兜底: 无页面函数 → 点 a.btnSubmit, 再点二次确认层");
  {
    logs.length = 0;
    const confirm = mkEl("确定", { tag: "div" });
    const submit = mkEl("提交");
    const doc = mkDoc("", { "a.btnSubmit": [submit], ".layui-layer-btn0": [confirm] });
    confirm._on = () => doc.setText("已完成");
    const r = await autoSubmitWork({ win: {}, doc, log, sleep, threshold: 85, correctRate: 100, confirmWaitMs: 100 });
    ok(r.ok && r.reason === "submitted", `DOM 提交成功(reason=${r.reason})`);
    ok(submit.clicks === 1, "提交按钮被点了 1 次");
    ok(confirm.clicks === 1, "二次确认被点了 1 次");
  }

  console.log("== 3) 页面已是「已完成」→ 不重复提交");
  {
    logs.length = 0;
    const submit = mkEl("提交");
    const doc = mkDoc("本作业已完成", { "a.btnSubmit": [submit] });
    const r = await autoSubmitWork({ win: {}, doc, log, sleep });
    ok(r.ok && r.reason === "already-done", `reason=${r.reason}`);
    ok(submit.clicks === 0, "没点任何提交按钮");
    ok(has("不重复提交"), "日志说明了原因");
    ok(findDoneWord(doc) === "已完成", "findDoneWord 命中「已完成」");
  }

  console.log("== 4) 正确率低于阈值 → 暂存(noSubmit), 不提交");
  {
    logs.length = 0;
    const doc = mkDoc("");
    let draft = 0;
    const win = { noSubmit: () => draft++, btnBlueSubmit: () => logs.push("BAD|不该提交") };
    const r = await autoSubmitWork({ win, doc, log, sleep, threshold: 85, correctRate: 60 });
    ok(!r.ok && r.reason === "below-threshold", `reason=${r.reason}`);
    ok(draft === 1, "调了 noSubmit 暂存");
    ok(!logs.some((l) => l.startsWith("BAD")), "没有误提交");
  }

  console.log("== 5) 低于阈值 + 明确不要暂存 → 什么都不做");
  {
    logs.length = 0;
    const doc = mkDoc("");
    const win = { noSubmit: () => logs.push("BAD|不该暂存") };
    const r = await autoSubmitWork({ win, doc, log, sleep, threshold: 85, correctRate: 10, saveDraftBelow: false });
    ok(!r.ok && r.reason === "below-threshold", `reason=${r.reason}`);
    ok(!logs.some((l) => l.startsWith("BAD")), "既没提交也没暂存");
  }

  console.log("== 6) 找不到提交按钮 → 明确报错(不静默)");
  {
    logs.length = 0;
    const doc = mkDoc("有些题目");
    const r = await autoSubmitWork({ win: {}, doc, log, sleep });
    ok(!r.ok && r.reason === "no-submit-button", `reason=${r.reason}`);
    ok(has("没找到提交按钮"), "日志提醒人工提交");
  }

  console.log("== 7) 点了但页面没变化 → unverified(诚实报告)");
  {
    logs.length = 0;
    const submit = mkEl("提交");
    const doc = mkDoc("", { "a.btnSubmit": [submit] });
    const r = await autoSubmitWork({ win: {}, doc, log, sleep, confirmWaitMs: 50, confirmTimeoutMs: 200, settleMs: 50 });
    ok(!r.ok && r.reason === "unverified", `reason=${r.reason}`);
    ok(submit.clicks === 1, "还是点了提交");
    ok(has("请人工确认"), "日志提醒人工确认");
  }

  console.log("== 8) 文本兜底: 按钮没有 id/class, 只写了「提交作业」");
  {
    const btn = mkEl("提交作业", { tag: "button" });
    const doc = mkDoc("", { "a, button, input, div, span": [mkEl("暂存"), btn] });
    ok(findSubmitButton(doc) === btn, "按文字找到「提交作业」");
    ok(findSubmitButton(doc) !== undefined, "返回的不是暂存按钮");
  }

  console.log("== 9) 文本兜底: 暂存按钮优先按 onclick=noSubmit 找");
  {
    const draft = mkEl("暂 存", { tag: "a", onclick: "noSubmit();" });
    const doc = mkDoc("", { "a[onclick*='noSubmit']": [draft] });
    ok(findDraftButton(doc) === draft, "找到暂存按钮");
  }

  console.log("== 10) 已交卷/已评分 也算「结果已出」");
  {
    ok(findDoneWord(mkDoc("本场考试已交卷")) === "已交卷", "「已交卷」命中");
    ok(findDoneWord(mkDoc("老师已评分")) === "已评分", "「已评分」命中");
    ok(findDoneWord(mkDoc("继续答题")) === null, "普通页面不误判");
  }

  console.log("== 11) 提交选择器/词表已单源到契约表(页面改版只改一处)");
  {
    const { CX_STUDY_SEL } = await import("../src/contract/cx-study-contract.js");
    const S = CX_STUDY_SEL.submit;
    ok(!!S, "契约表有 submit 组");
    ok(SUBMIT_SEL === S.submitBtn, "SUBMIT_SEL 与契约表 submit.submitBtn 是同一个数组(不会漂移)");
    ok(DRAFT_SEL === S.draftBtn, "DRAFT_SEL 与契约表 submit.draftBtn 是同一个数组");
    ok(CONFIRM_SEL === S.confirmBtn, "CONFIRM_SEL 与契约表 submit.confirmBtn 是同一个数组");
    ok(DONE_WORDS === S.doneWords, "DONE_WORDS 与契约表 submit.doneWords 是同一个数组");
    ok(SUBMIT_SEL.includes("a.btnSubmit") && SUBMIT_SEL.includes("#submitBtn"), "关键提交选择器仍在");
    ok(CONFIRM_SEL.includes(".layui-layer-btn0") && CONFIRM_SEL.includes("#popup_ok"), "关键确认选择器仍在");
    ok(DONE_WORDS.includes("已完成") && DONE_WORDS.includes("已提交"), "关键完成词仍在");
    ok(S.excludeWords.includes("暂存") && S.excludeWords.includes("取消"), "默认排除词仍在(不会误点暂存/取消)");
  }

  console.log(`\n${fail ? "❌ 有失败" : "✅ 全部通过"}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
