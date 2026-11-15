#!/usr/bin/env node
// 讨论区自动回复的单测(node tools/discuss-test.mjs)
// 假 DOM + 假 fetch/io, 不碰真页面、不联网、不写 GM。
// 覆盖: 路由识别 / HTML 解析 / 字数与禁用词 / 相似度判重 / 跳过已回复 /
//       每日与总量上限 / 逐条确认不自动发 / 连续 3 次失败自动停 / 写框点按钮 / 间隔 /
//       接地校验(0 token) / 批量自驱(接地/上限/连败/等待中停止) / run 报告 / 抽样。
//
// 必须先有 window 才能 import 路由表: adapters → cx → font-decrypt → vendor/typr.js
// 在模块初始化时就会摸 window(只看 import 静态分析看不出来)。
globalThis.window = globalThis;
const { createAdapterForUrl } = await import("../src/adapters/index.js");
import {
  parseDiscussContext,
  isDiscussUrl,
  extractBbsid,
  parseTopicListHtml,
  collectTopicsFromDoc,
  extractUrlToken,
  extractTopicBody,
  collectReplyTexts,
  discussCharCount,
  checkComposeText,
  normalizeComposeText,
  discussStoreKey,
  emptyDiscussState,
  loadDiscussState,
  persistDiscussState,
  dayKey,
  discussCounts,
  hasRepliedTopic,
  recordReply,
  skipTopic,
  canSend,
  fillReplyBox,
  clickReplyButton,
  replyAppeared,
  topicPageHasReply,
  runDiscussRound,
  pickGroundingTerms,
  checkGrounding,
  createRunReport,
  reportSent,
  reportFailed,
  reportSkipped,
  sanitizeRunReport,
  reportToJson,
  loadRunReports,
  saveRunReport,
  runsStoreKey,
  sampleSentForReview,
  formatSamplesForReview,
  DISCUSS_DEFAULTS,
  DISCUSS_SEL,
  DISCUSS_GROUNDING_MAX_TERMS,
  DISCUSS_GROUNDING_STOPWORDS,
  DISCUSS_RUNS_KEEP,
  normalizePostMode,
  replysListUrl,
  docText,
  docHasReply,
  maxFloorNo,
  floorsIncreased,
  judgePostConfirm,
  fillMatches,
  fillReplyBoxVerified,
  execInsertText,
  dispatchReplyClick,
  postReplyOnPage,
  uiFailLabel,
  createUiQueue,
  loadUiQueue,
  saveUiQueue,
  clearUiQueue,
  setUiQueuePending,
  findUiQueueTopic,
  nextUiTopic,
  resolveUiQueueTopic,
  isUiQueueStale,
  uiQueueProgress,
  uiQueueToReport,
  uiQueueStoreKey,
  DISCUSS_UI_TIMING,
  DISCUSS_UI_FAIL_LABELS,
  DISCUSS_UI_STALE_MS,
  DISCUSS_UI_QUEUE_MAX,
} from "../src/core/discuss.js";

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✅ " + msg);
  } else {
    fail++;
    console.log("  ❌ " + msg);
  }
};

/* ------------------------------------------------------------- 常量与工具 */

const BBS = "4e716eede0d7ea29956475a72bff5210";
const U1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const U2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const U3 = "cccccccccccccccccccccccccccccccc";

const listUrl = `https://groupweb.chaoxing.com/pc/topic/topiclist/index?bbsid=${BBS}&courseId=100000005&classId=100000003`;
const detailUrl = `https://groupweb.chaoxing.com/course/topic/v3/bbs/${BBS}/${U1}/replysList?courseId=100000005&classId=100000003`;

/** 一段合格的回复(去掉空白后 119 字, 落在默认 80-150 内) */
const GOOD =
  "机会成本只算放弃掉的最高价值那一项,原因是资源在同一时点只能投向一条用途,真正被牺牲的只有不做这件事时会转向的那个最好替代。" +
  "几项相加等于假设同一段时间能分成几份用,稀缺这个前提就消失了;取最大值对应的是真实的反事实,才让不同方案可以比较。";

const makeTopic = (uuid, title) => ({ uuid, title });

/** 假 DOM: 只实现讨论区用到的那点能力(selector → 元素) */
function makeFakeDoc({ textarea = true, submit = true } = {}) {
  const events = [];
  const el = (tag, extra = {}) => {
    const node = {
      tag,
      value: "",
      disabled: false,
      _listeners: {},
      addEventListener(ev, fn) {
        (this._listeners[ev] = this._listeners[ev] || []).push(fn);
      },
      dispatchEvent(e) {
        events.push({ tag, type: String(e && e.type) });
        (this._listeners[e && e.type] || []).forEach((fn) => fn(e));
        return true;
      },
      click() {
        this.clicked = (this.clicked || 0) + 1;
        (this._listeners.click || []).forEach((fn) => fn({ type: "click" }));
      },
      getAttribute(name) {
        return extra[name] || "";
      },
      textContent: extra.textContent || "",
      href: extra.href || "",
    };
    return node;
  };
  const ta = textarea ? el("textarea") : null;
  const btn = submit ? el("div") : null;
  const nodes = {};
  if (ta) nodes[DISCUSS_SEL.textarea] = ta;
  if (btn) nodes[DISCUSS_SEL.submit] = btn;
  const doc = {
    querySelector(sel) {
      return nodes[sel] || null;
    },
    querySelectorAll(sel) {
      if (sel === 'a[href*="replysList"]') return doc._links || [];
      return [];
    },
    _links: [],
    _nodes: nodes,
    _events: events,
  };
  return doc;
}

/** 假 io: 记录所有网络调用, 按 script 控制成功/失败 */
function makeIo({ topics = [], failPost = false, replies = [], urlToken = "0123456789abcdef0123456789abcdef", composeText = GOOD } = {}) {
  const calls = { compose: 0, fetchTopic: 0, fetchReplies: 0, post: 0, saved: 0, posts: [], sleeps: [] };
  const after = [];
  return {
    calls,
    io: {
      compose: async (payload) => {
        calls.compose += 1;
        calls.lastCompose = payload;
        return typeof composeText === "function" ? composeText(calls.compose, payload) : composeText;
      },
      fetchTopic: async ({ uuid, title }) => {
        calls.fetchTopic += 1;
        return { urlToken, body: `正文 ${title || uuid}`, title: title || "" };
      },
      fetchReplies: async () => {
        calls.fetchReplies += 1;
        const extra = after.splice(0, after.length);
        return replies.concat(extra);
      },
      postReply: async ({ uuid, text }) => {
        calls.post += 1;
        calls.posts.push({ uuid, text });
        if (failPost) return { ok: false, error: "服务端拒绝" };
        after.push(text); // 发出去之后, 下一次读回复就能看到它
        return { ok: true, confirmed: true }; // 默认直接当「楼层已确认」, 要测轮询的在用例里覆盖
      },
      saveState: async () => {
        calls.saved += 1;
      },
      sleep: async (ms) => {
        calls.sleeps.push(ms);
      },
      now: () => Date.now(),
      random: () => 0,
    },
  };
}

const baseOpts = { intervalMinSec: 0, intervalMaxSec: 0, auto: true };

/* --------------------------------------------------------- 1. 路由识别 */

