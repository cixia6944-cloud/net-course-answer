// 超星(cx)适配器: zj=章节作业(.TiMu) / zy=新版作业页 / ks=考试页(均 .questionLi)。
// 所有选择器都来自 contract/cx-study-contract.js 的 CX_STUDY_SEL.answer —— 页面改版只改契约表。
import { BaseAdapter } from "./base.js";
import { removeHtml, clean, judgeAnswerToBool } from "../core/text.js";
import { QTYPE } from "../core/types.js";
import { findMatchedOption } from "../core/matcher.js";
import { decryptFonts, getLastError, getLastStats } from "../core/font-decrypt.js";
import { autoSubmitWork } from "../core/submit.js";
import { sleepMs } from "../vendor/gm.js";
import { CX_STUDY_SEL, findQuestionDoc, isReviewedView, judgeSpanSel, collectDocs } from "../contract/cx-study-contract.js";

const A = CX_STUDY_SEL.answer;

/** 勾选状态快照: aria + class + 页面隐藏域 input#answer<qid>(超星点完会写) */
function pickState(el, doc) {
  const qid = el.getAttribute && el.getAttribute("qid");
  const box = qid && doc ? doc.querySelector(`#answer${qid}`) : null;
  return {
    aria: el.getAttribute ? el.getAttribute("aria-checked") : null,
    cls: String(el.className || ""),
    box: box ? String(box.value || "") : null,
  };
}
/** 点完之后"到底有没有真的勾上" —— 任一信号变了就算生效 */
function stateChanged(el, doc, before) {
  const now = pickState(el, doc);
  if (before.aria != null && now.aria !== before.aria) return true;
  if (now.cls !== before.cls) return true; // ks: 点完会多出 .check_answer
  if (before.box != null && now.box !== before.box) return true; // zj/zy: 点完写隐藏域
  return false;
}
/** 兜底: 有的页面绑的是 mousedown/mouseup 而不是 click */
function pointerSequence(el) {
  try {
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView }));
    }
  } catch (e) {}
}

export class CxAdapter extends BaseAdapter {
  constructor(type, iframe) {
    super();
    this.type = type; // "zj" | "zy" | "ks"
    this.notes = []; // 供 runner 回显的提示/告警(如字体解密状态)
    if (iframe) {
      this._frameEl = iframe;
      this._document = iframe.contentDocument;
      this._window = iframe.contentWindow;
    }
  }

  parseHtml() {
    if (!this._document) return;
    // P0: 题目可能在多层 iframe 里(作业/测验实测 4 层: top>cards>work/index.html>api/work)
    // 先从"当前文档"找; 找不到就递归进 iframe 找含题目的那个文档。
    const selector = A.question[this.type] || A.question.zj;
    let doc = this._document;
    let elements = doc.querySelectorAll ? doc.querySelectorAll(selector) : [];
    if (!elements.length && this._window) {
      const hit = findQuestionDoc(this._window, CX_STUDY_SEL.work);
      if (hit) {
        // 文档和窗口必须成对换掉: 页面函数(btnBlueSubmit/submitCheckTimes/UE)定义在内层 window 上,
        // 只换 document 的话自动提交会拿错 window(见 autoSubmit)。
        doc = hit.doc;
        this._document = doc;
        this._activeWin = hit.win;
        this.notes.push({ msg: `题目在第 ${hit.depth} 层 iframe(${hit.path}), 已切换文档`, type: "primary" });
        elements = doc.querySelectorAll(selector);
        // 已批阅视图: 明确告知(只读, 不尝试填)
        if (isReviewedView(doc)) {
          this._reviewed = true;
          this.notes.push({ msg: "这是「已批阅」视图(只读), 只能看答案, 不能修改 —— 点「重做」才能作答", type: "warning" });
        }
      }
    }
    this.decryptPageFonts();
    elements.forEach((el) => this.addQuestion(el));
  }

