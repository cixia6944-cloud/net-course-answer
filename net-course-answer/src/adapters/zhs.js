// 智慧树(zhs)适配器:页面经 Vue(iView 2.5)渲染, 题干需经 hookWebpack 注入的 __Ivue__ 读取。
// 0.2.4 链路: 需 hookWebpack(拦 Function.prototype.call 注入 __Ivue__) + hookError(反 checkoutNotTrustScript)
//          + XHR 拦 gateway/t/v1/answer/hasAnswer 触发答题。
// v0.1 本文件为可编译结构占位: DOM 契约(0.2.4 实际)已注释保留, 触发钩子在 runtime 侧留 TODO。
import { BaseAdapter } from "./base.js";
import { QTYPE_NAME } from "../core/types.js";
import { normalizeJudgementText, judgeAnswerToBool } from "../core/text.js";
import { findMatchedOption } from "../core/matcher.js";
import { inferQuestionTypeByStructure } from "../core/infer.js";

export class ZhsAdapter extends BaseAdapter {
  constructor() {
    super();
    this.type = "zhs";
  }

  parseHtml() {
    if (!this._document) return;
    const els = this._document.querySelectorAll(".examPaper_subject");
    els.forEach((el) => this.addQuestion(el));
  }

  addQuestion(questionElement) {
    // 题干: 优先经 Vue 内部 __Ivue__._data.shadowDom(0.2.4 实际), 兜底 textContent
    const titleEl = questionElement.querySelector(".subject_describe div, .smallStem_describe p");
    const vueData = titleEl?.__Ivue__?._data;
    const title = vueData?.shadowDom?.textContent || titleEl?.textContent || "";
    const optionElements = questionElement.querySelectorAll(".label");

    // 先按结构推断数字题型, 再映射成 zhs 用的中文题型名(0.2.4 行为)
    const numericType = this._inferNumeric(questionElement, optionElements);
    const typeName = QTYPE_NAME[numericType] || "未知题";

    const [options, optionTexts] = this.extractOptions(optionElements, ".node_detail");
    this.questions.push({
      element: questionElement,
      type: typeName, // zhs 用中文题型
      title,
      optionsText: optionTexts,
      options,
      answer: [],
      workType: "zhs",
      refer: this._window ? this._window.location.href : "",
    });
  }

  _inferNumeric(questionElement, optionElements) {
    const optionTexts = Array.from(optionElements || []).map((oe) =>
      oe.querySelector(".node_detail")?.textContent || ""
    );
    // 智慧树页面常无原生 input[type], 结构 cue 弱; 沿用结构推断, 必要时在浏览器实测校正
    return inferQuestionTypeByStructure(questionElement, Array.from(optionElements || []), optionTexts);
  }

  fillQuestion(question) {
    if (!this._window) return;
    const t = question.type;
    if (t === "单选题" || t === "多选题") {
      question.answer.forEach((answer) => {
        const optEl = findMatchedOption(question.options, answer);
        if (optEl) this.clickOptionIfNeeded(optEl);
      });
    } else if (t === "判断题") {
      const bool = judgeAnswerToBool(question.answer[0]);
      for (const key in question.options) {
        if (normalizeJudgementText(key) === bool) this.clickOptionIfNeeded(question.options[key]);
      }
    } else if (t === "填空题" || t === "简答题") {
      this.fillTextQuestion(question);
    }
  }

  clickOptionIfNeeded(optionElement) {
    const input = optionElement.querySelector("input");
    const cls = optionElement.getAttribute("class") || "";
    if (input?.checked) return;
    if (optionElement.getAttribute("aria-checked") === "true") return;
    if (/\b(active|checked|selected|is-checked)\b/.test(cls)) return;
    if (optionElement.querySelector(".active, .checked, .selected, .is-checked")) return;
    optionElement.click();
  }

  fillTextQuestion(question) {
    const fields = [
      ...Array.from(question.element.querySelectorAll("input")),
      ...Array.from(question.element.querySelectorAll("textarea")),
      ...Array.from(question.element.querySelectorAll('[contenteditable="true"]')),
    ].filter((field) => {
      if (field instanceof HTMLInputElement) {
        const type = (field.getAttribute("type") || "text").toLowerCase();
        return ["", "text", "search", "number", "tel", "url", "email"].includes(type) && !field.disabled && !field.hidden;
      }
      return true;
    });
    fields.forEach((field, index) => {
      const answer = question.answer[index] || question.answer[0] || "";
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
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
