// P1 自动提交: 答完把作业/章节测验交上去。
// 超星作业页自带两个页面级函数(改造前 0.2.4 也是这么调的):
//   btnBlueSubmit()  —— 点"提交"按钮(会弹二次确认层)
//   submitCheckTimes() —— 确认层里那个"确定/继续提交"(真正提交)
//   noSubmit()       —— 暂存(不提交)
// 这里优先用页面函数; 拿不到就退回 DOM 选择器点击; 最后回读页面状态验证是否真的提交了。
// ⚠️ 考试(ks)页一律不自动提交(红线), 由调用方保证。
import { CX_STUDY_SEL } from "../contract/cx-study-contract.js";

// 选择器/词表统一来自契约表(页面改版只改 contract/cx-study-contract.js)。
// 下面这几个导出保留原名字, 供测试与未来复用; 不要在这里再新增写死的选择器。
const SUBMIT_CONTRACT = CX_STUDY_SEL.submit;

/** 页面出现这些字 → 作业已经有结果了, 别再提交 */
export const DONE_WORDS = SUBMIT_CONTRACT.doneWords;

/** 提交按钮候选(超星各版本) */
export const SUBMIT_SEL = SUBMIT_CONTRACT.submitBtn;

/** 暂存按钮候选 */
export const DRAFT_SEL = SUBMIT_CONTRACT.draftBtn;

/** 二次确认层里的"确定" */
export const CONFIRM_SEL = SUBMIT_CONTRACT.confirmBtn;

const CONFIRM_WORDS = SUBMIT_CONTRACT.confirmWords;

const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, "");

/** 页面是否已有结果(返回命中的字样) */
export function findDoneWord(doc) {
  let text = "";
  try {
    text = (doc.documentElement && doc.documentElement.innerText) || (doc.body && doc.body.innerText) || "";
  } catch (e) {}
  if (!text) return null;
  return DONE_WORDS.find((w) => text.includes(w)) || null;
}

function queryFirst(doc, sels) {
  for (const sel of sels) {
    try {
      const el = doc.querySelector(sel);
      if (el) return { el, sel };
    } catch (e) {}
  }
  return null;
}

/** 按钮文字兜底: 扫可点元素, 找带"提交/交卷"且不是"暂存/保存/取消"的 */
export function findByText(doc, words, exclude = SUBMIT_CONTRACT.excludeWords) {
  let els = [];
  try {
    els = Array.from(doc.querySelectorAll("a, button, input, div, span"));
  } catch (e) {}
  for (const el of els) {
    let label = "";
    try {
      label = el.tagName === "INPUT" ? el.value || "" : el.textContent || "";
    } catch (e) {}
    const t = norm(label);
    if (!t || t.length > 12) continue;
    if (!words.some((w) => t.includes(w))) continue;
    if (exclude.some((w) => t.includes(w))) continue;
    return el;
  }
  return null;
}

export function findSubmitButton(doc) {
  const hit = queryFirst(doc, SUBMIT_SEL);
  if (hit) return hit.el;
  return findByText(doc, ["提交", "交卷"]);
}

export function findDraftButton(doc) {
  const hit = queryFirst(doc, DRAFT_SEL);
  if (hit) return hit.el;
  return findByText(doc, ["暂存"]);
}

/** 二次确认层(等它出现: 超星是异步弹层) */
export async function findConfirm(doc, sleep, timeoutMs = 2500) {
  const t0 = Date.now();
  for (;;) {
    const hit = queryFirst(doc, CONFIRM_SEL);
    if (hit) return hit.el;
    const byText = findByText(doc, CONFIRM_WORDS, ["取消", "返回", "暂不"]);
    if (byText) return byText;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(200);
  }
}

