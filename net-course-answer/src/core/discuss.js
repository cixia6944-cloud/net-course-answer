// 讨论区自动回复: 纯逻辑(URL/HTML 解析、正文校验、记账、取数上限、一轮循环)。
// 设计口径与 core/ai-tutor.js 一致: 网络与 DOM 全部由调用方注入, 这里只做判断与编排,
// 这样 node 里能用假 fetch / 假 DOM 把「跳过已回复」「上限拦截」「逐条确认」都测到。
//
// 站点事实(2026-11-13 人工实测, 见 一手侦察记录(未随仓库分发) §4):
//   · 列表页 /pc/topic/topiclist/index?bbsid=<bbsid>(打开后自动补 &courseId=&classId=)
//   · 详情页 /course/topic/v3/bbs/<bbsid>/<topicUuid>/replysList?courseId=..&classId=..
//   · 发帖    POST /pc/invitation/<topicUuid>/addReplys (x-www-form-urlencoded, 需该话题页下发的 urlToken)
//   · 读回复  GET  /pc/invitation/getReplyList?bbsid=..&uuid=<topicUuid>&tag=&order=2&lastValue=&lastAuxValue=
//   · 「共 N 条回复」计数滞后, 判断进度一律数楼层/看接口返回, 不看这个数字。
import { removeHtml, textSimilarity } from "./text.js";

/** 面板默认参数(与 ui/panel.js 的输入框默认值一致) */
export const DISCUSS_DEFAULTS = Object.freeze({
  targetTotal: 75,
  dailyLimit: 10,
  intervalMinSec: 40,
  intervalMaxSec: 120,
  minChars: 80,
  maxChars: 150,
});

/** 正文禁用词/套话(实测: 这个圈子的回复里基本不出现这些) */
export const DISCUSS_BANNED_PHRASES = Object.freeze([
  "首先",
  "其次",
  "再次",
  "最后要说",
  "综上所述",
  "综上",
  "总而言之",
  "总之",
  "希望对你有帮助",
  "希望对你有所帮助",
  "作为一个模型",
  "作为 AI",
  "作为AI",
  "AI语言模型",
  "人工智能模型",
]);

/** 开场称呼(只看正文开头) */
export const DISCUSS_OPENING_RE = /^\s*(你好|您好|大家好|老师好|各位老师|各位同学|同学们)[,，、:：!！\s]/;

/** 与已有回复的相似度上限: 超过就重生成(百分比) */
export const DISCUSS_SIMILARITY_LIMIT = 60;

/** 连续失败多少条自动停 */
export const DISCUSS_MAX_CONSECUTIVE_FAILS = 3;

/** 接地校验: 最多留几个关键词 */
export const DISCUSS_GROUNDING_MAX_TERMS = 8;

/**
 * 接地校验的中文停用词: 取关键词之前先挖掉。
 * 顺序 = 先长后短(「为什么」必须排在「什么」前面), 否则长词会被短词切碎。
 * 只收功能词/提问套话, 不收实词 —— 挖得太狠会把话题本身也挖没。
 */
export const DISCUSS_GROUNDING_STOPWORDS = Object.freeze([
  "为什么", "什么样", "什么", "怎么样", "怎样", "怎么", "如何", "哪些", "哪个", "哪里",
  "是不是", "有没有", "谈谈", "说说", "解释", "说明", "简述", "论述", "评价",
  "我们", "你们", "他们", "大家", "老师", "同学", "觉得", "认为", "应该", "需要",
  "可以", "能够", "这个", "那个", "这些", "那些", "一个", "一种", "问题", "方面", "时候",
  "以及", "或者", "还有", "因为", "所以", "但是", "如果", "就是", "不是", "通过",
  "关于", "对于", "根据", "请", "吗", "呢", "吧", "啊", "的", "是", "在", "和", "与", "了",
  "这", "那", "我", "你", "他", "她", "它", "们",
]);

/** 英文停用词(只用于接地取词; 长度 < 3 的词本来就会被滤掉) */
export const DISCUSS_GROUNDING_EN_STOP = Object.freeze([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "that", "this", "from",
  "have", "has", "had", "can", "will", "was", "were", "what", "why", "how", "which", "who",
  "when", "where", "does", "did", "about", "into", "than", "then", "them", "they", "there",
  "here", "its", "his", "her", "our", "any", "all", "one", "two", "use", "got", "get",
]);

/** 抽样: 从本轮已发里按比例抽、上下限 */
export const DISCUSS_SAMPLE_RATIO = 0.1;
export const DISCUSS_SAMPLE_MIN = 1;
export const DISCUSS_SAMPLE_MAX = 5;

/** run 报告在 GM 存储里保留几轮 */
export const DISCUSS_RUNS_KEEP = 5;

/**
 * 讨论区页面选择器(实测值)。
 * submit 用 `.addReply` 而不是整串 `jb_btn jb_btn_92 fr fs14`: 真机上那四个类名是可换的皮肤类,
 * `.addReply` 才是它自己的语义类; 整串只要平台少一个类就点不到。整串留在 submitFull 里备查。
 */
export const DISCUSS_SEL = Object.freeze({
  textarea: 'textarea[placeholder="回复话题"]',
  submit: ".addReply",
  submitFull: ".jb_btn.jb_btn_92.fr.fs14.addReply",
  floors: ".reply_list .reply_item, .reply-item, .floor-item",
});

/* -------------------------------------------------- 发帖通道(UI / API) */

/**
 * 发帖通道: "ui" = 打开话题页, 用页面自己的编辑器与按钮发(默认);
 *           "api" = POST /pc/invitation/<uuid>/addReplys(保留, 默认不用)。
 *
 * 为什么默认 UI(2026-11-13 真机实测): API 通道把中文正文发成等长的「?」——
 * 131 字草稿 → 131 个问号, getReplyList 里读出来就是 '?'; 同一浏览器里点页面按钮发出去是正常中文。
 * 换 Content-Type / fetch 换 XHR / 补空参数都无效。
 */
export const DISCUSS_POST_MODES = Object.freeze(["ui", "api"]);

/** 通道名归一: 只认 "api", 其余(空/拼错/未设置)一律 "ui" —— 默认必须是最稳的那个 */
export function normalizePostMode(mode) {
  return String(mode || "").trim().toLowerCase() === "api" ? "api" : "ui";
}

/** 话题详情页 URL(UI 发帖要真的打开它; 不用 iframe —— 本机实测拿不到 contentDocument) */
export function replysListUrl({ origin = "https://groupweb.chaoxing.com", bbsid, uuid, courseId, classId } = {}) {
  const qs = [];
  if (courseId != null && String(courseId) !== "") qs.push(`courseId=${encodeURIComponent(courseId)}`);
  if (classId != null && String(classId) !== "") qs.push(`classId=${encodeURIComponent(classId)}`);
  return `${origin}/course/topic/v3/bbs/${encodeURIComponent(String(bbsid || ""))}/${encodeURIComponent(String(uuid || ""))}/replysList${qs.length ? `?${qs.join("&")}` : ""}`;
}

/** UI 发帖的等待/轮询参数(真机实测值; 调用方可覆盖, 单测里调小) */
export const DISCUSS_UI_TIMING = Object.freeze({
  waitMs: 20000,
  pollMs: 2000,
  confirmMs: 20000,
  confirmPollMs: 2000,
});

/** UI 通道失败原因码 → 人话(run 报告里两者都留: 码给脚本比, 话给人看) */
export const DISCUSS_UI_FAIL_LABELS = Object.freeze({
  "no-textarea": "等不到输入框",
  "no-button": "等不到发送按钮",
  "fill-failed": "填字没生效",
  "no-click": "点了没反应",
  "no-floor": "没看到楼层",
  "nav-failed": "页面没打开",
});

/** 失败原因码 → 中文说明(认不出就原样返回码) */
export function uiFailLabel(code) {
  const k = String(code || "");
  return DISCUSS_UI_FAIL_LABELS[k] || k || "未知原因";
}

/* ------------------------------------------------------------------ URL */

/** 是不是讨论区页面(groupweb 的列表页或详情页) */
export function isDiscussUrl(url) {
  return !!parseDiscussContext(url);
}

/**
 * 从 URL 认讨论区上下文。
 * @returns {{mode:"list"|"detail", bbsid:string, topicUuid:string, courseId:string, classId:string}|null}
 */
export function parseDiscussContext(url) {
  const u = String(url || "");
  if (!/groupweb\.chaoxing\.com/i.test(u)) return null;
  let parsed = null;
  try {
    parsed = new URL(u);
  } catch (e) {
    return null;
  }
  const path = parsed.pathname || "";
  const q = parsed.searchParams;
  const bbsid = String(q.get("bbsid") || "");
  const courseId = String(q.get("courseId") || "");
  const classId = String(q.get("classId") || q.get("clazzId") || "");

  if (/\/pc\/topic\/topiclist\/index/i.test(path)) {
    return { mode: "list", bbsid, topicUuid: "", courseId, classId };
  }
  const m = path.match(/\/course\/topic\/v3\/bbs\/([^/]+)\/([^/]+)\/replysList/i);
  if (m) {
    return { mode: "detail", bbsid: m[1], topicUuid: m[2], courseId, classId };
  }
  return null;
}