  /** 题面字体解密: font-cxsecret 不处理则题干是乱码, pi 无法作答 */
  decryptPageFonts() {
    let hidden = 0;
    try {
      hidden = this._document.querySelectorAll("." + CX_STUDY_SEL.font.secretClass).length;
      if (!hidden) return;
      // @font-face 常常不在题目那一层: 章节测验里字体注入在 cards 页, 题目在 api/work。
      // 把从章节页往下所有层的 style 都当字体来源(解密只作用于题目文档本身)。
      // 内嵌接管时题目帧的上层是章节页(runtime 通过 setContext 塞的 _hostWin), 从顶层收才盖得全;
      // 用 iframe 元素构造时, 父文档就是那个宿主。
      const extraDocs = [];
      try {
        const hostWin =
          this._hostWin ||
          (this._frameEl && this._frameEl.ownerDocument && this._frameEl.ownerDocument.defaultView) ||
          this._window;
        collectDocs(hostWin, 6).forEach((x) => extraDocs.push(x.doc));
      } catch (e) {}
      const n = decryptFonts(this._document, { docs: extraDocs });
      if (n > 0) {
        const st = getLastStats();
        const partial = st.mapped < st.codes;
        this.notes.push({
          msg: `已解密 ${n} 处加密题面(${CX_STUDY_SEL.font.secretClass}), 码点映射 ${st.mapped}/${st.codes}`,
          type: partial ? "warning" : "primary",
        });
      } else {
        this.notes.push({
          msg: `题面字体解密失败(${getLastError() || "未知原因"}), 题干可能为乱码`,
          type: "danger",
        });
      }
    } catch (e) {
      this.notes.push({ msg: `题面字体解密异常: ${e && e.message ? e.message : e}`, type: "danger" });
    }
  }

  addQuestion(questionElement) {
    let title = "";
    let optionElements = [];
    let optionSelector = "";

    if (this.type === "zj") {
      // 章节作业: 题干 .fontLabel, 选项 [class*="before-after"] 内 .fl.after
      const s = A.zj;
      title = removeHtml(questionElement.querySelector(s.title)?.innerHTML || "");
      optionElements = questionElement.querySelectorAll(s.optionItem);
      optionSelector = s.optionText;
      // 兼容"已批阅/新版"结构: ul.Zy_ulTop(.qtDetail) > li > a.fl (没有 .fl.after)
      if (!optionElements.length) {
        const ul = questionElement.querySelector(s.optionListFallback);
        optionElements = ul ? ul.querySelectorAll(s.optionItemFallback) : [];
        optionSelector = s.optionTextFallback;
      }
    } else {
      // zy/ks 作业/考试: 题干 h3, 题型标签 .colorShallow 有就剥掉, 没有就用整个 h3; 选项 .answerBg 内 .answer_p
      // 以前是无条件 split(标签)[1] —— 考试页没有该标签时切出的 [1] 是 undefined, 题干直接变空串。
      const s = A.zy;
      const h3 = questionElement.querySelector(s.title);
      const strip = questionElement.querySelector(s.titleStrip);
      let raw = h3 ? h3.innerHTML : "";
      if (strip && h3) {
        const after = raw.split(strip.outerHTML)[1];
        if (after && clean(removeHtml(after))) raw = after; // 切空了就保留整个 h3
      }
      title = removeHtml(raw);
      optionElements = questionElement.querySelectorAll(s.optionItem);
      optionSelector = s.optionText;
    }

    const q = this.makeQuestion(questionElement, {
      title,
      optionElements,
      optionSelector,
      type: undefined, // 由结构推断
      workType: this.type,
    });
    this.questions.push(q);
  }

  /** 当前应操作的 window(递归切换后是内层 iframe 的 window) */
  activeWindow() {
    return this._activeWin || this._window;
  }

  /** P1 自动提交(考试 ks 不要调; 由 runtime 保证)
   *  必须把内层 window 一起交出去 —— btnBlueSubmit/submitCheckTimes/noSubmit 都定义在题目所在那一层。 */
  async autoSubmit(opts = {}) {
    return autoSubmitWork(Object.assign({ win: this.activeWindow(), doc: this._document }, opts));
  }

