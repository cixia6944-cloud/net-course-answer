// AnswerProvider 抽象 + 默认实现(答题桥)。
import { errAnswer, okAnswer, ANSWER_TIMEOUT_MS } from "./types.js";
import { gmFetchJson } from "../vendor/gm.js";

/** 答题桥地址(answer-bridge/server.mjs);改端口需同步脚本 @connect */
export const PI_BRIDGE_BASE = "http://127.0.0.1:30142";

// 题型名统一用 core/types.js 的 QTYPE_NAME(唯一来源), 这里不再重复定义。

/**
 * 答题桥 AnswerProvider。
 * POST /ask {title, options, type} → {ok, answer: string[]} 或 {ok:false, error}。
 * 桥侧负责组装提示词并让 pi 只输出答案行;这里把响应包装成 0.2.4 同构协议。
 */
export class PiBridgeProvider {
  constructor(base = PI_BRIDGE_BASE) {
    this.base = base;
  }

  /** 探活: 桥没起时要能给用户明确提示("刷课能用但刷题不动"多半就是桥没开) */
  async health(timeout = 4000) {
    try {
      const r = await gmFetchJson(`${this.base}/health`, { method: "GET", timeout });
      return !!(r && r.ok);
    } catch (e) {
      return false;
    }
  }

  async resolve(question) {
    try {
      const resp = await gmFetchJson(`${this.base}/ask`, {
        method: "POST",
        body: JSON.stringify({
          title: question.title || "",
          options: Array.isArray(question.optionsText) ? question.optionsText : [],
          type: String(question.type),
        }),
        timeout: ANSWER_TIMEOUT_MS,
      });
      if (resp && resp.ok) {
        const answer = Array.isArray(resp.answer) ? resp.answer.filter(Boolean) : [];
        return answer.length ? okAnswer(answer) : errAnswer("pi 未返回可解析的答案, 请查看 pi 会话");
      }
      return errAnswer((resp && resp.error) || "pi 未返回可解析的答案, 请查看 pi 会话");
    } catch (e) {
      return errAnswer(e && e.message ? e.message : "调用答题桥失败");
    }
  }

  /**
   * AI陪练单题作答: POST /practice-answer {type, stem, options, direction} → {ok, answer:string}。
   * 题型/选项由页面读取, 答案归一(多选排序等)在 core/practice.js 做。
   * @returns {Promise<string>} 答案原文
   */
  async practice(payload, timeout = 120000) {
    const resp = await gmFetchJson(`${this.base}/practice-answer`, {
      method: "POST",
      body: JSON.stringify(payload || {}),
      timeout,
    });
    if (resp && resp.ok && typeof resp.answer === "string" && resp.answer.trim()) return String(resp.answer);
    throw new Error((resp && resp.error) || "pi 未返回陪练答案");
  }

  /**
   * 讨论区正文生成: POST /compose {topicTitle, topicBody, existingReplies, minChars, maxChars}。
   * 桥侧只负责“写一条回复”, 字数/禁用词/雷同在插件侧校验(discuss.checkComposeText)。
   * @returns {Promise<string>} 回复正文
   */
  async compose(payload, timeout = 180000) {
    const resp = await gmFetchJson(`${this.base}/compose`, {
      method: "POST",
      body: JSON.stringify(payload || {}),
      timeout,
    });
    if (resp && resp.ok && resp.text) return String(resp.text);
    throw new Error((resp && resp.error) || "pi 未返回讨论区正文");
  }
}