console.log("\n[1] 路由识别");
{
  const r1 = createAdapterForUrl(listUrl);
  ok(r1 && r1.platform === "cx" && r1.workType === "discuss", "列表页识别为 cx/discuss");
  ok(r1 && r1.discuss && r1.discuss.mode === "list", "列表页 mode=list");
  ok(r1.discuss.bbsid === BBS, "列表页 bbsid 从 query 取到");

  const r2 = createAdapterForUrl(detailUrl);
  ok(r2 && r2.workType === "discuss" && r2.discuss.mode === "detail", "详情页识别为 cx/discuss, mode=detail");
  ok(r2.discuss.topicUuid === U1, "详情页 topicUuid 从 path 取到");
  ok(r2.discuss.classId === "100000003", "详情页 classId 从 query 取到");

  ok(createAdapterForUrl("https://groupweb.chaoxing.com/pc/index/index") === null, "别的 groupweb 页面不是 discuss");
  ok(isDiscussUrl("https://groupweb.chaoxing.com/pc/topic/topiclist/index") === true, "isDiscussUrl 认列表页");
  ok(isDiscussUrl("https://mooc2-ans.chaoxing.com/mooc2-ans/coursemanagev3/stu-base-info") === false, "非 groupweb 不是 discuss");

  const ctxClazz = parseDiscussContext(`https://groupweb.chaoxing.com/pc/topic/topiclist/index?bbsid=${BBS}&clazzId=42`);
  ok(ctxClazz && ctxClazz.classId === "42", "clazzId 也认(列表页自动补参可能用这个名字)");
  ok(parseDiscussContext("https://groupweb.chaoxing.com/") === null, "groupweb 首页不是 discuss");
}

/* --------------------------------------------------------- 2. 页面解析 */

console.log("\n[2] HTML / JSON 解析");
{
  const bbsJson = { data: { nav: [{ linkUrl: `/bbs/index?bbsid=${BBS}&x=1` }] } };
  ok(extractBbsid(bbsJson) === BBS, "extractBbsid 从 JSON 的 linkUrl 抠出 bbsid");
  ok(extractBbsid(`{"bbsid":"${BBS}"}`) === BBS, "extractBbsid 认 bbsid 字段");
  ok(extractBbsid("no bbsid here") === "", "extractBbsid 抠不到返回空串");

  const listHtml = `
    <div class="list">
      <a href="/course/topic/v3/bbs/${BBS}/${U1}/replysList?courseId=1&classId=2"><span>为什么机会成本只算最优替代?</span></a>
      <a href="/course/topic/v3/bbs/${BBS}/${U1}/replysList?courseId=1&classId=2"><img src="a.png"></a>
      <a href="/course/topic/v3/bbs/${BBS}/${U2}/replysList?courseId=1&classId=2">完全竞争为什么不能自己定价</a>
      <a href="/other/page">别的链接</a>
    </div>`;
  const topics = parseTopicListHtml(listHtml, BBS);
  ok(topics.length === 2, "列表页解析出 2 条(按 uuid 去重)");
  ok(topics[0].uuid === U1 && /机会成本/.test(topics[0].title), "第一条 uuid/标题正确");
  ok(topics[1].uuid === U2, "第二条 uuid 正确");
  ok(parseTopicListHtml(listHtml, "deadbeefdeadbeef").length === 0, "bbsid 对不上就不认");

  const doc = makeFakeDoc();
  const a1 = { getAttribute: () => `/course/topic/v3/bbs/${BBS}/${U3}/replysList`, textContent: "从 DOM 里拿的话题", href: "" };
  doc._links = [a1];
  const fromDom = collectTopicsFromDoc(doc, BBS);
  ok(fromDom.length === 1 && fromDom[0].uuid === U3, "collectTopicsFromDoc 从已渲染 DOM 收话题");

  // 真机列表页(topiclist/index): 标题是 a.topicli_link[href="javascript:void(0);"],
  // uuid 只挂在祖先 li 的 data-uuid 上 —— 老逻辑只认 href*=replysList, 会一条都收不到。
  const U4 = "a201fbe6-56cb-45bc-8cfb-37e372b59eb2";
  const liOf = (uuid, title) => ({
    getAttribute: (n) => (n === "data-uuid" ? uuid : ""),
    querySelector: () => ({ textContent: title }),
    textContent: title,
  });
  const liveDoc = {
    querySelectorAll(sel) {
      if (sel === "[data-uuid]") return [liOf(U4, " 60. 公共物品、私人物品、公共资源的区别？ "), liOf(U4, "60. 公共物品、私人物品、公共资源的区别？"), liOf("not-a-uuid", "垃圾")];
      if (String(sel).indexOf("replysList") !== -1) return [];
      return [];
    },
  };
  const fromLive = collectTopicsFromDoc(liveDoc, BBS);
  ok(fromLive.length === 1, "真机列表页: 从 li[data-uuid] 收到话题(同 uuid 去重, 非法 uuid 丢弃)");
  ok(fromLive[0].uuid === U4 && /公共物品/.test(fromLive[0].title), "真机列表页: uuid/标题正确");
  ok(fromLive[0].title === "60. 公共物品、私人物品、公共资源的区别？", "真机列表页: 标题首尾空白被 trim");

  const detailHtml = `<script>window.obj = { urlToken: "abcdef0123456789abcdef0123456789" };</script>
    <div class="fr-view">老师讲机会成本时说要算放弃的最优选项，为什么不全部加起来？</div>`;
  ok(extractUrlToken(detailHtml) === "abcdef0123456789abcdef0123456789", "详情页拿到 urlToken");
  ok(extractUrlToken("<div>没有 token</div>") === "", "没有 urlToken 返回空串");
  ok(/最优选项/.test(extractTopicBody(detailHtml)), "详情页抽出主题正文");
  ok(extractTopicBody("<div>什么都没有</div>") === "", "没有正文返回空串");

  const replyPayload = { data: { list: [{ content: "<p>因为资源稀缺，<b>只能选一个</b></p>" }, { content: "第二楼的说法" }] } };
  const texts = collectReplyTexts(replyPayload);
  ok(texts.length === 2, "getReplyList 返回里抠出 2 条已有回复");
  ok(texts[0] === "因为资源稀缺，只能选一个", "楼层 HTML 被剥成纯文本");

  // 真机回包(2026-11-13 实测): {"datas":[{content}], "poff":0, "status":true} —— 没有 data.list
  const realPayload = {
    datas: [{ content: "<p>真机的第一条回复</p>", bbsid: "x" }, { content: "真机的第二条回复" }],
    poff: 0,
    status: true,
  };
  const realTexts = collectReplyTexts(realPayload);
  ok(realTexts.length === 2, "真机回包形状 datas[] 也能抠出 2 条(不是 data.list)");
  ok(realTexts[0] === "真机的第一条回复", "datas[] 里的 HTML 同样被剥成纯文本");
}

/* ------------------------------------------------- 3. 字数 / 禁用词 / 相似度 */

