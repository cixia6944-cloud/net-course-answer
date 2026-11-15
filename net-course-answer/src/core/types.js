// 平台无关的类型/协议/常量定义。

/** 题型:代码层数字(0.2.4 兼容)。zhs 适配器会再映射成中文名。 */
export const QTYPE = {
  SINGLE: "0", // 单选
  MULTI: "1", // 多选
  FILL: "2", // 填空
  JUDGE: "3", // 判断
  ESSAY: "4", // 简答
  UNKNOWN: "999",
};

export const QTYPE_NAME = {
  [QTYPE.SINGLE]: "单选题",
  [QTYPE.MULTI]: "多选题",
  [QTYPE.FILL]: "填空题",
  [QTYPE.JUDGE]: "判断题",
  [QTYPE.ESSAY]: "简答题",
  [QTYPE.UNKNOWN]: "未知题",
};

/**
 * question 统一结构(与 0.2.4 handler 产出的 question 同构)。
 * @typedef {Object} Question
 * @property {Element} element      题干根 DOM(适配器解析出的)
 * @property {string} type          数字题型,见 QTYPE
 * @property {string} title         题干纯文本
 * @property {string[]} optionsText 选项文本数组
 * @property {Object<string, Element>} options 选项文本 → 选项 DOM(用于回填)
 * @property {string[]} answer      答案(运行期由 provider 填充)
 * @property {string} workType      cx:zj/zy/ks;zhs:zhs
 * @property {string} refer         来源 URL
 */

/**
 * AnswerProvider 协议:任何答题源实现此接口。
 * resolve(question) → { code:200, data:{ answer:string[], num?, usenum? } } 成功
 *               或 { code:10003, data:{answer:[]}, msg } 失败(0.2.4 handleError 同构)
 * @typedef {Object} AnswerProvider
 * @property {(q: Question) => Promise<import('./types.js').AnswerData>} resolve
 */

/** AnswerProvider 返回的答案数据(0.2.4 网络协议同构) */
export const OK_CODE = 200;
export const ERR_CODE = 10003;

/** 成功响应工厂 */
export function okAnswer(answer) {
  return { code: OK_CODE, data: { answer: answer || [], num: "", usenum: "" }, msg: "" };
}

/** 失败响应工厂(0.2.4 handleError 同构) */
export function errAnswer(msg) {
  return { code: ERR_CODE, data: { answer: [], num: "", usenum: "" }, msg };
}

/** 默认选项相似度阈值(%);与 0.2.4 一致,可在 UI 设置覆盖 */
export const DEFAULT_SIMILARITY_THRESHOLD = 85;

/** 单题等待答案的最长毫秒数(pi 桥首问冷启动约 10s,留足余量) */
export const ANSWER_TIMEOUT_MS = 90000;