/**
 * 自动提交(或按阈值暂存)。
 * @param {Object} cfg
 * @param {Window} cfg.win 作业页所在窗口(章节作业是 iframe 的 contentWindow)
 * @param {Document} cfg.doc 同上 document
 * @param {Function} cfg.log (msg, type)
 * @param {Function} cfg.sleep (ms) => Promise
 * @param {number} [cfg.threshold=85] 正确率阈值(%), 低于它就不提交
 * @param {number} [cfg.correctRate=100] 本轮估算正确率(%)
 * @param {boolean} [cfg.saveDraftBelow=true] 低于阈值时是否点"暂存"保住答案
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
export async function autoSubmitWork(cfg) {
  const { win, doc } = cfg;
  const log = cfg.log || (() => {});
  const sleep = cfg.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 85;
  const correctRate = Number.isFinite(cfg.correctRate) ? cfg.correctRate : 100;
  if (!win || !doc) return { ok: false, reason: "no-document" };

  const doneWord = findDoneWord(doc);
  if (doneWord) {
    log(`页面已是「${doneWord}」状态, 不重复提交`, "success");
    return { ok: true, reason: "already-done" };
  }

  // 低于阈值 → 不提交(可选暂存)
  const saveDraftBelow = cfg.saveDraftBelow !== false; // 默认: 低于阈值就暂存保住答案
  if (correctRate < threshold) {
    if (!saveDraftBelow) {
      log(`正确率 ${Math.round(correctRate)}% < 阈值 ${threshold}%, 不提交也不暂存`, "warning");
      return { ok: false, reason: "below-threshold" };
    }
    const viaPageFn = typeof win.noSubmit === "function";
    const btn = viaPageFn ? null : findDraftButton(doc);
    if (!viaPageFn && !btn) {
      log(`正确率 ${Math.round(correctRate)}% < 阈值 ${threshold}%, 且没找到暂存按钮, 请手动保存`, "warning");
      return { ok: false, reason: "below-threshold-no-draft" };
    }
    try {
      if (viaPageFn) win.noSubmit();
      else btn.click();
      log(`正确率 ${Math.round(correctRate)}% < 阈值 ${threshold}%, 已暂存(未提交)`, "warning");
    } catch (e) {
      log(`暂存失败: ${e && e.message}`, "danger");
      return { ok: false, reason: "draft-failed" };
    }
    return { ok: false, reason: "below-threshold" };
  }

  // 提交前先把页面 alert 静音(超星会弹"还有 N 次提交机会"之类)
  try {
    win.alert = () => {};
  } catch (e) {}

  const viaPageFn = typeof win.btnBlueSubmit === "function";
  const btn = viaPageFn ? null : findSubmitButton(doc);
  if (!viaPageFn && !btn) {
    log("没找到提交按钮, 请手动提交(答案已回填)", "warning");
    return { ok: false, reason: "no-submit-button" };
  }
  try {
    if (viaPageFn) win.btnBlueSubmit();
    else btn.click();
    log(btn && !viaPageFn ? "已点提交按钮(DOM)" : "已调用页面提交(btnBlueSubmit)", "primary");
  } catch (e) {
    log(`点提交失败: ${e && e.message}`, "danger");
    return { ok: false, reason: "click-failed" };
  }

  await sleep(cfg.confirmWaitMs || 1200);
  const confirmEl = await findConfirm(doc, sleep, cfg.confirmTimeoutMs || 2500);
  if (confirmEl) {
    try {
      confirmEl.click();
      log("已点掉二次确认(确定提交)", "primary");
    } catch (e) {}
  }
  // 页面函数式提交: 真正的提交动作在 submitCheckTimes 里
  if (typeof win.submitCheckTimes === "function") {
    try {
      win.submitCheckTimes();
    } catch (e) {}
  }
  await sleep(cfg.settleMs || 2000);

  const after = findDoneWord(doc);
  if (after) {
    log(`✅ 提交成功(页面显示「${after}」)`, "success");
    return { ok: true, reason: "submitted" };
  }
  log("已发出提交动作, 但页面还没出现「已完成/待批阅」, 请人工确认一眼", "warning");
  return { ok: false, reason: "unverified" };
}
