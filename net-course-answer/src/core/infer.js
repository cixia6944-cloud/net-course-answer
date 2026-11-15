// 题型推断:纯 DOM 结构 cue → QTYPE 数字(移植自 0.2.4 BaseQuestionHandler.inferQuestionTypeByStructure)。
import { QTYPE, QTYPE_NAME } from "./types.js";
import { normalizeJudgementText } from "./text.js";

/** 候选属性/元素里是否含任一 cue 词 */
function hasControlCue(optionElement, cues) {
  const cueText = [
    optionElement.getAttribute("role"),
    optionElement.getAttribute("type"),
    optionElement.getAttribute("class"),
    optionElement.querySelector("input")?.getAttribute("type"),
    optionElement.querySelector("[role]")?.getAttribute("role"),
  ].filter(Boolean).join(" ").toLowerCase();
  return cues.some((cue) => cueText.includes(cue));
}

function hasFillBlankControl(questionElement) {
  const textInputs = Array.from(questionElement.querySelectorAll("input")).filter((input) => {
    const type = (input.getAttribute("type") || "text").toLowerCase();
    return ["", "text", "search", "number", "tel", "url", "email"].includes(type) && !input.disabled && !input.hidden;
  });
  const textareas = questionElement.querySelectorAll("textarea");
  const editableElements = questionElement.querySelectorAll('[contenteditable="true"]');
  const hasBlankCue = Array.from(questionElement.querySelectorAll("[class], [name], [placeholder]")).some((el) => {
    const joined = [el.getAttribute("class"), el.getAttribute("name"), el.getAttribute("placeholder")]
      .filter(Boolean).join(" ").toLowerCase();
    return joined.includes("blank") || (el.getAttribute("placeholder") || "").includes("填");
  });
  return textInputs.length > 0 || editableElements.length > 0 || textareas.length > 1 || hasBlankCue;
}

const hasLongTextControl = (questionElement) => questionElement.querySelectorAll("textarea").length > 0;

function hasCheckboxControl(questionElement, optionElements) {
  if (questionElement.querySelector('input[type="checkbox"]')) return true;
  return optionElements.some((oe) => hasControlCue(oe, ["checkbox", "multi", "multiple"]));
}

function hasRadioControl(questionElement, optionElements) {
  if (questionElement.querySelector('input[type="radio"]')) return true;
  return optionElements.some((oe) => hasControlCue(oe, ["radio"]));
}

const JUDGEMENT_CUES = ["judge", "judgement", "judgment", "truefalse", "true-false", "true_false", "判断", "对错"];
const CUE_ATTRIBUTES = ["aria-label", "class", "data", "data-qtype", "data-question-type", "data-type", "name", "role", "type", "value"];

function collectElementCueText(element) {
  const cueElements = [element, ...Array.from(element.querySelectorAll(CUE_ATTRIBUTES.map((a) => `[${a}]`).join(",")))];
  return cueElements.flatMap((ce) => CUE_ATTRIBUTES.map((a) => ce.getAttribute(a) || "")).filter(Boolean).join(" ");
}

function hasJudgementStructureCue(questionElement, optionElements) {
  const cueText = [collectElementCueText(questionElement), ...optionElements.map(collectElementCueText)].join(" ").toLowerCase();
  if (JUDGEMENT_CUES.some((cue) => cueText.includes(cue))) return true;
  const ariaLabels = optionElements.map((oe) => [
    oe.getAttribute("aria-label"),
    oe.querySelector("[aria-label]")?.getAttribute("aria-label"),
  ].filter(Boolean).join(" ")).join(" ");
  return ariaLabels.includes("对选择") && ariaLabels.includes("错选择");
}

function isJudgementQuestion(questionElement, optionElements, optionTexts) {
  if (optionTexts.length !== 2) return false;
  const values = optionTexts.map(normalizeJudgementText);
  return values.includes("true") && values.includes("false") && hasJudgementStructureCue(questionElement, optionElements);
}

/**
 * 由题目 DOM 结构推断题型(优先级同 0.2.4):填空→简答→多选→判断→单选→兜底。
 * @returns {string} QTYPE 数字
 */
export function inferQuestionTypeByStructure(questionElement, optionElements, optionTexts) {
  if (hasFillBlankControl(questionElement)) return QTYPE.FILL;
  if (hasLongTextControl(questionElement) && optionElements.length === 0) return QTYPE.ESSAY;
  if (hasCheckboxControl(questionElement, optionElements)) return QTYPE.MULTI;
  if (isJudgementQuestion(questionElement, optionElements, optionTexts)) return QTYPE.JUDGE;
  if (hasRadioControl(questionElement, optionElements)) return QTYPE.SINGLE;
  if (optionElements.length > 0) return QTYPE.SINGLE;
  return QTYPE.UNKNOWN;
}

/** 数字题型 → 中文(zhs 适配器用) */
export function qtypeToName(type) {
  return QTYPE_NAME[type] || "未知题";
}
