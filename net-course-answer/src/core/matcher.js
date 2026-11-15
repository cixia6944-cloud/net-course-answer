// 答案文本 → 选项 DOM 匹配(移植自 0.2.4 findMatchedOption + 相似度阈值)。
import { DEFAULT_SIMILARITY_THRESHOLD } from "./types.js";
import { normalizeOptionMatchText, textSimilarity } from "./text.js";

let similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD;

/** 运行期设置阈值(UI 覆盖) */
export function setSimilarityThreshold(value) {
  const n = Number(value);
  similarityThreshold = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_SIMILARITY_THRESHOLD;
}

export function getSimilarityThreshold() {
  return similarityThreshold;
}

/**
 * 在 options(文本→DOM)里找与 answer 相似度最高的选项元素;低于阈值返回 null。
 * @param {Object<string, Element>} options
 * @param {string} answer
 * @returns {Element|null}
 */
export function findMatchedOption(options, answer) {
  const normalizedAnswer = normalizeOptionMatchText(answer);
  if (!normalizedAnswer) return null;
  let bestElement = null;
  let bestScore = -1;
  for (const [optionText, optionElement] of Object.entries(options)) {
    const score = textSimilarity(normalizeOptionMatchText(optionText), normalizedAnswer);
    if (score > bestScore) {
      bestElement = optionElement;
      bestScore = score;
    }
  }
  if (!bestElement) return null;
  return bestScore >= similarityThreshold ? bestElement : null;
}
