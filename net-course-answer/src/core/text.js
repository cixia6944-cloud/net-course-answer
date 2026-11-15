// 文本清洗 / 归一化 / 相似度(纯函数, 平台无关, 移植自 0.2.4 BaseQuestionHandler)。

/** 剥离题干/选项 HTML, 保留图片/上下标等占位 */
export function removeHtml(html) {
  if (html == null) return "";
  return String(html)
    .replace(/<((?!img|sub|sup|br)[^>]+)>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<img.*?src="(.*?)".*?>/g, '<img src="$1"/>')
    .trim();
}

/** 题干清理:去【...】前缀、去(分值)后缀 */
export function clean(str) {
  return String(str).replace(/^【.*?】\s*/, "").replace(/\s*（\d+\.\d+分）$/, "");
}

/** 选项匹配归一:去 HTML/实体/选项字母前缀/空白/标点, 小写 */
export function normalizeOptionMatchText(text) {
  return clean(removeHtml(text))
    .replace(/<img\s+src=["']?([^"'>\s]+).*?>/gi, "$1")
    .replace(/&[a-z]+;/gi, "")
    .replace(/^[a-z]\s*[.．、:：)\]]\s*/i, "")
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[,.，。、;；:："'“”‘’!?！？()[\]{}【】<>《》]/g, "")
    .toLowerCase();
}

/** 判断题选项归一:文本 → "true"|"false"|"" */
export function normalizeJudgementText(optionText) {
  const text = clean(optionText).replace(/[.．、:：\s]/g, "").toLowerCase();
  if (/^(a)?(正确|是|对|√|t|true|right)$/.test(text)) return "true";
  if (/^(b)?(错误|否|错|×|x|f|false|wrong)$/.test(text)) return "false";
  return "";
}

/** Levenshtein 编辑距离(字符级, 兼容中文) */
export function levenshteinDistance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const distances = Array.from({ length: a.length + 1 }, (_, i) => i);
  b.forEach((rc, ri) => {
    let prev = distances[0];
    distances[0] = ri + 1;
    a.forEach((lc, li) => {
      const cur = distances[li + 1];
      distances[li + 1] = lc === rc ? prev : Math.min(prev, distances[li], cur) + 1;
      prev = cur;
    });
  });
  return distances[a.length];
}

/** 相似度百分比 0-100 */
export function textSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 100;
  const a = Array.from(left);
  const b = Array.from(right);
  const dist = levenshteinDistance(a.join(""), b.join(""));
  return Math.round((1 - dist / Math.max(a.length, b.length)) * 100);
}

/** 判断答案文本 → "true"/"false"(0.2.4 fillQuestion 判断分支逻辑) */
export function judgeAnswerToBool(text) {
  if (/(^|,)(正确|是|对|√|T|ri|right|true)(,|$)/.test(text)) return "true";
  if (/(^|,)(错误|否|错|×|F|wr|wrong|false)(,|$)/.test(text)) return "false";
  return "true";
}
