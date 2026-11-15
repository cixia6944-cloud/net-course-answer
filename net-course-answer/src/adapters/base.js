// 平台无关 Base 适配器:提供解析/填充共用的 DOM 提取原语。
// 具体平台(cx/zhs)继承并覆写 parseHtml/fillQuestion/选项选择器。
import { inferQuestionTypeByStructure } from "../core/infer.js";
import { removeHtml, clean } from "../core/text.js";

export class BaseAdapter {
  constructor() {
    // node 单测里既没有 document 也没有 window: 全部用 typeof 兜底(直接写 window 会 ReferenceError)
    this._document = typeof document !== "undefined" ? document : null;
    const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : typeof window !== "undefined" ? window : null;
    this._window = win || null;
    this.questions = [];
    this.correctNum = 0;
    this.type = ""; // workType: cx 用 zj/zy/ks;zhs 用 zhs
  }

  /**
   * 换一套 document/window(章节页的内嵌作业帧用: 顶层没有题, 题目在 doHomeWorkNew 那一帧里)。
   * 解析 / 填题 / 自动提交都以这一层为准 —— 文档和窗口必须成对换, 只换 doc 会让 autoSubmit 拿错 window。
   * @param {Document} doc 题目所在的文档
   * @param {Window} win 题目所在的窗口(页面函数 btnBlueSubmit/submitCheckTimes/UE 都在这一层)
   * @param {Window} [hostWin] 上层宿主窗口(章节页顶层) —— 字体 @font-face 可能注入在题目帧外面
   * @returns {this} 便于链式调用: new CxAdapter("zj").setContext(doc, win)
   */
  setContext(doc, win, hostWin) {
    if (doc) this._document = doc;
    if (win) this._window = win;
    if (hostWin) this._hostWin = hostWin;
    return this;
  }

  /** 子类必须覆写:把 this._document 里的题目塞进 this.questions */
  parseHtml() {
    throw new Error("请使用继承类的 parseHtml");
  }

  /** 子类必须覆写:把 question.answer 填回 question 的 DOM */
  fillQuestion(question) {
    throw new Error("请使用继承类的 fillQuestion");
  }

  /**
   * 从一组选项 DOM 提取 {文本→DOM} 与文本数组。
   * @param {NodeList|Element[]} optionElements
   * @param {string} optionSelector 选项内承载文本的子元素选择器(如 .answer_p)
   */
  extractOptions(optionElements, optionSelector) {
    const optionsObject = {};
    const optionTexts = [];
    (optionElements || []).forEach((optionElement) => {
      const textEl = optionElement.querySelector(optionSelector);
      const textContent = removeHtml(textEl ? textEl.innerHTML : "");
      optionsObject[textContent] = optionElement;
      optionTexts.push(textContent);
    });
    return [optionsObject, optionTexts];
  }

  /** 统一 question 构造入口(平台解析后调用) */
  makeQuestion(questionElement, { title, optionElements, optionSelector, type, workType }) {
    const [options, optionTexts] = this.extractOptions(optionElements, optionSelector);
    return {
      element: questionElement,
      type: type ?? inferQuestionTypeByStructure(questionElement, optionElements ? Array.from(optionElements) : [], optionTexts),
      title: clean(title),
      optionsText: optionTexts,
      options,
      answer: [],
      workType: workType || this.type,
      refer: this._window ? this._window.location.href : "",
    };
  }
}