console.log("\n[3] 正文校验");
{
  const good = checkComposeText(GOOD, { minChars: 80, maxChars: 150 });
  ok(good.ok, `合格正文通过(${good.chars} 字)`);
  ok(good.chars >= 80 && good.chars <= 150, "合格正文落在 80-150 字");

  const short = checkComposeText("太短了", { minChars: 80, maxChars: 150 });
  ok(!short.ok && short.reasons.some((r) => /太短/.test(r)), "太短被拦");

  const long = checkComposeText("啊".repeat(300), { minChars: 80, maxChars: 150 });
  ok(!long.ok && long.reasons.some((r) => /太长/.test(r)), "太长被拦");

  for (const word of ["首先", "综上所述", "希望对你有帮助"]) {
    const r = checkComposeText(`${GOOD.slice(0, 60)}${word}${GOOD.slice(60)}`, { minChars: 10, maxChars: 400 });
    ok(!r.ok && r.reasons.some((x) => /禁用词/.test(x)), `含「${word}」被拦`);
  }
  const ai = checkComposeText(`作为一个模型, ${GOOD}`, { minChars: 10, maxChars: 400 });
  ok(!ai.ok, "提到「作为一个模型」被拦");

  const opening = checkComposeText(`同学们，${GOOD}`, { minChars: 10, maxChars: 400 });
  ok(!opening.ok && opening.reasons.some((r) => /称呼语/.test(r)), "开头称呼语被拦");

  const dup = checkComposeText(GOOD, { minChars: 80, maxChars: 150, existingReplies: [GOOD] });
  ok(!dup.ok && dup.reasons.some((r) => /太像/.test(r)), "与已有回复雷同被拦");
  ok(dup.similarity >= 90, `雷同的相似度被算出来(${dup.similarity}%)`);

  const different = checkComposeText(GOOD, {
    minChars: 80,
    maxChars: 150,
    existingReplies: ["这个问题的关键在于不同商品的替代弹性不同, 消费者的预算约束决定了他能买到什么组合。"],
  });
  ok(different.ok, "跟已有回复不同则放行");

  ok(discussCharCount(" 一 二 三\n四 ") === 4, "字数按码点算且忽略空白");
  ok(normalizeComposeText('```\n"回复: 你好"\n```') === "你好", "normalizeComposeText 去掉围栏/前缀/引号");
}

/* ------------------------------------------------------- 4. 记账与上限 */

console.log("\n[4] 记账 / 额度");
{
  const key = discussStoreKey("100000005", BBS);
  ok(key === `nca-discuss-100000005-${BBS}`, "存储键按 courseId+bbsid 分组");

  const mem = {};
  const write = (k, v) => {
    mem[k] = JSON.stringify(v);
  };
  const read = (k, dflt) => (mem[k] ? JSON.parse(mem[k]) : dflt);

  const state = emptyDiscussState();
  const now = Date.now();
  recordReply(state, { uuid: U1, title: "t1", chars: 120, result: "ok", at: now });
  recordReply(state, { uuid: U2, title: "t2", chars: 0, result: "fail", at: now });
  ok(discussCounts(state, now).today === 1, "今日计数只数成功的那条");
  ok(discussCounts(state, now).total === 1, "累计计数只数成功的那条");
  ok(discussCounts(state, now + 24 * 3600 * 1000).today === 0, "跨天后今日计数归零");
  ok(hasRepliedTopic(state, U1) && !hasRepliedTopic(state, U2), "已回复过的话题能查到(失败的不算)");

  persistDiscussState({ courseId: "100000005", bbsid: BBS, state, write });
  const loaded = loadDiscussState({ courseId: "100000005", bbsid: BBS, read });
  ok(loaded.records.length === 2 && loaded.records[0].uuid === U1, "账本存/读一致");
  ok(loadDiscussState({ courseId: "x", bbsid: "y", read }).records.length === 0, "换课程/圈子读不到别人的账本");

  const g1 = canSend(state, { dailyLimit: 10, targetTotal: 75, now });
  ok(g1.ok, "有余额时放行");
  const g2 = canSend(state, { dailyLimit: 1, targetTotal: 75, now });
  ok(!g2.ok && /每天上限/.test(g2.reason), "到每天上限被拦");
  const g3 = canSend(state, { dailyLimit: 10, targetTotal: 1, now });
  ok(!g3.ok && /总条数/.test(g3.reason), "到目标总条数被拦");

  skipTopic(state, U3);
  ok(state.skipped.indexOf(U3) !== -1, "跳过的话题进跳过表");
  ok(dayKey(now) === dayKey(now), "dayKey 稳定");
}

/* ----------------------------------------------------- 5. 接地校验 */

console.log("\n[5] 接地校验(0 token)");
{
  const t1 = pickGroundingTerms("什么是机会成本", "机会成本是放弃掉的最优替代");
  ok(t1.indexOf("什么") === -1, "中文停用词「什么」被去掉");
  ok(!t1.some((t) => DISCUSS_GROUNDING_STOPWORDS.indexOf(t) !== -1), "结果里不含任何中文停用词");
  ok(t1.indexOf("机会成本") !== -1, "高频词「机会成本」被留下");

  const t2 = pickGroundingTerms("AI 与 cost", "is it ok to use AI");
  ok(t2.indexOf("ai") === -1 && t2.indexOf("is") === -1 && t2.indexOf("ok") === -1, "英文短词(< 3)被滤掉");
  ok(t2.indexOf("cost") !== -1, "英文长词保留(统一小写)");

  const t3 = pickGroundingTerms("公共物品", "公共物品和私人物品的区别");
  ok(new Set(t3).size === t3.length, "去重(没有重复项)");

  const longTerms = pickGroundingTerms(
    "公共物品 私人物品 公共资源 竞争性 排他性 边际效用 机会成本 沉没成本 显性成本",
    "公共物品 私人物品 公共资源 竞争性 排他性 边际效用 机会成本 沉没成本 显性成本"
  );
  ok(longTerms.length === DISCUSS_GROUNDING_MAX_TERMS, `最多 ${DISCUSS_GROUNDING_MAX_TERMS} 个(实际 ${longTerms.length})`);
  ok(pickGroundingTerms("", "").length === 0, "标题正文都空 → 返回空数组");

  // 真机回归(2026-11-13): 标题全是 4 字滑窗碎片时, 一篇扣题的回复一个都不含 → 被白拦
  const tTitle = "如何理解市场供求关系对价格的影响？如何理解市场供求关系对价格的影响？";
  const tTerms = pickGroundingTerms(tTitle, "");
  ok(
    tTerms.some((x) => Array.from(x).length <= 3),
    "长标题也要留短词兜底(不然正文换个说法就判不接地)"
  );
  ok(checkGrounding("供求决定价格：需求增加时价格上升。", tTerms).ok, "扣题回复(含「价格」)接地通过");
  ok(!checkGrounding("货币政策通过调节利率影响投资，时滞较长。", tTerms).ok, "偏题回复仍被拦下");

  const terms = ["机会成本", "cost"];
  const hit1 = checkGrounding("机会成本只算最高的那个替代", terms);
  ok(hit1.ok && hit1.hit.indexOf("机会成本") !== -1, "命中 1 个即过");
  const hit0 = checkGrounding("边际效用递减", terms);
  ok(!hit0.ok && hit0.hit.length === 0, "一个都不命中就不过");
  const hitEn = checkGrounding("The Opportunity COST is high", ["opportunity", "cost"]);
  ok(hitEn.ok && hitEn.hit.length === 2, "英文大小写不敏感");
  ok(checkGrounding("", terms).ok === false, "空正文不过");
}

/* ------------------------------------------------ 6. run 报告与抽样 */

