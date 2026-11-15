// 智慧树「新形态课程」的刷题页适配器（课后复习 → AI推荐练习 → /weakTest）。
//
// 真机结构（2026-11-09，习题页 https://ai-smart-course-student-pro.zhihuishu.com/weakTest?...）：
//   .question-preview.weak-test-preview
//     .question-type         【多选题】
//     .stem                  题干
//     ul.checkbox-view / ul.radio-view → li
//        label.el-checkbox|el-radio
//          input.el-checkbox__original|el-radio__original（value=1/2/3/4）
//          span.el-checkbox__label              选项字母 "A."
//        pre.preStyle                            选项正文
//     .next-btns                "提交"（练习页由用户自己按，半自动不代交）
//
// 与老版考试页（stuExamWeb.html）的差异：这里没有 .examPaper_subject，题型直接写在
// .question-type 里，选项也没有 .node_detail。所以单独一个适配器，不复用 ZhsAdapter 的解析。
//
// 2026-11-09 又接了一种页（复习测试/考试，studentexamcomh5.zhihuishu.com/studentReviewTestOrExam/）：
//   .questionContent
//     .questionName .questionTitle .letterSortNum   "1. 多选题"
//     .questionName .centent-pre pre.preStyle       题干
//     .checkbox-views .checkbox-view label.el-checkbox   多选（单选是 .radio-view label.el-radio）
//        input.el-checkbox__original（value=选项 id）
//        span.el-checkbox__label > span.letterSort + pre.preStyle
//   一页一题，答题卡点题号换题；「提交作业」由用户自己按，填入不代交。
import { BaseAdapter } from "./base.js";
import { normalizeJudgementText, judgeAnswerToBool } from "../core/text.js";
import { findMatchedOption } from "../core/matcher.js";

const ZHS_Q_TYPE = {
  single: "单选题",
  multi: "多选题",
  judge: "判断题",
  fill: "填空题",
  essay: "简答题",
};

/** 逐项点击之间要留一口气: 同一帧连点两个选项, Vue 的响应式状态会只记住后一个(2026-11-09 真机) */
const CLICK_GAP_MS = 350;
const reviewSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 是否是练习页（/weakTest） */
export function isZhsWeakTestPage(url) {
  try {
    return new URL(String(url || "")).pathname === "/weakTest";
  } catch (e) {
    return false;
  }
}

/** 是否是复习测试/考试页（studentexamcomh5.zhihuishu.com/studentReviewTestOrExam/） */
export function isZhsReviewTestPage(url) {
  try {
    const u = new URL(String(url || ""));
    return /(^|\.)zhihuishu\.com$/i.test(u.hostname) && u.pathname.startsWith("/studentReviewTestOrExam/");
  } catch (e) {
    return false;
  }
}

/**
 * 复习测试页当前题目的指纹。页面一题一 DOM，换题后旧元素会失效；
 * 用它判断「用户已经翻到下一题了」，好让面板自动重新解析。
 * 返回空串表示页面上还没有题目（切换动画中间态）。
 */
export function zhsReviewTestSignature(doc) {
  if (!doc) return "";
  // 页面可能同时挂着多份题目 DOM（预加载/切换动画），取最后一个当「当前题」。
  let root = null;
  if (doc.querySelectorAll) {
    const roots = doc.querySelectorAll(".questionContent");
    if (roots && roots.length) root = roots[roots.length - 1];
  }
  if (!root && doc.querySelector) root = doc.querySelector(".questionContent");
  if (!root) return "";
  const num = ((root.querySelector(".questionTitle .letterSortNum") || {}).textContent || "").trim();
  const stem = ((root.querySelector(".questionName .centent-pre pre.preStyle") || {}).textContent || "").replace(/\s+/g, " ").trim();
  const count = root.querySelectorAll
    ? root.querySelectorAll(".checkbox-view label.el-checkbox, .radio-view label.el-radio, ul.radio-view > li, ul.checkbox-view > li").length
    : 0;
  if (!num && !stem && !count) return "";
  return `${num}|${stem}|${count}`;
}