/** 从 stu-base-info 的返回(JSON 对象或已序列化文本)里抠 bbsid; 抠不到返回 "" */
export function extractBbsid(payload) {
  if (payload == null) return "";
  let text = "";
  if (typeof payload === "string") text = payload;
  else {
    try {
      text = JSON.stringify(payload);
    } catch (e) {
      return "";
    }
  }
  const m = text.match(/bbsid=([0-9a-zA-Z]{8,64})/) || text.match(/"bbsid"\s*:\s*"([0-9a-zA-Z]{8,64})"/);
  return m ? m[1] : "";
}

/* ----------------------------------------------------------------- HTML */

/** 剥标签 + 折叠空白(讨论区正文/楼层文本都用它) */
export function htmlToText(html) {
  if (html == null) return "";
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * 从 replysList 链接里取话题 uuid。
 * 不能直接用「第一个 32 位 hex」—— bbsid 本身就是 32 位 hex, 会把它当成 uuid(踩过)。
 * 路径形如 /course/topic/v3/bbs/<bbsid>/<topicUuid>/replysList。
 */
export function topicUuidFromHref(href) {
  const h = String(href || "");
  const m = h.match(/\/bbs\/([^/?#]+)\/([0-9a-f]{32})(?:[/?#]|$)/i);
  if (m) return m[2].toLowerCase();
  const segs = h.split("?")[0].split("#")[0].split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^[0-9a-f]{32}$/i.test(segs[i])) return segs[i].toLowerCase();
  }
  return "";
}

/**
 * 解析话题列表页 HTML → [{uuid, title, replyCount}]
 * 只认 href 里带 replysList 且能抠出 32 位 uuid 的链接; 标题取锚文本。
 * 去重按 uuid(同一话题在页面上常出现两三次: 标题链接 + 头像链接)。
 */
export function parseTopicListHtml(html, bbsid = "") {
  const src = String(html || "");
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    if (!/replysList/i.test(href)) continue;
    if (bbsid && href.indexOf(bbsid) === -1) continue;
    const uuid = topicUuidFromHref(href);
    if (!uuid) continue;
    const title = htmlToText(m[2]).replace(/\s+/g, " ").trim();
    if (!title) continue;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    out.push({ uuid, title, replyCount: -1 });
  }
  return out;
}

/** 话题详情页 HTML 里拿 urlToken(发帖必须带; 每个话题页渲染时下发, 32 位) */
export function extractUrlToken(html) {
  const src = String(html || "");
  const m =
    src.match(/urlToken\s*[:=]\s*["']([0-9a-zA-Z]{16,64})["']/) ||
    src.match(/["']urlToken["']\s*:\s*["']([0-9a-zA-Z]{16,64})["']/) ||
    src.match(/name\s*=\s*["']urlToken["'][^>]*value\s*=\s*["']([0-9a-zA-Z]{16,64})["']/i);
  return m ? m[1] : "";
}

/**
 * 从已渲染的列表页 DOM 里收话题(同标签页就是列表页时用, 比再拉一次 HTML 准)。
 * 只认 href 带 replysList 且能抠出 32 位 uuid 的链接。
 */
export function collectTopicsFromDoc(doc, bbsid = "") {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  const out = [];
  const seen = new Set();
  const push = (uuid, title) => {
    const u = String(uuid || "").trim();
    const t = String(title || "").replace(/\s+/g, " ").trim();
    if (!u || !t || seen.has(u)) return;
    seen.add(u);
    out.push({ uuid: u, title: t, replyCount: -1 });
  };
  // ① 真机列表页(topiclist/index): 标题是 a.topicli_link[href="javascript:void(0);"],
  //    uuid 挂在祖先 li 的 data-uuid 上 —— href 里根本没有 replysList, 所以光看 <a> 会空。
  try {
    for (const li of Array.from(doc.querySelectorAll("[data-uuid]") || [])) {
      const uuid = li.getAttribute && li.getAttribute("data-uuid");
      if (!uuid || !/^[0-9a-fA-F][0-9a-fA-F-]{31,39}$/.test(String(uuid).trim())) continue;
      const a = (li.querySelector && (li.querySelector("a.topicli_link") || li.querySelector("a"))) || null;
      push(uuid, htmlToText((a ? a.textContent : li.textContent) || ""));
    }
  } catch (e) {
    /* 落到 ② */
  }
  let links = [];
  try {
    links = Array.from(doc.querySelectorAll('a[href*="replysList"]') || []);
  } catch (e) {
    return [];
  }
  for (const a of links) {
    let href = "";
    try {
      href = String((a.getAttribute && a.getAttribute("href")) || a.href || "");
    } catch (e) {
      href = "";
    }
    if (!href || (bbsid && href.indexOf(bbsid) === -1)) continue;
    push(topicUuidFromHref(href), htmlToText(a.textContent || ""));
  }
  return out;
}

/** 详情页 HTML 里的主题正文(取不到返回 "", 由调用方决定只用标题) */
export function extractTopicBody(html) {
  const src = String(html || "");
  if (!src) return "";
  // ① 内嵌 JSON(Vue 页常见): "content":"...."
  const j = src.match(/"(?:content|topicContent|contentText|invitationContent)"\s*:\s*"((?:[^"\\]|\\.){10,4000})"/);
  if (j) {
    try {
      const val = JSON.parse(`"${j[1]}"`);
      const text = htmlToText(val);
      if (text) return text;
    } catch (e) {
      /* 落到 ② */
    }
  }
  // ② 常见容器类名
  const c = src.match(
    /<(?:div|section|article)[^>]*class\s*=\s*["'][^"']*(?:fr-view|topic-content|content-detail|bbs-content|invitation-content)[^"']*["'][^>]*>([\s\S]{20,6000}?)<\/(?:div|section|article)>/i
  );
  if (c) {
    const text = htmlToText(c[1]);
    if (text) return text;
  }
  return "";
}

/** 从 getReplyList / getTopReplyList 的返回里抠出「别人已经说过的话」 */
export function collectReplyTexts(payload, limit = 20) {
  const texts = [];
  const push = (v) => {
    const t = htmlToText(typeof v === "string" ? v : "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 4) return;
    if (texts.indexOf(t) === -1) texts.push(t);
  };
  const walk = (node, depth) => {
    if (texts.length >= limit || node == null || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    for (const key of ["content", "topicContent", "replyContent", "contentText", "htmlContent"]) {
      if (typeof node[key] === "string" && node[key]) push(node[key]);
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(payload, 0);
  return texts.slice(0, limit);
}

/* ------------------------------------------------------- 接地校验(0 token) */

/** 中文片段(连续汉字) */
const GROUNDING_CJK_RE = /[\u4e00-\u9fff]+/g;
/** 英文词(数字/连字符允许, 但首字符必须是字母) */
const GROUNDING_EN_RE = /[A-Za-z][A-Za-z0-9_+-]*/g;

/**
 * 从话题标题 + 正文里取「接地词」—— 纯规则, 不调模型、不花 token。
 * 用途: 生成完的正文一个词都不沾话题 → 判定偏题(见 checkGrounding)。
 *
 * 规则:
 *   ① 英文按词取, 长度 >= 3, 统一小写, 去掉英文停用词;
 *   ② 中文先按非汉字切开, 再把停用词挖成断点, 在剩下的片段上滑 2-4 字窗;
 *   ③ 去重后按「频次 + 长度」排序(标题里出现的词加权), 最多留 DISCUSS_GROUNDING_MAX_TERMS 个;
 *   ④ 互相包含的候选只留一个(「机会成本」已选, 就不再单收「机会」「成本」)。
 *
 * @param {string} title 话题标题
 * @param {string} topicBody 话题正文(取不到可传 "")
 * @returns {string[]} 关键词(可能为空: 标题正文都是套话时)
 */
export function pickGroundingTerms(title, topicBody) {
  const max = DISCUSS_GROUNDING_MAX_TERMS;
  const enStop = new Set(DISCUSS_GROUNDING_EN_STOP);
  const stat = new Map(); // term -> { freq, title }
  const first = new Map(); // term -> 首次出现次序
  let seq = 0;

  const touch = (term, inTitle) => {
    if (!term) return;
    let s = stat.get(term);
    if (!s) {
      s = { freq: 0, title: 0 };
      stat.set(term, s);
      first.set(term, seq++);
    }
    s.freq += 1;
    if (inTitle) s.title += 1;
  };

  const pairs = [
    [String(title || ""), true],
    [String(topicBody || ""), false],
  ];

  // ① 英文
  for (const [text, inTitle] of pairs) {
    const words = text.match(GROUNDING_EN_RE) || [];
    for (const raw of words) {
      const w = raw.toLowerCase();
      if (w.length < 3 || enStop.has(w)) continue;
      touch(w, inTitle);
    }
  }

  // ② 中文: 标点/字母都变成断点, 停用词也变成断点, 剩下片段滑窗
  for (const [text, inTitle] of pairs) {
    const runs = text.replace(GROUNDING_EN_RE, "\n").match(GROUNDING_CJK_RE) || [];
    for (const run of runs) {
      let cut = run;
      for (const w of DISCUSS_GROUNDING_STOPWORDS) {
        if (cut.indexOf(w) !== -1) cut = cut.split(w).join("\n");
      }
      for (const seg of cut.split("\n")) {
        const s = seg.trim();
        const len = Array.from(s).length;
        if (len < 2) continue;
        const chars = Array.from(s);
        for (let n = 2; n <= 4 && n <= len; n++) {
          for (let i = 0; i + n <= len; i++) {
            touch(chars.slice(i, i + n).join(""), inTitle);
          }
        }
      }
    }
  }

  // ③ 频次 + 长度(标题加权), 稳定排序
  const picked = Array.from(stat.entries()).map(([term, s]) => {
    const len = Array.from(term).length;
    // 长度的加成要克制: 2026-11-13 真机踩过——原来 (len-2)*0.6 让 4 字跨词碎片
    // (「场供求关」「求关系对」) 挤掉「供求」「价格」这类真词, 于是一篇扣题的回复
    // 一个 4 字碎片都不含, 被判「不接地」白拦一条。
    return { term, score: (s.freq + s.title * 3) * (1 + (len - 2) * 0.25), len, at: first.get(term) || 0, freq: s.freq };
  });
  picked.sort((a, b) => b.score - a.score || b.len - a.len || a.at - b.at);

  // 「高频片段」优先: 中文里滑窗会产生大量只出现一次的跨词碎片(「共物品具」),
  // 重复出现的才是话题词。至少有两个高频片段时就只用高频的; 太少(短标题/空正文)才退回全量。
  const repeated = picked.filter((p) => p.freq >= 2);
  const pool = repeated.length >= 2 ? repeated : picked;

  // ④ 先收长词(「机会成本」这种整词), 再补 2-3 字短词当兜底。
  // 只收长词的后果(2026-11-13 真机): 标题里全是 4 字滑窗碎片(「场供求关」),
  // 正文换个说法就一个都不含, 扣题的回复被白拦。短词留 3 个名额, 命中率立刻回来。
  const LONG_QUOTA = Math.max(1, max - 3);
  const out = [];
  const pushTerm = (t) => {
    if (!t || out.indexOf(t) !== -1) return;
    if (out.length >= max) return;
    out.push(t);
  };
  for (const p of pool) {
    if (out.length >= LONG_QUOTA) break;
    const t = p.term;
    if (out.some((x) => x.indexOf(t) !== -1 || t.indexOf(x) !== -1)) continue;
    pushTerm(t);
  }
  const shorts = pool.filter((p) => p.len <= 3).sort((a, b) => a.len - b.len || b.score - a.score || a.at - b.at);
  for (const p of shorts) {
    if (out.length >= max) break;
    const t = p.term;
    if (out.some((x) => x.indexOf(t) !== -1)) continue;
    pushTerm(t);
  }
  return out;
}

/**
 * 正文跟话题接不接地: 至少命中 1 个 term 就算过(英文不分大小写)。
 * terms 为空时调用方应视为「无从校验」直接放行 —— 这里如实返回 ok:false,
 * 由调用方决定(不把「取不到关键词」静默混成「正文合格」)。
 *
 * @param {string} text 生成的正文
 * @param {string[]} terms pickGroundingTerms 的结果
 * @returns {{ok:boolean, hit:string[]}}
 */
export function checkGrounding(text, terms) {
  const body = String(text || "");
  const lower = body.toLowerCase();
  const hit = [];
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = String(raw || "").trim();
    if (!term || hit.indexOf(term) !== -1) continue;
    const latin = /[A-Za-z]/.test(term);
    const found = latin ? lower.indexOf(term.toLowerCase()) !== -1 : body.indexOf(term) !== -1;
    if (found) hit.push(term);
  }
  return { ok: hit.length > 0, hit };
}

/* ------------------------------------------------------------ 正文校验 */

/** 正文字数: 按码点计, 去掉所有空白(与超星 .wordcount 口径接近) */
export function discussCharCount(text) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length;
}

/**
 * 生成的正文能不能用。
 * @returns {{ok:boolean, chars:number, reasons:string[], similarity:number}}
 */
export function checkComposeText(text, opts = {}) {
  const minChars = Number.isFinite(opts.minChars) ? opts.minChars : DISCUSS_DEFAULTS.minChars;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : DISCUSS_DEFAULTS.maxChars;
  const existing = Array.isArray(opts.existingReplies) ? opts.existingReplies : [];
  const limit = Number.isFinite(opts.similarityLimit) ? opts.similarityLimit : DISCUSS_SIMILARITY_LIMIT;
  const reasons = [];
  const body = String(text || "").trim();
  const chars = discussCharCount(body);

  if (!body) reasons.push("正文为空");
  if (body && chars < minChars) reasons.push(`太短(${chars} < ${minChars})`);
  if (body && chars > maxChars) reasons.push(`太长(${chars} > ${maxChars})`);
  const banned = DISCUSS_BANNED_PHRASES.filter((w) => body.indexOf(w) !== -1);
  if (banned.length) reasons.push(`含禁用词(${banned.join("、")})`);
  if (DISCUSS_OPENING_RE.test(body)) reasons.push("开头有称呼语");

  let similarity = 0;
  for (const other of existing) {
    const s = textSimilarity(body, String(other || ""));
    if (s > similarity) similarity = s;
  }
  if (existing.length && similarity > limit) reasons.push(`与已有回复太像(${similarity}% > ${limit}%)`);

  return { ok: reasons.length === 0, chars, reasons, similarity };
}

/** 服务端偶尔回「回复: xxx」/ 包一层引号, 这里统一抹掉(桥侧也清过一遍, 双保险) */
export function normalizeComposeText(text) {
  let s = String(text || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // 去引号 → 去「回复:」前缀 → 再去一次引号(模型有时先包引号再带前缀)
  s = s.replace(/^["'“”‘’「」]+/, "").replace(/["'“”‘’「」]+$/, "");
  s = s.replace(/^(?:回复|回答|答)\s*[:：]\s*/, "");
  return s.replace(/^["'“”‘’「」]+/, "").replace(/["'“”‘’「」]+$/, "").trim();
}

/* --------------------------------------------------------------- 记账 */

/** GM 存储键: 按课程 + 圈子分开记(换个班/换个圈不串) */
export function discussStoreKey(courseId, bbsid) {
  const c = String(courseId || "unknown");
  const b = String(bbsid || "unknown");
  return `nca-discuss-${c}-${b}`;
}

/** 空账本 */
export function emptyDiscussState() {
  return { records: [], skipped: [] };
}

/** 读账本(读坏了就回空账本, 不要因为存储脏数据把整轮卡死) */
export function loadDiscussState({ courseId, bbsid, read }) {
  let raw = null;
  try {
    raw = typeof read === "function" ? read(discussStoreKey(courseId, bbsid), null) : null;
  } catch (e) {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return emptyDiscussState();
  const records = Array.isArray(raw.records) ? raw.records.filter((r) => r && r.uuid) : [];
  const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter((u) => typeof u === "string") : [];
  return { records, skipped };
}

/** 存账本(只留最近 800 条, GM 存储别无限膨胀) */
export function persistDiscussState({ courseId, bbsid, state, write }) {
  if (typeof write !== "function") return;
  const records = (state && state.records ? state.records : []).slice(-800);
  const skipped = (state && state.skipped ? state.skipped : []).slice(-800);
  try {
    write(discussStoreKey(courseId, bbsid), { records, skipped });
  } catch (e) {
    /* 存储失败只影响记账, 不该打断发送 */
  }
}

const DAY_MS = 24 * 3600 * 1000;

/** 同一本地日: 用本地日期串比较(跨零点自然归零) */
export function dayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 今日已发 / 累计已发(只数成功的) */
export function discussCounts(state, now = Date.now()) {
  const today = dayKey(now);
  let total = 0;
  let todayCount = 0;
  for (const r of (state && state.records) || []) {
    if (!r || r.result !== "ok") continue;
    total += 1;
    if (dayKey(r.at) === today) todayCount += 1;
  }
  return { today: todayCount, total };
}

/** 这个话题回复过没有(同一个 topicUuid 不发第二次) */
export function hasRepliedTopic(state, uuid) {
  const u = String(uuid || "").toLowerCase();
  if (!u) return false;
  for (const r of (state && state.records) || []) {
    if (r && r.result === "ok" && String(r.uuid || "").toLowerCase() === u) return true;
  }
  return false;
}

/** 被用户跳过的话题也不再自动碰 */
export function hasSkippedTopic(state, uuid) {
  const u = String(uuid || "").toLowerCase();
  return !!u && (state.skipped || []).some((x) => String(x).toLowerCase() === u);
}

/** 记一条(成功/失败都记, 成功才计入额度) */
export function recordReply(state, entry) {
  const at = Number(entry && entry.at) || Date.now();
  const rec = {
    uuid: String((entry && entry.uuid) || ""),
    title: String((entry && entry.title) || "").slice(0, 120),
    at,
    chars: Number((entry && entry.chars) || 0),
    result: entry && entry.result === "ok" ? "ok" : "fail",
    note: String((entry && entry.note) || "").slice(0, 160),
  };
  state.records.push(rec);
  if (state.records.length > 800) state.records = state.records.slice(-800);
  return rec;
}

/** 加进跳过表 */
export function skipTopic(state, uuid) {
  const u = String(uuid || "");
  if (!u) return;
  if (!(state.skipped || []).some((x) => x === u)) state.skipped.push(u);
  if (state.skipped.length > 800) state.skipped = state.skipped.slice(-800);
}

/** 还能不能再发: 先看今日上限, 再看总量上限 */
export function canSend(state, opts = {}) {
  const dailyLimit = Number.isFinite(opts.dailyLimit) ? opts.dailyLimit : DISCUSS_DEFAULTS.dailyLimit;
  const targetTotal = Number.isFinite(opts.targetTotal) ? opts.targetTotal : DISCUSS_DEFAULTS.targetTotal;
  const counts = discussCounts(state, Number(opts.now) || Date.now());
  if (targetTotal > 0 && counts.total >= targetTotal) {
    return { ok: false, reason: `已达目标总条数 ${targetTotal}(累计 ${counts.total})`, counts };
  }
  if (dailyLimit > 0 && counts.today >= dailyLimit) {
    return { ok: false, reason: `今日已发 ${counts.today} 条, 到每天上限 ${dailyLimit}`, counts };
  }
  return { ok: true, reason: "", counts };
}

/* ---------------------------------------------------------- run 报告 */

/** GM 存储键: 每课程+圈子一份「最近若干轮」 */
export function runsStoreKey(courseId, bbsid) {
  const c = String(courseId || "unknown");
  const b = String(bbsid || "unknown");
  return `nca-discuss-runs-${c}-${b}`;
}

/** 空 run 报告(字段固定: 导出时靠这个白名单挡凭据) */
export function createRunReport({ startedAt, courseId, bbsid, target, dailyLimit, postMode } = {}) {
  return {
    startedAt: Number(startedAt) || Date.now(),
    endedAt: 0,
    courseId: String(courseId || ""),
    bbsid: String(bbsid || ""),
    target: Number(target) || 0,
    dailyLimit: Number(dailyLimit) || 0,
    postMode: postMode == null ? "api" : normalizePostMode(postMode),
    sent: [],
    failed: [],
    skipped: [],
  };
}

/** 记一条发出(正文全文也记, 供外层 agent 抽查) */
export function reportSent(report, entry = {}) {
  if (!report || !Array.isArray(report.sent)) return null;
  const row = {
    topicUuid: String(entry.topicUuid || ""),
    title: String(entry.title || "").slice(0, 160),
    chars: Number(entry.chars) || 0,
    text: String(entry.text || ""),
    groundingHits: Array.isArray(entry.groundingHits) ? entry.groundingHits.map(String) : [],
    at: Number(entry.at) || Date.now(),
  };
  report.sent.push(row);
  return row;
}

/** 记一条失败(stage 只收 compose/grounding/send, 对不上就归 compose) */
export function reportFailed(report, entry = {}) {
  if (!report || !Array.isArray(report.failed)) return null;
  const stage = ["compose", "grounding", "send"].indexOf(String(entry.stage)) !== -1 ? String(entry.stage) : "compose";
  const row = {
    topicUuid: String(entry.topicUuid || ""),
    title: String(entry.title || "").slice(0, 160),
    stage,
    reason: String(entry.reason || "").slice(0, 200),
    reasonCode: String(entry.reasonCode || "").slice(0, 40),
    at: Number(entry.at) || Date.now(),
  };
  report.failed.push(row);
  return row;
}

/** 记一条跳过(reason 只收 alreadyReplied/userSkipped) */
export function reportSkipped(report, entry = {}) {
  if (!report || !Array.isArray(report.skipped)) return null;
  const reason = String(entry.reason) === "alreadyReplied" ? "alreadyReplied" : "userSkipped";
  const row = {
    topicUuid: String(entry.topicUuid || ""),
    title: String(entry.title || "").slice(0, 160),
    reason,
  };
  report.skipped.push(row);
  return row;
}

/** 报告里不允许出现的键(凭据地毯式过滤, 导出前再守一道) */
const REPORT_SECRET_KEY_RE = /(cookie|url_?token|visitor|passwd|password|session|ticket)/i;

/** 深拷贝并去掉任何像凭据的键(报告只该带话题/正文/计数) */
export function sanitizeRunReport(report, depth = 0) {
  const walk = (v, d) => {
    if (v == null) return v;
    if (d > 8) return null; // 防环
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        if (REPORT_SECRET_KEY_RE.test(k)) continue;
        out[k] = walk(v[k], d + 1);
      }
      return out;
    }
    return v;
  };
  return walk(report, depth);
}

/** 导出给外层 agent 的 JSON 文本 */
export function reportToJson(report) {
  try {
    return JSON.stringify(sanitizeRunReport(report), null, 2);
  } catch (e) {
    return "{}";
  }
}

/** 读历史 run 报告(读坏了回空数组, 不因脏数据卡住面板) */
export function loadRunReports({ courseId, bbsid, read } = {}) {
  let raw = null;
  try {
    raw = typeof read === "function" ? read(runsStoreKey(courseId, bbsid), []) : null;
  } catch (e) {
    raw = null;
  }
  return Array.isArray(raw) ? raw.filter((r) => r && typeof r === "object") : [];
}

/** 追加一轮报告, 只保留最近 DISCUSS_RUNS_KEEP 轮; 返回保留后的列表 */
export function saveRunReport({ courseId, bbsid, report, read, write } = {}) {
  const list = loadRunReports({ courseId, bbsid, read });
  if (report) list.push(sanitizeRunReport(report));
  const kept = list.slice(-DISCUSS_RUNS_KEEP);
  try {
    if (typeof write === "function") write(runsStoreKey(courseId, bbsid), kept);
  } catch (e) {
    /* 存储失败只影响导出, 不该打断本轮 */
  }
  return kept;
}

/* -------------------------------------------------------------- 抽样 */

/**
 * 从本轮已发里等距抽样(默认 1/10, 至少 1 条、最多 5 条)。
 * 纯本地拼接, 不消耗任何 token。
 * @param {Array} sent run 报告的 sent 数组
 * @returns {Array} 抽中的条目(保持原顺序)
 */
export function sampleSentForReview(sent, opts = {}) {
  const list = (Array.isArray(sent) ? sent : []).filter((e) => e && (e.text || e.title));
  if (!list.length) return [];
  const ratio = Number.isFinite(opts.ratio) ? opts.ratio : DISCUSS_SAMPLE_RATIO;
  const min = Number.isFinite(opts.min) ? opts.min : DISCUSS_SAMPLE_MIN;
  const max = Number.isFinite(opts.max) ? opts.max : DISCUSS_SAMPLE_MAX;
  const want = Math.min(max, Math.max(min, Math.round(list.length * ratio)));
  const n = Math.max(0, Math.min(want, list.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    // 等距: 把列表分成 n 段, 每段取中点
    const idx = Math.min(list.length - 1, Math.floor(((i + 0.5) * list.length) / n));
    out.push(list[idx]);
  }
  return out;
}

/** 抽样结果 → 一段可直接贴给 agent 的可复制文本 */
export function formatSamplesForReview(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((e, i) => {
      const title = String((e && e.title) || "").trim() || `话题 ${i + 1}`;
      const text = String((e && e.text) || "").trim();
      const hits = e && Array.isArray(e.groundingHits) && e.groundingHits.length ? `接地: ${e.groundingHits.slice(0, 5).join("、")}` : "";
      return `【${i + 1}】${title}\n${text}${hits ? `\n(${hits})` : ""}`;
    })
    .join("\n\n");
}

/* ------------------------------------------------------------ 页面写入 */

/** 往回复框写正文: 原生 setter + 派发 input(页面靠 input 同步 .wordcount 和提交按钮态) */
export function fillReplyBox(doc, win, text) {
  if (!doc || typeof doc.querySelector !== "function") return false;
  const el = doc.querySelector(DISCUSS_SEL.textarea);
  if (!el) return false;
  const w = win || null;
  let setter = null;
  try {
    setter = w && w.HTMLTextAreaElement && Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value");
  } catch (e) {
    setter = null;
  }
  try {
    if (setter && setter.set) setter.set.call(el, text);
    else el.value = text;
  } catch (e) {
    return false;
  }
  try {
    const Ev = (w && w.Event) || (typeof Event !== "undefined" ? Event : null);
    if (Ev) el.dispatchEvent(new Ev("input", { bubbles: true }));
  } catch (e) {
    /* 派发失败不影响写入本身 */
  }
  return String(el.value) === String(text);
}

/** 点「发送」按钮 */
export function clickReplyButton(doc) {
  if (!doc || typeof doc.querySelector !== "function") return false;
  const btn = doc.querySelector(DISCUSS_SEL.submit);
  if (!btn) return false;
  try {
    if (!btn.disabled) {
      if (typeof btn.click === "function") btn.click();
      else if (typeof btn.dispatchEvent === "function") btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

/**
 * 话题页 HTML 里有没有自己刚发的正文 —— 发帖后最可靠的那个判据。
 * 为什么不用 getReplyList: 2026-11-13 真机实测, 它对「明明有 2 条回复」的话题也返回 0 条,
 * 拿它轮询会永远确认不到, 于是每条都显示「失败(没确认到楼层)」。
 */
export function topicPageHasReply(html, text) {
  // 去掉标签再比: 楼层正文里常有 <br>/<p> 把一句话劈开, 留着标签就永远匹配不上
  const flat = String(html || "").replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  if (!flat) return false;
  const want = String(text || "").replace(/\s+/g, "");
  if (want.length < 6) return false;
  const probe = want.slice(0, 16);
  if (flat.indexOf(probe) !== -1) return true;
  // 页面里可能出现 HTML 实体, 解一次再比
  const dec = flat.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
  return dec.indexOf(probe) !== -1;
}

/* ------------------------------------------- UI 发帖: DOM 判定与动作 */

/** 一个 document 的可比文本(去标签口径同 topicPageHasReply, 所以 <br> 不会把正文劈开) */
export function docText(doc) {
  if (!doc) return "";
  try {
    const body = doc.body || null;
    if (body) return String(body.innerText || body.textContent || "");
    const de = doc.documentElement || null;
    return de ? String(de.textContent || "") : "";
  } catch (e) {
    return "";
  }
}

/** DOM 版楼层确认: 楼层文本里出现自己正文的前 16 字 */
export function docHasReply(doc, text) {
  return topicPageHasReply(docText(doc), text);
}

/**
 * 从一段文本里取最大的「第N楼」(没有就 0)。
 * 真机楼层标题是「第3楼」这种, 数字与「楼」之间可能带空格。
 */
export function maxFloorNo(text) {
  const s = String(text || "");
  let max = 0;
  const re = /第\s*(\d{1,4})\s*楼/g;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/** 楼层数有没有变多(提交前后各看一次) */
export function floorsIncreased(before, after) {
  return Number(after) > Number(before);
}

/**
 * 提交后到底算不算成功: 二选一 —— DOM 里出现自己正文前 16 字, 或楼层数比提交前多。
 * @returns {{confirmed:boolean, by:"text"|"floor"|""}}
 */
export function judgePostConfirm({ domText: dom = "", floorsBefore = 0, floorsAfter = 0, text = "" } = {}) {
  if (topicPageHasReply(dom, text)) return { confirmed: true, by: "text" };
  if (floorsIncreased(floorsBefore, floorsAfter)) return { confirmed: true, by: "floor" };
  return { confirmed: false, by: "" };
}

/** 读回比对: 长度一致 + 前 8 字一致(真机上只比长度会把「等长问号」放过) */
export function fillMatches(el, text) {
  const got = String((el && el.value) || "");
  const want = String(text || "");
  const a = Array.from(got);
  const b = Array.from(want);
  if (a.length !== b.length) return false;
  return a.slice(0, 8).join("") === b.slice(0, 8).join("");
}

/**
 * 用页面编辑器的 insertText 真正落字(单纯 set value 会被它的编辑器判成空)。
 * 先全选再插 —— 否则 insertText 会追加到刚设好的 value 后面, 正文翻倍。
 */
export function execInsertText(doc, win, text) {
  const d = doc || (win && win.document) || null;
  if (!d || typeof d.execCommand !== "function") return false;
  const el = typeof d.querySelector === "function" ? d.querySelector(DISCUSS_SEL.textarea) : null;
  try {
    if (el && typeof el.setSelectionRange === "function") el.setSelectionRange(0, String(el.value || "").length);
    return d.execCommand("insertText", false, String(text || "")) !== false;
  } catch (e) {
    return false;
  }
}

/**
 * 填字 + 读回校验, 不一致就重试一次。
 * 顺序: focus → 清空 → 原生 setter 置位 + input → insertText → 读回。
 * @returns {{ok:boolean, attempts:number, got:string, reason?:string}}
 */
export function fillReplyBoxVerified(doc, win, text, opts = {}) {
  const tries = Math.max(1, Number.isFinite(opts.tries) ? opts.tries : 2);
  const el = doc && typeof doc.querySelector === "function" ? doc.querySelector(DISCUSS_SEL.textarea) : null;
  if (!el) return { ok: false, attempts: 0, got: "", reason: "no-textarea" };
  let got = "";
  for (let i = 1; i <= tries; i++) {
    try {
      if (typeof el.focus === "function") el.focus();
    } catch (e) {
      /* focus 失败也接着填 */
    }
    try {
      if (typeof el.select === "function") el.select();
    } catch (e) {
      /* 同上 */
    }
    fillReplyBox(doc, win, ""); // 清空
    fillReplyBox(doc, win, text); // 原生 setter + input
    execInsertText(doc, win, text); // 页面编辑器真正认字
    got = String(el.value || "");
    if (fillMatches(el, text)) return { ok: true, attempts: i, got };
  }
  return { ok: false, attempts: tries, got, reason: "fill-failed" };
}

/** 三连派发(mousedown/mouseup/click): 真机上只 dispatch 一次 click 有时不提交 */
export function dispatchReplyClick(doc, win, button) {
  const b = button || (doc && typeof doc.querySelector === "function" ? doc.querySelector(DISCUSS_SEL.submit) : null);
  if (!b) return false;
  const mk = (type) => {
    try {
      const W = win || {};
      const C = W.MouseEvent || (typeof MouseEvent !== "undefined" ? MouseEvent : null);
      if (C) return new C(type, { bubbles: true, cancelable: true, view: W });
    } catch (e) {
      /* 落到普通对象 */
    }
    return { type, bubbles: true, cancelable: true };
  };
  let any = false;
  if (typeof b.dispatchEvent === "function") {
    for (const type of ["mousedown", "mouseup", "click"]) {
      try {
        b.dispatchEvent(mk(type));
        any = true;
      } catch (e) {
        /* 试下一个 */
      }
    }
  }
  if (!any && typeof b.click === "function") {
    try {
      b.click();
      any = true;
    } catch (e) {
      any = false;
    }
  }
  return any;
}

/**
 * 在当前已打开的话题页上发一条(全部靠注入的 doc/win/sleep, node 里可用假 DOM 测)。
 * 返回 {ok, stage:"send", reason?:失败码, confirmed, by?}
 */
export async function postReplyOnPage(o = {}) {
  const doc = o.doc;
  const win = o.win;
  const text = String(o.text || "");
  const sleep = typeof o.sleep === "function" ? o.sleep : async () => {};
  const log = typeof o.log === "function" ? o.log : () => {};
  const timing = Object.assign({}, DISCUSS_UI_TIMING, o.timing || {});
  const num = (v, dflt, lo) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.max(lo, Number(v)) : dflt);
  const waitMs = num(o.waitMs, timing.waitMs, 0);
  const pollMs = num(o.pollMs, timing.pollMs, 1);
  const confirmMs = num(o.confirmMs, timing.confirmMs, 0);
  const confirmPollMs = num(o.confirmPollMs, timing.confirmPollMs, 1);

  const query = (sel) => (doc && typeof doc.querySelector === "function" ? doc.querySelector(sel) : null);
  let box = query(DISCUSS_SEL.textarea);
  let btn = query(DISCUSS_SEL.submit);
  let waited = 0;
  while ((!box || !btn) && waited < waitMs) {
    await sleep(pollMs);
    waited += pollMs;
    box = query(DISCUSS_SEL.textarea);
    btn = query(DISCUSS_SEL.submit);
  }
  if (!box) return { ok: false, stage: "send", reason: "no-textarea", confirmed: false };
  if (!btn) return { ok: false, stage: "send", reason: "no-button", confirmed: false };

  const floorsBefore = maxFloorNo(docText(doc));
  const fill = fillReplyBoxVerified(doc, win, text);
  if (!fill.ok) {
    log(`填字没生效(读回 ${Array.from(fill.got).length} 字, 应为 ${Array.from(text).length} 字)`, "warning");
    return { ok: false, stage: "send", reason: "fill-failed", confirmed: false, fill };
  }
  log(`已填 ${Array.from(text).length} 字, 点发表…`, "info");
  if (!dispatchReplyClick(doc, win, btn)) return { ok: false, stage: "send", reason: "no-click", confirmed: false };

  let spent = 0;
  while (spent < confirmMs) {
    await sleep(Math.min(confirmPollMs, confirmMs - spent));
    spent += confirmPollMs;
    const dom = docText(doc);
    const floorsAfter = maxFloorNo(dom);
    const verdict = judgePostConfirm({ domText: dom, floorsBefore, floorsAfter, text });
    if (verdict.confirmed) return { ok: true, confirmed: true, by: verdict.by, floorsBefore, floorsAfter };
  }
  return { ok: false, stage: "send", reason: "no-floor", confirmed: false, floorsBefore };
}

/* -------------------------------------------------------------- 一轮 */

/** 正文是否已经出现在回复列表里(确认发成功; 用规范化后的包含关系, 防标点差异) */
export function replyAppeared(texts, text) {
  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, "")
      .replace(/[，。！？、；：""''（）《》…—,.!?;:()\[\]"']/g, "");
  const target = norm(text);
  if (!target) return false;
  return (texts || []).some((t) => {
    const other = norm(t);
    if (!other) return false;
    return other.indexOf(target) !== -1 || target.indexOf(other) !== -1;
  });
}

/**
 * 跑一轮(每条都走: 读已有回复 → 生成 → 校验 → (确认) → 发 → 确认楼层 → 记账 → 间隔)。
 *
 * 模式:
 *   · 逐条确认(默认): 生成完调 askUser 停住, 人不点「发送」就不发;
 *   · 连续自动(opts.auto): 不等确认, 按间隔直接发;
 *   · 批量自驱(opts.batch): 同连续自动, 另加接地校验(opts.batch 即开)、可中断的间隔等待,
 *     并在 stats.report 里留下一轮 run 报告(sent/failed/skipped)。
 *
 * @param {object} o
 * @param {Array<{uuid:string,title:string}>} o.topics   待处理话题(调用方已按列表页顺序给好)
 * @param {object} o.state      账本(会被就地修改; 每条后通过 io.saveState 落盘)
 * @param {object} o.opts       {targetTotal, dailyLimit, intervalMinSec, intervalMaxSec, minChars, maxChars, auto, batch, grounding, interruptibleWait, allowResendUuid, bbsid, courseId, classId}
 * @param {object} o.io         {compose, fetchTopic, fetchReplies, postReply, saveState, now, sleep, random}
 * @param {Function} o.askUser  (draft) => Promise<"send"|"skip"|"stop">; auto/batch 模式下不会被调用
 * @param {Function} o.shouldStop () => boolean
 * @param {Function} o.log
 * @param {Function} o.onItem   (uuid, status, extra) => void
 */
export async function runDiscussRound(o) {
  const io = o.io || {};
  const opts = Object.assign({}, DISCUSS_DEFAULTS, o.opts || {});
  const state = o.state || emptyDiscussState();
  const now = typeof io.now === "function" ? io.now : () => Date.now();
  const sleep = typeof io.sleep === "function" ? io.sleep : async () => {};
  const random = typeof io.random === "function" ? io.random : Math.random;
  const shouldStop = typeof o.shouldStop === "function" ? o.shouldStop : () => false;
  const log = typeof o.log === "function" ? o.log : () => {};
  const onItem = typeof o.onItem === "function" ? o.onItem : () => {};
  const topics = Array.isArray(o.topics) ? o.topics : [];

  const stats = { total: topics.length, sent: 0, skipped: 0, failed: 0, invalid: 0, stopped: false, reason: "", report: null };
  let consecutiveFails = 0;

  // 模式: auto 与 batch 都不等人确认; 接地校验只在 batch(或显式 grounding)时开
  const autoSend = !!(opts.auto || opts.batch);
  const groundingEnabled = !!(opts.batch || opts.grounding);

  const report = createRunReport({
    startedAt: now(),
    courseId: opts.courseId,
    bbsid: opts.bbsid,
    target: opts.targetTotal,
    dailyLimit: opts.dailyLimit,
    postMode: opts.postMode,
  });
  stats.report = report;

  const saveState = () => {
    try {
      if (typeof io.saveState === "function") io.saveState(state);
    } catch (e) {
      /* ignore */
    }
  };

  const waitInterval = async () => {
    const lo = Math.max(0, Number(opts.intervalMinSec) || 0);
    const hi = Math.max(lo, Number(opts.intervalMaxSec) || lo);
    const sec = lo + Math.floor(random() * (hi - lo + 1));
    if (sec <= 0) return;
    log(`间隔等待 ${sec}s 再发下一条`, "primary");
    // 批量模式要能在等待期间「停止」: 切成小段轮询; 其它模式照旧一次睡完(行为不变)
    if (!opts.interruptibleWait) {
      await sleep(sec * 1000);
      return;
    }
    let left = sec * 1000;
    while (left > 0 && !shouldStop()) {
      const step = Math.min(500, left);
      await sleep(step);
      left -= step;
    }
  };

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i] || {};
    const uuid = String(topic.uuid || "");
    if (!uuid) continue;

    if (shouldStop()) {
      stats.stopped = true;
      stats.reason = "用户停止";
      break;
    }

    const allowResend = String(opts.allowResendUuid || "").toLowerCase() === uuid.toLowerCase();
    if (!allowResend && hasRepliedTopic(state, uuid)) {
      stats.skipped += 1;
      reportSkipped(report, { topicUuid: uuid, title: topic.title, reason: "alreadyReplied" });
      onItem(uuid, "已回复过·跳过", { title: topic.title });
      continue;
    }
    if (!allowResend && hasSkippedTopic(state, uuid)) {
      stats.skipped += 1;
      reportSkipped(report, { topicUuid: uuid, title: topic.title, reason: "userSkipped" });
      onItem(uuid, "已跳过·跳过", { title: topic.title });
      continue;
    }

    const gate = canSend(state, { dailyLimit: opts.dailyLimit, targetTotal: opts.targetTotal, now: now() });
    if (!gate.ok) {
      stats.stopped = true;
      stats.reason = gate.reason;
      log(gate.reason + " —— 自动停止", "warning");
      break;
    }

    // ① 打开话题(拿 urlToken + 正文) ② 读已有回复
    let detail = null;
    try {
      detail = await io.fetchTopic({ uuid, title: topic.title, bbsid: opts.bbsid, courseId: opts.courseId, classId: opts.classId });
    } catch (e) {
      detail = null;
    }
    if (!detail || !detail.urlToken) {
      stats.failed += 1;
      consecutiveFails += 1;
      recordReply(state, { uuid, title: topic.title, chars: 0, result: "fail", note: "拿不到 urlToken", at: now() });
      reportFailed(report, { topicUuid: uuid, title: topic.title, stage: "compose", reason: "拿不到 urlToken", at: now() });
      saveState();
      onItem(uuid, "失败", { title: topic.title, note: "无 urlToken" });
      if (consecutiveFails >= DISCUSS_MAX_CONSECUTIVE_FAILS) {
        stats.stopped = true;
        stats.reason = `连续 ${consecutiveFails} 条失败`;
        break;
      }
      continue;
    }

    let existing = [];
    try {
      existing = await io.fetchReplies({ uuid, bbsid: opts.bbsid, courseId: opts.courseId, classId: opts.classId });
    } catch (e) {
      existing = [];
    }
    if (!Array.isArray(existing)) existing = [];

    // ③ 生成 + 校验(不合格重生成一次) + 接地校验(batch 模式, 不接地也重生成一次)
    const terms = groundingEnabled ? pickGroundingTerms(String(topic.title || detail.title || ""), String(detail.body || topic.body || "")) : [];
    let text = "";
    let check = null;
    let groundingOk = true;
    let groundingHits = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        text = await io.compose({
          topicTitle: String(topic.title || detail.title || ""),
          topicBody: String(detail.body || topic.body || ""),
          existingReplies: existing,
          minChars: opts.minChars,
          maxChars: opts.maxChars,
        });
      } catch (e) {
        text = "";
      }
      text = normalizeComposeText(text);
      check = checkComposeText(text, {
        minChars: opts.minChars,
        maxChars: opts.maxChars,
        existingReplies: existing,
      });
      groundingOk = true;
      groundingHits = [];
      if (!check.ok) {
        log(`第 ${attempt} 次生成不合格: ${check.reasons.join("; ")}`, "warning");
        continue;
      }
      if (!terms.length) {
        // 标题/正文里抽不出任何非停用词 → 无从校验, 如实记日志后放行
        if (groundingEnabled) log(`接地校验跳过: 话题里没抽出可用关键词(「${String(topic.title || "").slice(0, 16)}」)`, "warning");
        break;
      }
      const g = checkGrounding(text, terms);
      groundingOk = g.ok;
      groundingHits = g.hit;
      if (g.ok) {
        log(`接地校验通过(命中: ${g.hit.slice(0, 4).join("、")})`, "primary");
        break;
      }
      log(`第 ${attempt} 次接地未命中(备选词: ${terms.slice(0, 6).join("、")})`, "warning");
    }
    if (!check || !check.ok) {
      stats.invalid += 1;
      stats.skipped += 1;
      skipTopic(state, uuid);
      saveState();
      reportFailed(report, { topicUuid: uuid, title: topic.title, stage: "compose", reason: `两次生成都不合格: ${check ? check.reasons.join("; ") : "无正文"}`, at: now() });
      onItem(uuid, "生成不合格·跳过", { title: topic.title, note: check ? check.chars + " 字" : "" });
      continue;
    }
    if (!groundingOk) {
      // 接地失败不发送, 也不进跳过表(下一轮还能重试) —— 报告里留给人工
      stats.failed += 1;
      consecutiveFails += 1;
      recordReply(state, { uuid, title: topic.title, chars: check.chars, result: "fail", note: "接地失败: 正文与话题关键词都不沾边", at: now() });
      saveState();
      reportFailed(report, {
        topicUuid: uuid,
        title: topic.title,
        stage: "grounding",
        reason: `两次生成都没命中话题关键词(${terms.slice(0, 6).join("、") || "无可用关键词"})`,
        at: now(),
      });
      onItem(uuid, "接地失败·待人工", { title: topic.title, note: `${check.chars} 字` });
      log(`接地失败, 未发送「${String(topic.title || "").slice(0, 18)}」`, "warning");
      if (consecutiveFails >= DISCUSS_MAX_CONSECUTIVE_FAILS) {
        stats.stopped = true;
        stats.reason = `连续 ${consecutiveFails} 条失败`;
        break;
      }
      continue;
    }

    // ④ 逐条确认: 生成完停住, 等面板「发送/跳过」
    onItem(uuid, "草稿待确认", { title: topic.title, note: `${check.chars} 字` });
    if (!autoSend && typeof o.askUser === "function") {
      let answer = "skip";
      try {
        answer = await o.askUser({ uuid, title: topic.title, text, chars: check.chars });
      } catch (e) {
        answer = "skip";
      }
      // 面板里可能改过正文: {action:"send", text:"..."} → 用改后的(再校验一遍)
      let edited = null;
      if (answer && typeof answer === "object") {
        edited = typeof answer.text === "string" ? answer.text.trim() : null;
        answer = String(answer.action || "skip");
      }
      if (answer === "stop") {
        stats.stopped = true;
        stats.reason = "用户停止";
        break;
      }
      if (answer !== "send") {
        stats.skipped += 1;
        skipTopic(state, uuid);
        saveState();
        reportSkipped(report, { topicUuid: uuid, title: topic.title, reason: "userSkipped" });
        onItem(uuid, "已跳过", { title: topic.title });
        continue;
      }
      if (edited && edited !== text) {
        const recheck = checkComposeText(edited, {
          minChars: opts.minChars,
          maxChars: opts.maxChars,
          existingReplies: existing,
        });
        if (!recheck.ok) {
          stats.failed += 1;
          consecutiveFails += 1;
          recordReply(state, { uuid, title: topic.title, chars: recheck.chars, result: "fail", note: "手改正文不合格: " + recheck.reasons.join("; "), at: now() });
          reportFailed(report, { topicUuid: uuid, title: topic.title, stage: "compose", reason: `手改正文不合格: ${recheck.reasons.join("; ")}`, at: now() });
          saveState();
          onItem(uuid, "失败", { title: topic.title, note: recheck.reasons[0] || "手改正文不合格" });
          if (consecutiveFails >= DISCUSS_MAX_CONSECUTIVE_FAILS) {
            stats.stopped = true;
            stats.reason = `连续 ${consecutiveFails} 条失败`;
            break;
          }
          continue;
        }
        text = edited;
        check = recheck;
      }
    }

    // ⑤ 发帖(先把要发的东西照进日志: 万一发出去变成乱码, 能立刻分出是「生成坏了」还是「传输坏了」)
    log(`发送: ${check.chars} 字, token ${String(detail.urlToken || "").length} 位, 开头「${String(text).slice(0, 12)}」`, "info");
    let posted = { ok: false, error: "未发送" };
    try {
      posted = await io.postReply({ uuid, urlToken: detail.urlToken, text, topic: topic });
    } catch (e) {
      posted = { ok: false, error: e && e.message ? e.message : "发送异常" };
    }
    if (!posted || !posted.ok) {
      stats.failed += 1;
      consecutiveFails += 1;
      recordReply(state, { uuid, title: topic.title, chars: check.chars, result: "fail", note: (posted && posted.error) || "发送失败", at: now() });
      reportFailed(report, { topicUuid: uuid, title: topic.title, stage: "send", reason: (posted && posted.error) || "发送失败", at: now() });
      saveState();
      onItem(uuid, "失败", { title: topic.title, note: (posted && posted.error) || "发送失败" });
      if (consecutiveFails >= DISCUSS_MAX_CONSECUTIVE_FAILS) {
        stats.stopped = true;
        stats.reason = `连续 ${consecutiveFails} 条失败`;
        break;
      }
      continue;
    }

    // ⑥ 确认楼层里出现了自己的正文(最多 15s, 每 3s 查一次)
    let appeared = !!posted.confirmed;
    if (!appeared) {
      for (let poll = 0; poll < 5 && !appeared; poll++) {
        await sleep(3000);
        try {
          // ① getReplyList: 实测回包是 {datas:[{content}], poff, status}, collectReplyTexts 能吃
          const latest = await io.fetchReplies({ uuid, bbsid: opts.bbsid, courseId: opts.courseId, classId: opts.classId });
          appeared = replyAppeared(latest, text);
          if (poll === 0) log(`确认轮询: 读到 ${latest.length} 条已有回复`, "info");
          // ② 兜底: 话题页 HTML 里出现自己刚发的正文(页面可能是动态渲染的, 所以只当备选)
          if (!appeared && typeof io.fetchTopic === "function") {
            const page = await io.fetchTopic({ uuid, title: topic.title });
            appeared = topicPageHasReply(page && page.html, text);
          }
        } catch (e) {
          /* 查询失败不算发送失败, 继续轮询 */
        }
      }
    }

    if (appeared) {
      consecutiveFails = 0;
      stats.sent += 1;
      recordReply(state, { uuid, title: topic.title, chars: check.chars, result: "ok", note: "", at: now() });
      reportSent(report, { topicUuid: uuid, title: topic.title, chars: check.chars, text, groundingHits, at: now() });
      saveState();
      const counts = discussCounts(state, now());
      onItem(uuid, "已发送", { title: topic.title, note: `${check.chars} 字 · 今日 ${counts.today}` });
      log(`已回复「${String(topic.title || "").slice(0, 20)}」(${check.chars} 字)`, "success");
    } else {
      stats.failed += 1;
      consecutiveFails += 1;
      const why = `已提交但 15s 内没看到自己的楼层 | ${posted.via || "?"} | ${String(posted.raw || "").slice(0, 90)}`;
      recordReply(state, { uuid, title: topic.title, chars: check.chars, result: "fail", note: why, at: now() });
      reportFailed(report, { topicUuid: uuid, title: topic.title, stage: "send", reason: why, at: now() });
      log(`发帖没确认到楼层: ${why}`, "warning");
      saveState();
      onItem(uuid, "失败", { title: topic.title, note: "没确认到楼层" });
      if (consecutiveFails >= DISCUSS_MAX_CONSECUTIVE_FAILS) {
        stats.stopped = true;
        stats.reason = `连续 ${consecutiveFails} 条失败`;
        break;
      }
      continue;
    }

    if (i < topics.length - 1 && !shouldStop()) await waitInterval();
  }

  if (shouldStop() && !stats.stopped) {
    stats.stopped = true;
    stats.reason = "用户停止";
  }
  report.endedAt = now();
  return stats;
}

/* ------------------------------------------ UI 发帖跨页面续跑(队列 + 游标) */

/*
 * UI 发帖必须让页面自己跳转(iframe 本机拿不到 contentDocument), 一跳转脚本实例就没了。
 * 所以「本轮状态」必须落在 GM 存储里: 话题队列 + 游标 + 已发/失败/跳过 + 待发草稿。
 * 页面导航回来后, runtime 读到「有未完成的一轮」就接着跑, 成功过的话题不再重发。
 */

/** 队列里最多留几条(和账本一致) */
export const DISCUSS_UI_QUEUE_MAX = 800;

/** 队列超过这么久没动过 = 页面被关了, 不自动续跑(否则一打开讨论区就自己发) */
export const DISCUSS_UI_STALE_MS = 30 * 60 * 1000;

/** GM 存储键: 每课程 + 圈子一条队列(和账本/报告分开存) */
export function uiQueueStoreKey(courseId, bbsid) {
  const c = String(courseId || "unknown");
  const b = String(bbsid || "unknown");
  return `nca-discuss-uiq-${c}-${b}`;
}

const sameUuid = (a, b) => String(a || "").toLowerCase() !== "" && String(a || "").toLowerCase() === String(b || "").toLowerCase();

/** 一轮的 id(只用于日志/报告对齐; 不参与凭据) */
function uiRunId(ts) {
  const t = Number(ts) || Date.now();
  return `r${t.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

/**
 * 开一轮 UI 队列。topics 由调用方按列表页顺序给好(已回复/已跳过的应在外面先滤掉)。
 */
export function createUiQueue(o = {}) {
  const startedAt = Number(o.startedAt) || Date.now();
  const seen = new Set();
  const topics = [];
  for (const t of Array.isArray(o.topics) ? o.topics : []) {
    const uuid = String((t && t.uuid) || "");
    if (!uuid || seen.has(uuid.toLowerCase())) continue;
    seen.add(uuid.toLowerCase());
    topics.push({ uuid, title: String((t && t.title) || "").slice(0, 160) });
  }
  return {
    runId: String(o.runId || uiRunId(startedAt)),
    startedAt,
    updatedAt: startedAt,
    courseId: String(o.courseId || ""),
    bbsid: String(o.bbsid || ""),
    target: Number(o.target) || 0,
    dailyLimit: Number(o.dailyLimit) || 0,
    postMode: normalizePostMode(o.postMode),
    topics,
    cursor: 0,
    sent: [],
    failed: [],
    skipped: [],
    consecutiveFails: 0,
    status: "running",
    stopReason: "",
    pending: null,
    reportedAt: 0,
  };
}

/** 读队列(读坏/形状不对就当没有, 不让脏存储把整轮卡死) */
export function loadUiQueue({ courseId, bbsid, read } = {}) {
  let raw = null;
  try {
    raw = typeof read === "function" ? read(uiQueueStoreKey(courseId, bbsid), null) : null;
  } catch (e) {
    raw = null;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.topics)) return null;
  return {
    runId: String(raw.runId || ""),
    startedAt: Number(raw.startedAt) || 0,
    updatedAt: Number(raw.updatedAt) || Number(raw.startedAt) || 0,
    courseId: String(raw.courseId || ""),
    bbsid: String(raw.bbsid || ""),
    target: Number(raw.target) || 0,
    dailyLimit: Number(raw.dailyLimit) || 0,
    postMode: normalizePostMode(raw.postMode),
    topics: raw.topics.filter((t) => t && t.uuid).map((t) => ({ uuid: String(t.uuid), title: String(t.title || "").slice(0, 160) })),
    cursor: Math.max(0, Number(raw.cursor) || 0),
    sent: Array.isArray(raw.sent) ? raw.sent.filter((r) => r && r.uuid) : [],
    failed: Array.isArray(raw.failed) ? raw.failed.filter((r) => r && r.uuid) : [],
    skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((r) => r && r.uuid) : [],
    consecutiveFails: Math.max(0, Number(raw.consecutiveFails) || 0),
    status: raw.status === "running" || raw.status === "stopped" ? raw.status : "done",
    stopReason: String(raw.stopReason || ""),
    pending: raw.pending && raw.pending.uuid ? raw.pending : null,
    reportedAt: Number(raw.reportedAt) || 0,
  };
}

/** 存队列(存储失败只影响续跑, 不该打断发送) */
export function saveUiQueue({ courseId, bbsid, queue, write } = {}) {
  if (!queue || typeof write !== "function") return false;
  const trim = (list) => (Array.isArray(list) ? list.slice(-DISCUSS_UI_QUEUE_MAX) : []);
  queue.updatedAt = Date.now();
  try {
    write(uiQueueStoreKey(courseId, bbsid), {
      ...queue,
      sent: trim(queue.sent),
      failed: trim(queue.failed),
      skipped: trim(queue.skipped),
      pending: queue.pending || null,
    });
    return true;
  } catch (e) {
    return false;
  }
}

/** 清掉队列(用户重新开一轮前调, 免得还吃上一次的游标) */
export function clearUiQueue({ courseId, bbsid, write } = {}) {
  if (typeof write !== "function") return false;
  try {
    write(uiQueueStoreKey(courseId, bbsid), null);
    return true;
  } catch (e) {
    return false;
  }
}

/** 当前队列里挂着的那条待发草稿 */
export function findUiQueueTopic(queue, uuid) {
  const list = (queue && queue.topics) || [];
  return list.find((t) => sameUuid(t.uuid, uuid)) || null;
}

/** 把生成好的正文挂到队列上 —— 跳转前必须先落盘, 否则导航后正文就丢了 */
export function setUiQueuePending(queue, draft = {}) {
  if (!queue) return null;
  const uuid = String(draft.uuid || "");
  if (!uuid) return null;
  const topic = findUiQueueTopic(queue, uuid);
  queue.pending = {
    uuid,
    title: String(draft.title || (topic && topic.title) || "").slice(0, 160),
    text: String(draft.text || ""),
    chars: Number(draft.chars) || 0,
    groundingHits: Array.isArray(draft.groundingHits) ? draft.groundingHits.map(String) : [],
    at: Number(draft.at) || Date.now(),
  };
  return queue.pending;
}

/**
 * 下一个该处理的话题。
 * 顺序以 cursor 为准(每条处理过就前移), 再按 sent/skipped 兜一层 ——
 * 这样即使存储里的 cursor 落后, 已经成功过的话题也不会被重发。
 * @returns {{ok:true, index:number, topic:{uuid,title}} | {ok:false, reason:string}}
 */
export function nextUiTopic(queue) {
  if (!queue) return { ok: false, reason: "没有队列" };
  if (queue.status !== "running") return { ok: false, reason: queue.stopReason || "本轮已结束" };
  if (queue.consecutiveFails >= DISCUSS_MAX_CONSECUTIVE_FAILS) {
    return { ok: false, reason: `连续 ${queue.consecutiveFails} 条失败` };
  }
  if (queue.target > 0 && queue.sent.length >= queue.target) return { ok: false, reason: `已达目标 ${queue.target} 条` };
  const topics = Array.isArray(queue.topics) ? queue.topics : [];
  for (let i = Math.max(0, Number(queue.cursor) || 0); i < topics.length; i++) {
    const t = topics[i];
    if (!t || !t.uuid) continue;
    if (queue.sent.some((r) => sameUuid(r.uuid, t.uuid))) continue;
    if (queue.skipped.some((r) => sameUuid(r.uuid, t.uuid))) continue;
    return { ok: true, index: i, topic: t };
  }
  return { ok: false, reason: "没有待处理话题" };
}

/**
 * 结算一条(成功/失败/跳过), 推进游标并检查结束条件。
 * @param {object} queue
 * @param {{uuid:string,result:"ok"|"fail"|"skip",reason?:string,reasonCode?:string,chars?:number,text?:string,groundingHits?:string[],by?:string,at?:number}} entry
 */
export function resolveUiQueueTopic(queue, entry = {}) {
  if (!queue) return null;
  const uuid = String(entry.uuid || "");
  const topic = findUiQueueTopic(queue, uuid);
  const result = entry.result === "ok" ? "ok" : entry.result === "skip" ? "skip" : "fail";
  const row = {
    uuid,
    title: String(entry.title || (topic && topic.title) || "").slice(0, 160),
    at: Number(entry.at) || Date.now(),
    chars: Number(entry.chars) || Array.from(String(entry.text || "")).length,
    reason: String(entry.reason || "").slice(0, 200),
    reasonCode: String(entry.reasonCode || "").slice(0, 40),
    by: String(entry.by || ""),
  };
  if (result === "ok") {
    row.text = String(entry.text || "");
    row.groundingHits = Array.isArray(entry.groundingHits) ? entry.groundingHits.map(String) : [];
    queue.sent.push(row);
    queue.consecutiveFails = 0;
  } else if (result === "skip") {
    queue.skipped.push(row);
  } else {
    queue.failed.push(row);
    queue.consecutiveFails += 1;
  }
  queue.pending = null;
  const idx = (queue.topics || []).findIndex((t) => sameUuid(t.uuid, uuid));
  if (idx >= 0 && idx + 1 > queue.cursor) queue.cursor = idx + 1;

  if (queue.target > 0 && queue.sent.length >= queue.target) {
    queue.status = "done";
    queue.stopReason = `已达目标 ${queue.target} 条`;
  } else if (queue.consecutiveFails >= DISCUSS_MAX_CONSECUTIVE_FAILS) {
    queue.status = "stopped";
    queue.stopReason = `连续 ${queue.consecutiveFails} 条失败`;
  } else if (queue.cursor >= (queue.topics || []).length) {
    queue.status = "done";
    queue.stopReason = "话题已跑完";
  }
  return row;
}

/** 队列是不是放太久没动(页面被关了): 是的话不自动续跑 */
export function isUiQueueStale(queue, now = Date.now(), maxAgeMs = DISCUSS_UI_STALE_MS) {
  if (!queue) return true;
  const last = Number(queue.updatedAt) || Number(queue.startedAt) || 0;
  if (!last) return true;
  return Number(now) - last > maxAgeMs;
}

/** 面板进度: 已处理(成功+失败+跳过) / 总数, 以及「第 N/M 条」文案 */
export function uiQueueProgress(queue) {
  const total = (queue && queue.topics ? queue.topics.length : 0);
  const done = queue ? (queue.sent || []).length + (queue.failed || []).length + (queue.skipped || []).length : 0;
  const index = total ? Math.min(done + 1, total) : 0;
  return { done, total, index, label: total ? `第 ${index}/${total} 条` : "没有话题" };
}

/** 队列 → run 报告(结束条件满足时调一次; 字段走统一的白名单导出) */
export function uiQueueToReport(queue, now = Date.now()) {
  const report = createRunReport({
    startedAt: (queue && queue.startedAt) || now,
    courseId: queue && queue.courseId,
    bbsid: queue && queue.bbsid,
    target: queue && queue.target,
    dailyLimit: queue && queue.dailyLimit,
    postMode: queue && queue.postMode,
  });
  report.endedAt = Number(now) || Date.now();
  report.stopReason = String((queue && queue.stopReason) || "");
  for (const s of (queue && queue.sent) || []) {
    reportSent(report, { topicUuid: s.uuid, title: s.title, chars: s.chars, text: s.text, groundingHits: s.groundingHits, at: s.at });
    const last = report.sent[report.sent.length - 1];
    if (last) last.by = String(s.by || "");
  }
  for (const f of (queue && queue.failed) || []) {
    const stage = f.reasonCode === "compose" || f.reasonCode === "grounding" ? f.reasonCode : "send";
    reportFailed(report, { topicUuid: f.uuid, title: f.title, stage, reason: f.reason, reasonCode: f.reasonCode, at: f.at });
  }
  for (const k of (queue && queue.skipped) || []) {
    reportSkipped(report, { topicUuid: k.uuid, title: k.title, reason: k.reason === "alreadyReplied" ? "alreadyReplied" : "userSkipped" });
  }
  return report;
}