console.log("\n[6] run 报告与抽样");
{
  const report = createRunReport({ startedAt: 1000, courseId: "c1", bbsid: "b1", target: 75, dailyLimit: 10 });
  ok(report.sent.length === 0 && report.failed.length === 0 && report.skipped.length === 0, "空报告三类清单都在");
  reportSent(report, { topicUuid: U1, title: "t1", chars: 100, text: GOOD, groundingHits: ["机会成本"], at: 2000 });
  reportFailed(report, { topicUuid: U2, title: "t2", stage: "grounding", reason: "没命中", at: 3000 });
  reportFailed(report, { topicUuid: U2, title: "t2", stage: "bogus", reason: "x" });
  reportSkipped(report, { topicUuid: U3, title: "t3", reason: "alreadyReplied" });
  reportSkipped(report, { topicUuid: U3, title: "t3", reason: "什么理由" });
  ok(report.sent.length === 1 && report.sent[0].text === GOOD, "sent 记正文全文(不只是长度)");
  ok(report.failed.length === 2 && report.failed[1].stage === "compose", "非法 stage 归到 compose");
  ok(report.skipped.length === 2 && report.skipped[1].reason === "userSkipped", "非法跳过理由归到 userSkipped");

  report.cookie = "SESSION=secret";
  report.urlToken = "abc";
  report.sent[0].visitorId = "v1";
  const json = reportToJson(report);
  ok(!/urlToken|visitorId|cookie|SESSION/.test(json), "导出 JSON 里没有 urlToken/cookie/visitorId");
  ok(/"topicUuid"/.test(json) && /"groundingHits"/.test(json), "导出 JSON 保留报告字段");
  ok(Object.keys(sanitizeRunReport({ url_token: "x", a: 1 })).join() === "a", "sanitize 按键名过滤凭据");

  const mem = {};
  const write = (k, v) => (mem[k] = JSON.stringify(v));
  const read = (k, dflt) => (mem[k] ? JSON.parse(mem[k]) : dflt);
  ok(runsStoreKey("c1", "b1") === "nca-discuss-runs-c1-b1", "报告存储键按 courseId+bbsid 分组");
  for (let i = 0; i < 7; i++) saveRunReport({ courseId: "c1", bbsid: "b1", report: { ...report, target: i }, read, write });
  const kept = loadRunReports({ courseId: "c1", bbsid: "b1", read });
  ok(kept.length === DISCUSS_RUNS_KEEP, `只保留最近 ${DISCUSS_RUNS_KEEP} 轮(实际 ${kept.length})`);
  ok(kept[kept.length - 1].target === 6, "保留的是最新一轮");

  const many = Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, text: `正文${i}` }));
  const s40 = sampleSentForReview(many);
  ok(s40.length === 4 && s40.every((e) => e && e.text), "40 条抽 4 条(1/10)");
  ok(s40[0].title !== s40[1].title, "抽样不重复");
  ok(sampleSentForReview([{ title: "only", text: "x" }]).length === 1, "只有 1 条也抽 1 条");
  ok(sampleSentForReview(many.slice(0, 4)).length === 1, "少量条目至少抽 1 条");
  const s100 = sampleSentForReview(Array.from({ length: 100 }, (_, i) => ({ title: `t${i}`, text: "x" })));
  ok(s100.length === 5, "100 条最多抽 5 条");
  const s30 = sampleSentForReview(many.slice(0, 30));
  ok(s30.length >= 1 && s30.length <= 5, `抽样数量在 1-5 之间(${s30.length})`);
  ok(s30[0].title === "t5", "等距抽取(30 条抽 3 条 → 第 6/16/26 条)");
  const fmt = formatSamplesForReview([{ title: "话题A", text: "正文A", groundingHits: ["词"] }]);
  ok(/【1】话题A/.test(fmt) && /正文A/.test(fmt), "抽样文本带编号 + 标题 + 正文");
}

/* ----------------------------------------------------- 7. 写框 / 点按钮 */

console.log("\n[7] 页面写入");
{
  const doc = makeFakeDoc();
  const sent = [];
  const ta = doc._nodes[DISCUSS_SEL.textarea];
  ta.addEventListener("input", () => sent.push(ta.value));
  ok(fillReplyBox(doc, null, "测试正文") === true, "fillReplyBox 写入成功");
  ok(ta.value === "测试正文" && sent[0] === "测试正文", "写入后派发了 input(字数计数才会同步)");

  const btn = doc._nodes[DISCUSS_SEL.submit];
  let clicks = 0;
  btn.addEventListener("click", () => (clicks += 1));
  ok(clickReplyButton(doc) === true && clicks === 1, "clickReplyButton 点到了发送按钮");
  btn.disabled = true;
  ok(clickReplyButton(doc) === false, "按钮 disabled 时不点");

  ok(fillReplyBox(makeFakeDoc({ textarea: false }), null, "x") === false, "没有回复框返回 false");
  ok(clickReplyButton(makeFakeDoc({ submit: false })) === false, "没有发送按钮返回 false");

  ok(replyAppeared(["我发出去的内容，含标点。"], "我发出去的内容 含标点"), "楼层确认忽略空白/标点差异");
  ok(!replyAppeared(["别人的话"], "我发出去的内容"), "楼层里没有自己的话就不算成功");

  // 真机: getReplyList 对「明明有回复」的话题也返回 0 条 → 用话题页 HTML 确认
  const MY_TEXT = "这些特征合起来会推出一个结果：长期经济利润为零。厂商数量极多、每家份额微小。";
  const pageHtml = `<div class="reply-item"> <p>${MY_TEXT.slice(0, 10)}<br>${MY_TEXT.slice(10)}</p></div>`;
  ok(topicPageHasReply(pageHtml, MY_TEXT), "话题页 HTML 里出现自己正文 → 确认成功(允许 <br> 断开)");
  ok(!topicPageHasReply(`<div>别人的回复</div>`, MY_TEXT), "话题页里没有自己正文 → 不算成功");
  ok(!topicPageHasReply(pageHtml, "太短"), "正文过短(<6 字)一律不算命中(防误判)");
  ok(topicPageHasReply(`<p>a&amp;b &quot;引号&quot; 之后的正文片段继续写满十六个字</p>`, `a&b "引号" 之后的正文片段`), "HTML 实体解一次再比");
  ok(!topicPageHasReply("", MY_TEXT), "空 HTML 不算命中");
}

/* ------------------------------------------- 8. 一轮: 跳过/上限/确认/连败 */

const runRound = async ({ topics, state, opts, io, askUser }) =>
  runDiscussRound({
    topics,
    state: state || emptyDiscussState(),
    opts: Object.assign({}, baseOpts, opts || {}),
    io,
    askUser,
    shouldStop: () => false,
    log: () => {},
    onItem: () => {},
  });