/** 从 .question-type 文本判定题型 */
export function inferZhsReviewType(typeText) {
  const t = String(typeText || "");
  if (t.includes("多选")) return ZHS_Q_TYPE.multi;
  if (t.includes("判断")) return ZHS_Q_TYPE.judge;
  if (t.includes("填空")) return ZHS_Q_TYPE.fill;
  if (t.includes("简答")) return ZHS_Q_TYPE.essay;
  return ZHS_Q_TYPE.single;
}

/**
 * 解析练习页的题目（可能是单题，也可能滚动列表里的多题）。
 * @param {Document} doc
 * @returns {Array} 统一 question 结构
 */
export function parseZhsReviewQuestions(doc, refer) {
  if (!doc || !doc.querySelectorAll) return [];
  const out = [];
  doc.querySelectorAll(".question-preview").forEach((root) => {
    const typeText = ((root.querySelector(".question-type") || {}).textContent || "").trim();
    const stem = ((root.querySelector(".stem") || {}).textContent || "").replace(/\s+/g, " ").trim();
    const type = inferZhsReviewType(typeText);
    const optionElements = Array.from(root.querySelectorAll("ul.checkbox-view li, ul.radio-view li"));
    const options = {};
    const optionTexts = [];
    optionElements.forEach((li) => {
      const pre = li.querySelector("pre.preStyle");
      const label = li.querySelector(".el-checkbox__label, .el-radio__label");
      const text = ((pre && pre.textContent) || (label && label.textContent) || li.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      options[text] = li;
      optionTexts.push(text);
    });
    if (!stem && !optionTexts.length) return;
    out.push({
      element: root,
      type,
      title: stem,
      optionsText: optionTexts,
      options,
      answer: [],
      workType: "zhs",
      refer: refer || "",
    });
  });
  // 复习测试/考试页：一页一题，结构见文件头。
  doc.querySelectorAll(".questionContent").forEach((root) => {
    const typeText = ((root.querySelector(".questionTitle .letterSortNum") || {}).textContent || "").trim();
    const stemEl = root.querySelector(".questionName .centent-pre pre.preStyle") || root.querySelector(".questionName pre.preStyle");
    let stem = ((stemEl && stemEl.textContent) || "").replace(/\s+/g, " ").trim();
    const type = inferZhsReviewType(typeText);
    // 多选/判断用 Element UI 的 label；单选在这个页面是自定义 ul.radio-view > li（无 input，
    // 选中态是 i.checkedIcon），所以两种都收，label 命中就不再看 li。
    const labelEls = Array.from(root.querySelectorAll(".checkbox-view label.el-checkbox, .radio-view label.el-radio"));
    const listEls = labelEls.length ? [] : Array.from(root.querySelectorAll("ul.radio-view > li, ul.checkbox-view > li"));
    const optionElements = labelEls.concat(listEls);
    const options = {};
    const optionTexts = [];
    optionElements.forEach((label) => {
      const pre = label.querySelector("pre.preStyle") || label.querySelector("div.preStyle");
      const text = ((pre && pre.textContent) || (label.querySelector(".el-checkbox__label, .el-radio__label") || {}).textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      options[text] = label; // 元素本身就是 label 或 li，clickOption 会直接点它
      optionTexts.push(text);
    });
    if (!stem && optionTexts.length) {
      const name = root.querySelector(".questionName");
      stem = ((name && name.textContent) || "").replace(/\s+/g, " ").trim();
      if (typeText) stem = stem.replace(typeText, "").trim();
    }
    if (!stem && !optionTexts.length) return;
    out.push({
      element: root,
      type,
      title: stem,
      optionsText: optionTexts,
      options,
      answer: [],
      workType: "zhs",
      refer: refer || "",
    });
  });
  return out;
}

export class ZhsReviewAdapter extends BaseAdapter {
  constructor() {
    super();
    this.type = "zhs";
  }

  parseHtml() {
    if (!this._document) return;
    const refer = this._window ? this._window.location.href : "";
    parseZhsReviewQuestions(this._document, refer).forEach((q) => this.questions.push(q));
  }

  /** 选项是 li（Element UI 的 label 才带点击行为），统一点 label。
   *  2026-11-09 真机教训: 点完 label 再补点 input 会把刚勾上的又取消 —— Vue 的 checked
   *  是 nextTick 才同步的, 紧接着读 input.checked 仍是 false。这里只点一次。 */
  clickOption(optionElement) {
    if (!optionElement) return;
    // 复习测试页传进来的可能就是 label 或 li 本身；weakTest 传的是 li（label 在内部）。
    const isLabel = optionElement.matches && optionElement.matches("label.el-checkbox, label.el-radio");
    const label = isLabel ? optionElement : optionElement.querySelector("label.el-checkbox, label.el-radio");
    (label || optionElement).click();
  }

  /** 选项是否已选中：Element UI 看 input.checked；自定义 ul.radio-view 看 i.checkedIcon。 */
  isOptionChecked(optionElement) {
    if (!optionElement || !optionElement.querySelector) return false;
    const input = optionElement.querySelector("input");
    if (input) return !!input.checked;
    return !!optionElement.querySelector("i.checkedIcon");
  }

  clickOptionIfNeeded(optionElement) {
    if (this.isOptionChecked(optionElement)) return;
    this.clickOption(optionElement);
  }

  async fillQuestion(question) {
    if (!this._window) return;
    const t = question.type;
    if (t === "单选题" || t === "多选题") {
      const wanted = new Set();
      for (const answer of question.answer) {
        const optEl = findMatchedOption(question.options, answer);
        if (optEl) wanted.add(optEl);
      }
      // 多选题要"填空"而不是"只加不减": 页面上可能已有上一次或用户手点的勾选,
      // 留着就会多选一个, 提交出去就是错的。先把不在答案里的勾掉
      // (2026-11-09 真机: 前一轮测试留下的 A 一直挂着, 填入后变成 ABCD 全选)。
      if (t === "多选题") {
        for (const key in question.options) {
          const optEl = question.options[key];
          if (wanted.has(optEl)) continue;
          if (this.isOptionChecked(optEl)) {
            this.clickOption(optEl);
            await reviewSleep(CLICK_GAP_MS);
          }
        }
      }
      for (const optEl of wanted) {
        this.clickOptionIfNeeded(optEl);
        await reviewSleep(CLICK_GAP_MS);
      }
    } else if (t === "判断题") {
      const bool = judgeAnswerToBool(question.answer[0]);
      for (const key in question.options) {
        if (normalizeJudgementText(key) === bool) {
          this.clickOptionIfNeeded(question.options[key]);
          await reviewSleep(CLICK_GAP_MS);
        }
      }
    } else if (t === "填空题" || t === "简答题") {
      this.fillTextQuestion(question);
    }
  }

  fillTextQuestion(question) {
    const root = question.element;
    if (!root || !root.querySelectorAll) return;
    const fields = [
      ...Array.from(root.querySelectorAll("input")),
      ...Array.from(root.querySelectorAll("textarea")),
      ...Array.from(root.querySelectorAll('[contenteditable="true"]')),
    ].filter((field) => {
      if (field.tagName === "INPUT") {
        const type = (field.getAttribute("type") || "text").toLowerCase();
        return ["", "text", "search", "number", "tel", "url", "email"].includes(type) && !field.disabled;
      }
      return true;
    });
    fields.forEach((field, index) => {
      const answer = question.answer[index] || question.answer[0] || "";
      if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
        field.value = answer;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        field.textContent = answer;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }
}