  /** 点选并**验证真的勾上了**(以前点完就报成功, 页面没响应时给出假成功) */
  async clickAndVerify(optEl) {
    const doc = this._document;
    const already =
      this.type === "zj" || this.type === "zy"
        ? optEl.getAttribute("aria-checked") === "true"
        : !!optEl.querySelector(A.judge.checked);
    if (already) return true;
    const before = pickState(optEl, doc);
    try {
      optEl.click();
    } catch (e) {}
    await sleepMs(120); // 给页面 handler 一点时间(超星是异步写状态)
    if (stateChanged(optEl, doc, before)) return true;
    pointerSequence(optEl); // 兜底: 换成 mousedown/mouseup/click 三连
    await sleepMs(150);
    return stateChanged(optEl, doc, before);
  }

  /**
   * 把文本写进输入控件(填空/简答共用)。
   * 顺序: UE 富文本(有名 textarea) → 原生 value setter + input/change(Vue/React 页面才认) → 直接赋值。
   * 以前简答分支直接 `this._window.UE.getEditor(...)`, 页面没有 UE 时抛异常 → 现在一律降级到写 value。
   */
  fillTextElement(el, value) {
    if (!el || value == null || value === "") return false;
    const win = this.activeWindow() || this._window;
    if (el.tagName === "TEXTAREA") {
      try {
        const ue = win && win.UE;
        if (ue && el.name && typeof ue.getEditor === "function") {
          ue.getEditor(el.name).setContent(value);
          return true;
        }
      } catch (e) {
        /* 没有 UE / 编辑器不存在 → 走下面的原生写入 */
      }
    }
    try {
      const Proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement : win.HTMLInputElement;
      const setter = Proto && Object.getOwnPropertyDescriptor(Proto.prototype, "value");
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      try {
        el.value = value;
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  async fillQuestion(question) {
    if (!this._window) return 0;
    let filled = 0;
    let t = question.type;
    // 简答题防护: 超星的简答是"隐藏 textarea + UE 富文本", 结构推断有时把它判成未知题型,
    // 判成未知就一个字都填不进去(真机 1.3 牛刀小试 5 题只有 3 题选择题成功)。这里按结构兜底。
    try {
      const el = question.element;
      const hasText = el.querySelectorAll("textarea").length > 0;
      const hasChoice = el.querySelectorAll('input[type="radio"], input[type="checkbox"]').length > 0;
      if (hasText && !hasChoice && t !== QTYPE.FILL) t = QTYPE.ESSAY;
    } catch (e) {}
    if (t === QTYPE.SINGLE || t === QTYPE.MULTI) {
      for (const answer of question.answer) {
        const optEl = findMatchedOption(question.options, answer);
        if (!optEl) continue;
        if (await this.clickAndVerify(optEl)) filled += 1;
      }
    } else if (t === QTYPE.FILL) {
      // 填空题: 逐空写入(UE → 原生 input/change → 直接赋值)
      const fields = question.element.querySelectorAll(A.fill.field);
      let filledFields = 0;
      fields.forEach((ta, idx) => {
        if (this.fillTextElement(ta, question.answer[idx] || question.answer[0] || "")) filledFields++;
      });
      return filledFields;
    } else if (t === QTYPE.JUDGE) {
      const bool = judgeAnswerToBool(question.answer[0]);
      const want = bool === "true" ? A.judge.ariaTrue : A.judge.ariaFalse;
      for (const key in question.options) {
        const optEl = question.options[key];
        if (this.type === "zj" || this.type === "zy") {
          if (optEl.getAttribute("aria-label")?.includes(want)) {
            if (await this.clickAndVerify(optEl)) filled += 1;
            break;
          }
        } else {
          const span = optEl.querySelector(judgeSpanSel(bool));
          if (!span) continue;
          if (await this.clickAndVerify(span)) filled += 1;
          break;
        }
      }
    } else if (t === QTYPE.ESSAY) {
      const ta = question.element.querySelector(A.fill.textarea);
      if (!ta) return 0;
      if (this.fillTextElement(ta, question.answer[0])) filled += 1;
    }
    // QTYPE.UNKNOWN: 不填, 记录即可
    return filled;
  }
}