console.log("\n[8] 一轮执行");
{
  // 6.1 已回复过的话题直接跳过
  const { io, calls } = makeIo({ topics: [] });
  const state = emptyDiscussState();
  recordReply(state, { uuid: U1, title: "已发", chars: 100, result: "ok", at: Date.now() });
  const s1 = await runRound({ topics: [makeTopic(U1, "已回复过")], state, io });
  ok(calls.compose === 0 && calls.post === 0, "已回复过的话题不生成也不发");
  ok(s1.skipped === 1, "记为跳过 1 条");

  // 6.2 今日上限
  const io2 = makeIo();
  const st2 = emptyDiscussState();
  recordReply(st2, { uuid: U2, title: "今天的", chars: 100, result: "ok", at: Date.now() });
  const s2 = await runRound({ topics: [makeTopic(U3, "下一条")], state: st2, io: io2.io, opts: { dailyLimit: 1 } });
  ok(io2.calls.compose === 0 && io2.calls.post === 0, "到今日上限不生成也不发");
  ok(s2.stopped && /每天上限/.test(s2.reason), "到今日上限自动停并说明原因");

  // 6.3 目标总条数
  const io3 = makeIo();
  const st3 = emptyDiscussState();
  recordReply(st3, { uuid: U1, title: "老的", chars: 100, result: "ok", at: Date.now() - 3 * 24 * 3600 * 1000 });
  const s3 = await runRound({ topics: [makeTopic(U2, "下一条")], state: st3, io: io3.io, opts: { targetTotal: 1, dailyLimit: 99 } });
  ok(io3.calls.post === 0 && s3.stopped && /总条数/.test(s3.reason), "到目标总条数自动停");

  // 6.4 逐条确认: 没点「发送」之前不许发
  const io4 = makeIo();
  let release = null;
  let asked = 0;
  const askUser = (draft) => {
    asked += 1;
    io4.calls.askedDraft = draft;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const p4 = runRound({ topics: [makeTopic(U1, "确认模式")], state: emptyDiscussState(), io: io4.io, opts: { auto: false }, askUser });
  await new Promise((r) => setTimeout(r, 10));
  ok(asked === 1, "逐条确认模式会停下来问一次");
  ok(io4.calls.post === 0, "用户没点「发送」之前绝不发");
  ok(io4.calls.askedDraft && io4.calls.askedDraft.chars >= 80, "草稿里带上了字数");
  release("send");
  const s4 = await p4;
  ok(io4.calls.post === 1 && s4.sent === 1, "点「发送」后才真的发出去");

  // 6.5 逐条确认: 点「跳过」不发, 并进跳过表
  const io5 = makeIo();
  const st5 = emptyDiscussState();
  const s5 = await runRound({ topics: [makeTopic(U2, "跳过我")], state: st5, io: io5.io, opts: { auto: false }, askUser: async () => "skip" });
  ok(io5.calls.post === 0 && s5.skipped === 1, "点「跳过」不发");
  ok(st5.skipped.indexOf(U2) !== -1, "跳过的话题记进跳过表(下次不再问)");

  // 6.6 连续 3 条失败自动停
  const io6 = makeIo({ failPost: true });
  const topics6 = [U1, U2, U3].map((u, i) => makeTopic(u, `失败${i}`));
  const s6 = await runRound({ topics: topics6, state: emptyDiscussState(), io: io6.io, opts: { dailyLimit: 99, targetTotal: 99 } });
  ok(io6.calls.post === 3, "连续 3 条失败后不再尝试第 4 条");
  ok(s6.stopped && /连续 3 条失败/.test(s6.reason), "连败 3 次自动停并说明原因");
  ok(io6.calls.saved >= 3, "每条失败都落了账");

  // 6.7 生成不合格: 重生成一次, 仍不合格就跳过, 不发
  const io7 = makeIo({ composeText: "太短" });
  const s7 = await runRound({ topics: [makeTopic(U1, "写不出来")], state: emptyDiscussState(), io: io7.io });
  ok(io7.calls.compose === 2, "不合格会重生成一次(共 2 次)");
  ok(io7.calls.post === 0 && s7.invalid === 1, "两次都不合格 → 不发, 记「生成不合格」");

  // 6.8 成功路径: 发出去 → 楼层确认 → 记账
  const io8 = makeIo();
  const st8 = emptyDiscussState();
  const saved = [];
  io8.io.saveState = async (s) => saved.push(JSON.parse(JSON.stringify(s.records)));
  const s8 = await runRound({ topics: [makeTopic(U1, "正常一条")], state: st8, io: io8.io });
  ok(io8.calls.post === 1 && s8.sent === 1, "正常一条发成功");
  ok(saved.length === 1 && saved[0][0].result === "ok", "成功那条记成 ok");
  ok(discussCounts(st8, Date.now()).today === 1, "成功计入今日额度");

  // 6.9 已提交但 15s 没看到楼层 → 记失败
  const io9 = makeIo();
  io9.io.postReply = async () => ({ ok: true });
  io9.io.fetchReplies = async () => ["别人的楼层"];
  const s9 = await runRound({ topics: [makeTopic(U2, "没确认到")], state: emptyDiscussState(), io: io9.io });
  ok(s9.failed === 1 && s9.sent === 0, "提交成功但楼层里没出现 → 记失败");
  ok(io9.calls.sleeps.length >= 5, "确认阶段按 3s 轮询(共 5 次)");

  // 6.10 间隔随机在 [min,max] 内, 且只在两条之间等
  const io10 = makeIo();
  const topics10 = [makeTopic(U1, "a"), makeTopic(U2, "b")];
  await runRound({ topics: topics10, state: emptyDiscussState(), io: io10.io, opts: { intervalMinSec: 40, intervalMaxSec: 120 } });
  ok(io10.calls.sleeps.length === 1 && io10.calls.sleeps[0] === 40000, "两种子之间按间隔等待(min 端, random=0)");

  // 6.11 allowResendUuid: 已发过的话题强制再发
  const io11 = makeIo();
  const st11 = emptyDiscussState();
  recordReply(st11, { uuid: U1, title: "发过", chars: 100, result: "ok", at: Date.now() });
  const s11 = await runRound({ topics: [makeTopic(U1, "重发")], state: st11, io: io11.io, opts: { allowResendUuid: U1 } });
  ok(io11.calls.post === 1 && s11.sent === 1, "「重发」会绕过已回复跳过");

  // 6.12 手改草稿: 合格就用改后的, 不合格就不发
  const io12 = makeIo({ composeText: GOOD });
  let sentText = "";
  io12.io.compose = async () => GOOD;
  io12.io.postReply = async ({ text }) => {
    sentText = text;
    return { ok: true, confirmed: true };
  };
  const edited = GOOD.replace("机会成本只算", "这个题要抓住");
  await runRound({
    topics: [makeTopic(U1, "手改草稿")],
    state: emptyDiscussState(),
    io: io12.io,
    opts: { auto: false },
    askUser: async () => ({ action: "send", text: edited }),
  });
  ok(sentText === edited, "面板里改过的正文会原样发出去");

  const io13 = makeIo({ composeText: GOOD });
  io13.io.compose = async () => GOOD;
  const s13 = await runRound({
    topics: [makeTopic(U2, "手改坏了")],
    state: emptyDiscussState(),
    io: io13.io,
    opts: { auto: false },
    askUser: async () => ({ action: "send", text: "太短" }),
  });
  ok(io13.calls.post === 0 && s13.failed === 1, "手改后不合格不发, 记失败");

  // 6.13 批量模式: 接地不通过 → 重生成一次仍不过 → 不发, 记 failed(stage=grounding)
  const ioG = makeIo({ composeText: GOOD }); // GOOD 写的是机会成本, 跟「公共物品」话题不沾边
  const sG = await runRound({ topics: [makeTopic(U1, "公共物品与私人物品的区别")], state: emptyDiscussState(), io: ioG.io, opts: { batch: true } });
  ok(ioG.calls.compose === 2, "接地不过会重生成一次(共 2 次)");
  ok(ioG.calls.post === 0 && sG.failed === 1, "两次都不接地 → 不发送, 记 1 条失败");
  ok(sG.report.failed.length === 1 && sG.report.failed[0].stage === "grounding", "报告里 stage=grounding(待人工清单)");
  ok(sG.report.sent.length === 0, "接地失败不进 sent");

  // 6.14 批量模式: 接地通过 → 发出去, 报告记正文全文与命中的词
  const ioB = makeIo();
  const sB = await runRound({ topics: [makeTopic(U1, "机会成本只算最优替代")], state: emptyDiscussState(), io: ioB.io, opts: { batch: true } });
  ok(ioB.calls.post === 1 && sB.sent === 1, "接地通过 → 发送");
  ok(sB.report.sent.length === 1 && sB.report.sent[0].text === GOOD, "报告 sent 里记正文全文");
  ok(sB.report.sent[0].groundingHits.length > 0, "报告 sent 里记命中的接地词");

  // 6.15/6.16 批量模式: 到每日上限 / 目标总条数自动停
  const ioD = makeIo();
  const stD = emptyDiscussState();
  recordReply(stD, { uuid: U2, title: "今天的", chars: 100, result: "ok", at: Date.now() });
  const sD = await runRound({ topics: [makeTopic(U1, "机会成本"), makeTopic(U3, "边际效用")], state: stD, io: ioD.io, opts: { batch: true, dailyLimit: 1, targetTotal: 99 } });
  ok(ioD.calls.post === 0 && sD.stopped && /每天上限/.test(sD.reason), "批量模式到每日上限自动停");

  const ioT = makeIo();
  const stT = emptyDiscussState();
  recordReply(stT, { uuid: U1, title: "老的", chars: 100, result: "ok", at: Date.now() - 3 * 86400000 });
  const sT = await runRound({ topics: [makeTopic(U2, "机会成本"), makeTopic(U3, "边际效用")], state: stT, io: ioT.io, opts: { batch: true, targetTotal: 1, dailyLimit: 99 } });
  ok(ioT.calls.post === 0 && sT.stopped && /总条数/.test(sT.reason), "批量模式到目标总条数自动停");

  // 6.17 批量模式: 连续 3 条失败自动停
  const ioF = makeIo({ failPost: true });
  const sF = await runRound({ topics: [U1, U2, U3].map((u, i) => makeTopic(u, `机会成本测试${i}`)), state: emptyDiscussState(), io: ioF.io, opts: { batch: true, dailyLimit: 99, targetTotal: 99 } });
  ok(ioF.calls.post === 3 && sF.stopped && /连续 3 条失败/.test(sF.reason), "批量模式连败 3 次自动停");
  ok(sF.report.failed.length === 3 && sF.report.failed.every((f) => f.stage === "send"), "连败的 3 条都进报告 failed(stage=send)");

  // 6.18 批量模式: 间隔等待期间「停止」立即生效(切成小段轮询)
  const ioS = makeIo();
  let slept = 0;
  let stop = false;
  ioS.io.sleep = async (ms) => {
    slept += ms;
    if (slept >= 1000) stop = true;
  };
  const sS = await runDiscussRound({
    topics: [makeTopic(U1, "机会成本"), makeTopic(U2, "边际效用")],
    state: emptyDiscussState(),
    opts: Object.assign({}, baseOpts, { intervalMinSec: 40, intervalMaxSec: 40, batch: true, interruptibleWait: true }),
    io: ioS.io,
    shouldStop: () => stop,
    log: () => {},
    onItem: () => {},
  });
  ok(ioS.calls.post === 1, "停止生效后不再发下一条");
  ok(slept === 1000, `等待被切成 500ms 小段并提前退出(实睡 ${slept}ms, 而非 40000ms)`);
  ok(sS.stopped && /用户停止/.test(sS.reason), "等待期间停止 → 本轮标记为用户停止");

  // 6.19 批量模式: 报告 skipped 分类 + 导出不带凭据
  const ioSK = makeIo();
  const stSK = emptyDiscussState();
  recordReply(stSK, { uuid: U1, title: "已发", chars: 100, result: "ok", at: Date.now() });
  skipTopic(stSK, U2);
  const sSK = await runRound({ topics: [makeTopic(U1, "t1"), makeTopic(U2, "t2")], state: stSK, io: ioSK.io, opts: { batch: true } });
  ok(
    sSK.report.skipped.length === 2 && sSK.report.skipped[0].reason === "alreadyReplied" && sSK.report.skipped[1].reason === "userSkipped",
    "报告 skipped 分类: alreadyReplied / userSkipped"
  );
  ok(!/urlToken|visitorId|cookie/.test(reportToJson(sSK.report)), "一轮报告的导出 JSON 不含凭据字段");
}

/* ------------------------------------------------------------ 9. 默认值 */

console.log("\n[9] 默认参数");
{
  ok(DISCUSS_DEFAULTS.targetTotal === 75, "默认目标总条数 75");
  ok(DISCUSS_DEFAULTS.dailyLimit === 10, "默认每天上限 10");
  ok(DISCUSS_DEFAULTS.intervalMinSec === 40 && DISCUSS_DEFAULTS.intervalMaxSec === 120, "默认间隔 40-120s");
  ok(DISCUSS_DEFAULTS.minChars === 80 && DISCUSS_DEFAULTS.maxChars === 150, "默认字数 80-150");
  ok(!!DISCUSS_SEL.textarea && !!DISCUSS_SEL.submit, "回复框/发送按钮选择器都在");
}

/* --------------------------------------------- 10. UI 发帖: DOM 判定 */

/** 假 UI 页面: textarea + .addReply + body 文本 + execCommand(可注入行为) */
function makeUiDoc({ bodyText = "", onClick, exec } = {}) {
  const events = [];
  const body = { textContent: String(bodyText || "") };
  const ta = {
    value: "",
    disabled: false,
    focus() {},
    select() {},
    setSelectionRange() {},
    addEventListener() {},
    dispatchEvent(e) {
      events.push(String(e && e.type));
      return true;
    },
  };
  const btn = {
    disabled: false,
    addEventListener() {},
    dispatchEvent(e) {
      const type = String(e && e.type);
      events.push(`btn:${type}`);
      if (type === "click" && typeof onClick === "function") onClick({ doc });
      return true;
    },
  };
  const doc = {
    body,
    querySelector(sel) {
      if (sel === DISCUSS_SEL.textarea) return ta;
      if (sel === DISCUSS_SEL.submit) return btn;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    execCommand(cmd, ui, text) {
      if (cmd !== "insertText") return false;
      if (typeof exec === "function") {
        const keep = exec(ta, String(text || ""), doc);
        if (keep === false) return false;
      } else {
        ta.value = String(text || "");
      }
      return true;
    },
    _events: events,
    _ta: ta,
    _btn: btn,
  };
  return doc;
}

console.log("\n[10] UI 发帖: DOM 判定");
{
  const MY = "这些特征合起来会推出一个结果: 长期经济利润为零。厂商数量极多。";
  ok(docHasReply({ body: { textContent: MY } }, MY), "DOM 文本里有自己正文 → 算发出去了");
  ok(docHasReply({ body: { textContent: `${MY.slice(0, 8)}\n${MY.slice(8)}` } }, MY), "正文被换行劈开也认(去空白后比前 16 字)");
  ok(docHasReply({ body: { textContent: `<p>${MY.slice(0, 6)}<br>${MY.slice(6)}</p>` } }, MY), "正文被 <br>/标签劈开也认");
  ok(docHasReply({ body: { textContent: `a&amp;b &quot;引号&quot; 之后的正文片段继续写满十六个字` } }, `a&b "引号" 之后的正文片段`), "DOM 里的 HTML 实体解一次再比");
  ok(!docHasReply({ body: { textContent: "别人的回复" } }, MY), "DOM 里没有自己正文 → 不算");
  ok(!docHasReply({ body: { textContent: MY } }, "太短"), "正文过短(<6 字)一律不算命中(防误判)");
  ok(!docHasReply(null, MY), "没有 document 不算命中");

  ok(maxFloorNo("第1楼 楼主 第2楼 回复 第12楼 最后") === 12, "「第N楼」取最大值(1/2/12 → 12)");
  ok(maxFloorNo("第 7 楼: 带空格的楼层号") === 7, "楼层号中间有空格也认");
  ok(maxFloorNo("没有楼层标记") === 0, "没有楼层标记返回 0");
  ok(floorsIncreased(3, 4) === true, "楼层数 3 → 4 判增加");
  ok(floorsIncreased(4, 4) === false, "楼层数没变不算增加");
  ok(floorsIncreased(5, 4) === false, "楼层数变少不算增加");

  const V1 = judgePostConfirm({ domText: `第2楼 ${MY}`, floorsBefore: 1, floorsAfter: 2, text: MY });
  ok(V1.confirmed && V1.by === "text", "二选一: 正文出现 → 判成功(by=text)");
  const V2 = judgePostConfirm({ domText: "第2楼 别人的回复", floorsBefore: 1, floorsAfter: 2, text: MY });
  ok(V2.confirmed && V2.by === "floor", "二选一: 只有楼层数 +1 → 也判成功(by=floor)");
  const V3 = judgePostConfirm({ domText: "第1楼 别人的回复", floorsBefore: 1, floorsAfter: 1, text: MY });
  ok(!V3.confirmed && V3.by === "", "正文没出现、楼层没变 → 不算成功");

  ok(
    replysListUrl({ bbsid: BBS, uuid: U1, courseId: "100000005", classId: "100000003" }) ===
      `https://groupweb.chaoxing.com/course/topic/v3/bbs/${BBS}/${U1}/replysList?courseId=100000005&classId=100000003`,
    "详情页 URL 拼对(UI 通道拿它导航)"
  );
  ok(replysListUrl({ bbsid: BBS, uuid: U1 }) === `https://groupweb.chaoxing.com/course/topic/v3/bbs/${BBS}/${U1}/replysList`, "缺 courseId/classId 时不带空参数");

  ok(normalizePostMode(undefined) === "ui" && normalizePostMode("") === "ui", "通道默认 UI(空/未设置)");
  ok(normalizePostMode("API") === "api" && normalizePostMode(" api ") === "api", "显式 api 才走接口(大小写/空白都归一)");
  ok(normalizePostMode("bogus") === "ui", "拼错一律回 UI(最稳的那个)");
  ok(uiFailLabel("no-floor") === "没看到楼层" && uiFailLabel("bogus") === "bogus", "失败码翻译成人话, 认不出原样返回");
  ok(Object.keys(DISCUSS_UI_FAIL_LABELS).length === 6, "失败码 6 类都在");
  ok(DISCUSS_UI_TIMING.waitMs === 20000 && DISCUSS_UI_TIMING.confirmMs === 20000, "等输入框/等楼层各 20s");
}

/* ------------------------------------- 11. UI 发帖: 填字校验与提交 */

console.log("\n[11] UI 发帖: 填字校验与提交");
{
  const TXT = "机会成本只算放弃掉的最高价值那一项, 不把几项加起来。";
  const ta = { value: TXT };
  ok(fillMatches(ta, TXT), "读回一致 → 算填上了");
  ok(!fillMatches({ value: "?" + TXT.slice(1) }, TXT), "等长但首 8 字不一致 → 不算(防等长问号)");
  ok(!fillMatches({ value: TXT.slice(0, -1) }, TXT), "长度不一致 → 不算");

  const doc1 = makeUiDoc();
  const f1 = fillReplyBoxVerified(doc1, null, TXT);
  ok(f1.ok && f1.attempts === 1, "填字一次成功(读回长度 + 前 8 字一致)");
  ok(doc1._ta.value === TXT, "填完 textarea 里就是正文");

  let calls = 0;
  const doc2 = makeUiDoc({
    exec(t, text) {
      calls += 1;
      t.value = calls === 1 ? "" : text; // 第一次 insertText 没生效
    },
  });
  const f2 = fillReplyBoxVerified(doc2, null, TXT);
  ok(f2.ok && f2.attempts === 2, "读回不一致 → 重试一次后成功(attempts=2)");

  const doc3 = makeUiDoc({ exec(t) { t.value = ""; } });
  const f3 = fillReplyBoxVerified(doc3, null, TXT);
  ok(!f3.ok && f3.reason === "fill-failed", "两次都不一致 → 判「填字没生效」");
  ok(fillReplyBoxVerified({ querySelector: () => null }, null, TXT).reason === "no-textarea", "没有输入框 → no-textarea");

  const doc4 = makeUiDoc({ bodyText: "第1楼" });
  ok(dispatchReplyClick(doc4, null) === true, "三连派发返回成功");
  ok(doc4._events.join(",") === "btn:mousedown,btn:mouseup,btn:click", "依次派发 mousedown/mouseup/click(顺序不能乱)");
  ok(dispatchReplyClick({ querySelector: () => null }, null) === false, "没有发送按钮 → false");
  ok(execInsertText(makeUiDoc(), null, "x") === true, "execInsertText 走页面编辑器");
  ok(execInsertText({ querySelector: () => null }, null, "x") === false, "没有 execCommand 的环境返回 false(不炸)");

  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);

  // 成功: 正文出现在 DOM
  const MY = "长期经济利润为零的前提是自由进出与同质产品, 这三条一起才推得出来。";
  let docOk;
  docOk = makeUiDoc({
    bodyText: "第1楼 别人的回复",
    onClick: () => {
      docOk.body.textContent = `第2楼 ${MY}`;
    },
  });
  const rOk = await postReplyOnPage({ doc: docOk, win: null, text: MY, sleep, waitMs: 0, confirmMs: 2000, confirmPollMs: 2000 });
  ok(rOk.ok && rOk.by === "text", "postReplyOnPage: 正文出现 → 成功(by=text)");

  // 成功: 楼层数 +1(正文被图片/编辑器包住读不出)
  let docFloor;
  docFloor = makeUiDoc({
    bodyText: "第1楼 别人的回复",
    onClick: () => {
      docFloor.body.textContent = "第2楼 别人的回复";
    },
  });
  const rFloor = await postReplyOnPage({ doc: docFloor, win: null, text: MY, sleep, waitMs: 0, confirmMs: 2000, confirmPollMs: 2000 });
  ok(rFloor.ok && rFloor.by === "floor" && rFloor.floorsAfter === 2, "postReplyOnPage: 楼层数 +1 → 成功(by=floor)");

  // 失败: 没看到楼层
  const docNo = makeUiDoc({ bodyText: "第1楼 别人的回复" });
  const rNo = await postReplyOnPage({ doc: docNo, win: null, text: MY, sleep, waitMs: 0, confirmMs: 4000, confirmPollMs: 2000 });
  ok(!rNo.ok && rNo.reason === "no-floor", "postReplyOnPage: 20s 内没变化 → no-floor");
  ok(uiFailLabel(rNo.reason) === "没看到楼层", "失败码能翻译成「没看到楼层」");

  // 失败: 等不到输入框
  const rNoBox = await postReplyOnPage({
    doc: { body: { textContent: "" }, querySelector: () => null },
    win: null,
    text: MY,
    sleep,
    waitMs: 0,
    confirmMs: 0,
  });
  ok(!rNoBox.ok && rNoBox.reason === "no-textarea", "postReplyOnPage: 等不到输入框 → no-textarea");

  // 失败: 填字没生效(不点按钮)
  const docFill = makeUiDoc({ exec(t) { t.value = ""; } });
  const rFill = await postReplyOnPage({ doc: docFill, win: null, text: MY, sleep, waitMs: 0, confirmMs: 0 });
  ok(!rFill.ok && rFill.reason === "fill-failed" && !docFill._events.includes("btn:click"), "填字没生效就不点按钮(no-floor 不能被凑数)");
}

/* ------------------------------------------ 12. 跨页面续跑状态机 */

console.log("\n[12] 跨页面续跑状态机");
{
  const topics = [makeTopic(U1, "话题一"), makeTopic(U2, "话题二"), makeTopic(U3, "话题三")];
  const mkQueue = (extra = {}) =>
    createUiQueue({ courseId: "100000005", bbsid: BBS, target: 0, dailyLimit: 10, postMode: "ui", topics, startedAt: 1000, ...extra });

  const q = mkQueue();
  ok(q.status === "running" && q.cursor === 0 && q.postMode === "ui", "新队列: running, 游标 0, 通道 ui");
  ok(q.topics.length === 3, "队列收下 3 条话题");
  ok(createUiQueue({ topics: [makeTopic(U1, "a"), makeTopic(U1.toUpperCase(), "b")] }).topics.length === 1, "同 uuid(不分大小写)只留一条");
  ok(uiQueueStoreKey("c1", "b1") === "nca-discuss-uiq-c1-b1", "队列存储键按课程+圈子分开");

  const n1 = nextUiTopic(q);
  ok(n1.ok && n1.index === 0 && n1.topic.uuid === U1, "第一个该处理的是 U1");
  setUiQueuePending(q, { uuid: U1, title: "话题一", text: GOOD, chars: 119 });
  ok(q.pending && q.pending.uuid === U1, "生成好的正文挂在 pending 上(导航前落盘)");
  ok(findUiQueueTopic(q, U1) && findUiQueueTopic(q, U1).title === "话题一", "findUiQueueTopic 按 uuid 找到话题");

  resolveUiQueueTopic(q, { uuid: U1, title: "话题一", result: "ok", text: GOOD, chars: 119, by: "text" });
  ok(q.sent.length === 1 && q.cursor === 1, "发成功: 进 sent, 游标前移到 1");
  ok(q.pending === null, "结算后清掉 pending");
  ok(nextUiTopic(q).topic.uuid === U2, "下一条是 U2");

  // 已成功的话题即使游标被写回 0 也不重发
  q.cursor = 0;
  ok(nextUiTopic(q).topic.uuid === U2, "已成功的话题不重发(游标落后也兜得住)");
  q.cursor = 1;

  resolveUiQueueTopic(q, { uuid: U2, title: "话题二", result: "skip", reason: "userSkipped" });
  ok(q.skipped.length === 1 && q.consecutiveFails === 0, "跳过不算失败(连败不清零也不加一)");
  ok(q.cursor === 2, "跳过也推进游标");

  ok(q.status === "running", "还有一条没处理, 本轮继续");
  resolveUiQueueTopic(q, { uuid: U3, title: "话题三", result: "fail", reason: "没看到楼层", reasonCode: "no-floor" });
  ok(q.consecutiveFails === 1, "失败累加连败数");
  ok(q.status === "done" && /话题已跑完/.test(q.stopReason), "最后一条处理完 → 本轮 done");
  ok(!nextUiTopic(q).ok, "结束后没有下一条");

  // 连续 3 次失败自动停
  const q3 = mkQueue({ target: 99 });
  for (const t of topics) resolveUiQueueTopic(q3, { uuid: t.uuid, title: t.title, result: "fail", reason: "no-floor", reasonCode: "no-floor" });
  ok(q3.status === "stopped" && /连续 3 条失败/.test(q3.stopReason), "连续 3 次失败 → stopped(不多发第 4 条)");
  ok(!nextUiTopic(q3).ok, "停了就不再给下一条");

  // 达到目标数就停(剩下的话题不发)
  const qT = mkQueue({ target: 1 });
  resolveUiQueueTopic(qT, { uuid: U1, title: "话题一", result: "ok", text: GOOD });
  ok(qT.status === "done" && /已达目标 1 条/.test(qT.stopReason), "达到目标数 → done(即使队列里还有话题)");
  ok(!nextUiTopic(qT).ok, "到目标后不再给下一条");

  // 存 / 读
  const mem = {};
  const write = (k, v) => {
    mem[k] = JSON.stringify(v);
  };
  const read = (k, dflt) => (mem[k] ? JSON.parse(mem[k]) : dflt);
  const qSave = mkQueue({ target: 5 });
  setUiQueuePending(qSave, { uuid: U1, title: "话题一", text: GOOD, chars: 119 });
  resolveUiQueueTopic(qSave, { uuid: U1, title: "话题一", result: "ok", text: GOOD });
  saveUiQueue({ courseId: "100000005", bbsid: BBS, queue: qSave, write });
  const qLoad = loadUiQueue({ courseId: "100000005", bbsid: BBS, read });
  ok(qLoad && qLoad.cursor === 1 && qLoad.sent.length === 1 && qLoad.sent[0].text === GOOD, "队列存/读后游标与已发正文都在");
  ok(qLoad.target === 5 && qLoad.postMode === "ui", "目标数与通道也存下来了");
  ok(loadUiQueue({ courseId: "x", bbsid: "y", read }) === null, "换课程/圈子读不到别人的队列");
  ok(loadUiQueue({ courseId: "c", bbsid: "b", read: () => "垃圾" }) === null, "脏存储 → 当没有队列") ;
  clearUiQueue({ courseId: "100000005", bbsid: BBS, write });
  ok(loadUiQueue({ courseId: "100000005", bbsid: BBS, read }) === null, "clearUiQueue 清掉队列");

  // 陈旧判定: 页面关了很久不自动续跑
  ok(isUiQueueStale(mkQueue(), 1000 + DISCUSS_UI_STALE_MS - 1) === false, "30 分钟内动过 → 可续跑");
  ok(isUiQueueStale(mkQueue(), 1000 + DISCUSS_UI_STALE_MS + 1) === true, "超过 30 分钟 → 判陈旧(不自动续跑)");
  ok(DISCUSS_UI_QUEUE_MAX >= 100, "队列上限至少留 100 条");

  // 面板进度
  const qP = mkQueue();
  resolveUiQueueTopic(qP, { uuid: U1, result: "ok", text: GOOD });
  resolveUiQueueTopic(qP, { uuid: U2, result: "fail", reason: "没看到楼层", reasonCode: "no-floor" });
  const prog = uiQueueProgress(qP);
  ok(prog.done === 2 && prog.total === 3, "进度: 已处理 2/3");
  ok(prog.label === "第 3/3 条", "面板文案「第 N/M 条」");
  ok(uiQueueProgress(createUiQueue()).label === "没有话题", "空队列的进度文案不报错");

  // run 报告: postMode + 失败原因分类
  const qR = mkQueue({ target: 3 });
  setUiQueuePending(qR, { uuid: U1, title: "话题一", text: GOOD, chars: 119, groundingHits: ["机会成本"] });
  resolveUiQueueTopic(qR, { uuid: U1, title: "话题一", result: "ok", text: GOOD, chars: 119, groundingHits: ["机会成本"], by: "floor" });
  resolveUiQueueTopic(qR, { uuid: U2, title: "话题二", result: "fail", reason: "没看到楼层", reasonCode: "no-floor", chars: 100 });
  resolveUiQueueTopic(qR, { uuid: U3, title: "话题三", result: "fail", reason: "两次生成都不合格", reasonCode: "compose" });
  const rep = uiQueueToReport(qR, 5000);
  ok(rep.postMode === "ui", "run 报告记 postMode=ui");
  ok(rep.sent.length === 1 && rep.sent[0].text === GOOD, "报告 sent 带正文全文");
  ok(rep.sent[0].by === "floor", "报告记确认依据(floor/text)");
  ok(rep.failed.length === 2 && rep.failed[0].stage === "send" && rep.failed[0].reasonCode === "no-floor", "发帖失败: stage=send, 原因码 no-floor");
  ok(rep.failed[1].stage === "compose", "生成失败归类到 compose(不是 send)");
  ok(rep.endedAt === 5000 && rep.target === 3, "报告带结束时间与目标数");
  ok(!/urlToken|cookie/i.test(reportToJson(rep)), "队列导出的报告同样不带凭据");

  ok(createRunReport({}).postMode === "api", "API 通道的报告默认 postMode=api(老行为不变)");
  ok(createRunReport({ postMode: "ui" }).postMode === "ui", "显式传 ui 就记 ui");
  const rFail = createRunReport({});
  reportFailed(rFail, { topicUuid: U1, stage: "send", reason: "填字没生效", reasonCode: "fill-failed" });
  ok(rFail.failed[0].reasonCode === "fill-failed" && rFail.failed[0].stage === "send", "reportFailed 保留失败原因码");
}

console.log(`\n${fail ? "❌" : "✅"} 全部通过: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
