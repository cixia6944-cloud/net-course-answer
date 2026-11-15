// 答题编排: 解析 → 取答案 → 回填。
// 两条路径共用下面的原子函数:
//   · 自动模式: runAnswer() 一次跑完(旧行为, 仍可用);
//   · 半自动模式(默认): 解析出题 → 人工点「取答案 / 填入」逐题把关
//     (超星页面形态/风控/答案质量都不稳, 所以默认交给人确认)。

/**
 * @typedef {Object} RunHooks
 * @property {(msg: string, type?: string) => void} log
 * @property {(q: Object) => void} onQuestion  每道题解析出/答案更新时回调(推给 UI)
 * @property {(q: Object, ad: Object, index: number, total: number) => void} [onAnswered]
 */

/** ① 只解析: 把页面上的题抓成 handler.questions(只读, 不点任何东西) */
export function parseAll(handler, hooks = {}) {
  const log = hooks.log || (() => {});
  handler.questions = [];
  handler.correctNum = 0;
  handler.parseHtml();
  (handler.notes || []).forEach((n) => log(n.msg, n.type));
  if (!handler.questions.length) {
    log("未解析到题目, 请进入正确页面", "danger");
    return [];
  }
  log(`成功解析到 ${handler.questions.length} 个题目`, "primary");
  handler.questions.forEach((q) => hooks.onQuestion?.(q));
  return handler.questions;
}

/** ② 向答题源要一道题的答案(不碰页面) */
export async function askOne(provider, question) {
  try {
    const data = await provider.resolve(question);
    if (data && data.code === 200) {
      question.answer = data.data.answer || [];
      return { ok: true, answer: question.answer, msg: "" };
    }
    const msg = (data && data.msg) || "答题失败";
    question.answer = [msg];
    return { ok: false, answer: question.answer, msg };
  } catch (e) {
    const msg = e && e.message ? e.message : "取答案异常";
    question.answer = [msg];
    return { ok: false, answer: question.answer, msg };
  }
}

/** ③ 把答案回填到页面(会点选项 —— 半自动模式下由人触发) */
export async function fillOne(handler, question) {
  try {
    const filled = await handler.fillQuestion(question);
    if (filled === 0) {
      return { ok: false, filled: 0, msg: `没能勾上(页面未响应点击/选项没匹配上), 答案: ${(question.answer || []).join(" / ").slice(0, 60)}` };
    }
    handler.correctNum = (handler.correctNum || 0) + 1;
    return { ok: true, filled, msg: "" };
  } catch (e) {
    return { ok: false, filled: 0, msg: `填充失败: ${e && e.message ? e.message : e}` };
  }
}

/** 自动模式: 解析 + 逐题取答案并回填(保持旧行为, 供「自动」开关使用)
 *  hooks.shouldStop 返回 true 时, 当前题做完就收工(回填多选时不会再点下一个选项)。
 */
export async function runAnswer(handler, provider, hooks) {
  const { log } = hooks;
  const questions = parseAll(handler, hooks);
  if (!questions.length) return 0;
  const total = questions.length;

  for (let i = 0; i < total; i++) {
    if (hooks.shouldStop && hooks.shouldStop()) {
      log(`已在第${i + 1}题前停止(剩 ${total - i} 题未处理)`, "warning");
      break;
    }
    const question = questions[i];
    const asked = await askOne(provider, question);
    if (hooks.shouldStop && hooks.shouldStop()) {
      // 停止请求发生在等答案期间: 答案不往页面回填, 免得手刚离开鼠标又被点一下
      log(`第${i + 1}题已停止(拿到答案也不回填)`, "warning");
      break;
    }
    if (asked.ok) {
      const filled = await fillOne(handler, question);
      if (filled.ok) log(`第${i + 1}道题答题成功`, "success");
      else log(`第${i + 1}道题${filled.msg}`, "warning");
    } else {
      log(`第${i + 1}道题答题失败: ${asked.msg}`, "danger");
    }
    hooks.onAnswered?.(question, asked, i, total);
    hooks.onQuestion?.(question);
  }

  return Math.round(((handler.correctNum || 0) / total) * 100);
}
