// 入口: 平台探测 → 挂载面板 → 按 URL 分流到两条互不干扰的链路:
//   · 答题(半自动, 默认): 解析 → 取答案 → 填入, 由面板按钮逐步推进(人工把关; 可选"全自动"开关)
//   · 刷课(全自动): 章节页点「开始刷课」→ 无人值守播完未完成视频任务点
// 依赖注入: 默认 PiBridgeProvider; 可换其他 AnswerProvider。
import { PiBridgeProvider } from "./core/provider.js";
import { createAdapterForUrl } from "./adapters/index.js";
import { CxAdapter } from "./adapters/cx.js";
import { findWorkFrame, contentFrameState } from "./adapters/work-frame.js";
import { findQuestionDoc, collectDocs } from "./contract/cx-study-contract.js";
import { createCxCourseController, isNewCoursePage, startFromNewCoursePage, consumeAutostart } from "./adapters/cx-course.js";
import { createZhsCourseRelay, isZhsRelayActive } from "./adapters/zhs-course.js";
import { zhsReviewTestSignature } from "./adapters/zhs-review.js";
import { runAnswer, parseAll, askOne, fillOne } from "./core/runner.js";
import { parseQuestionList, runTutorRound } from "./core/ai-tutor.js";
import { createCancelToken } from "./core/cancel.js";
import { Panel } from "./ui/panel.js";
import { mountHarvestBar } from "./ui/harvest.js";
import { gmFetchJson, gmFetchText, readSetting, writeSetting, sleepMs } from "./vendor/gm.js";
import {
  parseDiscussContext,
  extractBbsid,
  parseTopicListHtml,
  collectTopicsFromDoc,
  extractUrlToken,
  extractTopicBody,
  collectReplyTexts,
  runDiscussRound,
  loadDiscussState,
  persistDiscussState,
  discussCounts,
  checkComposeText,
  normalizeComposeText,
  saveRunReport,
  reportToJson,
  sampleSentForReview,
  formatSamplesForReview,
  normalizePostMode,
  replysListUrl,
  postReplyOnPage,
  uiFailLabel,
  createUiQueue,
  loadUiQueue,
  saveUiQueue,
  setUiQueuePending,
  nextUiTopic,
  resolveUiQueueTopic,
  isUiQueueStale,
  uiQueueProgress,
  uiQueueToReport,
  hasRepliedTopic,
  hasSkippedTopic,
  canSend,
  recordReply,
  skipTopic,
  pickGroundingTerms,
  checkGrounding,
} from "./core/discuss.js";
import { prefetchTable, getTableState, getLastError } from "./core/font-decrypt.js";
import {
  readQuestion,
  parseJudge,
  pickJudgeText,
  normalizeAnswer,
  createPracticeReport,
  reportAnswer,
  reportSkip,
  reportFail,
  practiceStats,
  practiceReportToJson,
  samplePracticeForReview,
  formatPracticeSamples,
} from "./core/practice.js";

// ---- 全局单例(供面板复用) ----
let currentRoute = null;
let provider = null;
let panel = null;
let handler = null; // 当前答题页适配器
let pageWin = null; // 当前页面顶层窗口(startAnswering 里记下, 内嵌帧扫描要用)
let answerState = { questions: [], asked: 0, filled: 0 };

/* ------------------------------------------------------------------ *
 * 答题链的刹车
 * 一轮答题持一个取消令牌: 面板「停止」与「取消勾选全自动」都只 request 当前这轮。
 * 停止语义: 当前这一题之后不再继续 —— 已经在问桥的那题拿到答案也不回填, 也不兜底提交。
 * ------------------------------------------------------------------ */
let answerRun = createCancelToken();

function startAnswerRun() {
  if (answerRun.running) answerRun.request(); // 上一轮让位(它自己的循环会退出)
  answerRun = createCancelToken();
  answerRun.begin();
  if (panel) panel.setAnswerRunning(true);
  return answerRun;
}

function finishAnswerRun(run) {
  if (!run) return;
  run.done();
  if (run === answerRun && panel) panel.setAnswerRunning(false);
}

/** 停止当前这一轮答题(不提交、不再往下走) */
function stopAnswerRun(reason) {
  if (!answerRun.running || answerRun.stopped) return false;
  answerRun.request();
  plog(reason || "已停止答题: 当前这一题之后不再继续, 也不会自动提交", "warning");
  if (panel) {
    panel.setAnswerRunning(false);
    panel.setAutoAnswer(false); // 勾选框跟着回到"关", 免得下次打开页面又自己跑
  }
  return true;
}

/** 面板日志(带兜底) */
const plog = (msg, type) => panel && panel.log(msg, type);

/** 探活答题桥; 返回是否可用 */
async function ensureBridge(log) {
  if (!provider || typeof provider.health !== "function") return true;
  const up = await provider.health();
  if (panel && panel.setBridge) panel.setBridge(up);
  if (!up) {
    log("⚠ 答题桥没启动(127.0.0.1:30142 无响应): 双击「网课答题助手\\启动答题桥.cmd」, 然后点「① 解析题目」重来一遍", "danger");
    return false;
  }
  log("答题桥已连接(127.0.0.1:30142)", "success");
  return true;
}

/** 确保字形表就绪(题面字体加密场景) */
async function ensureTable(log) {
  if (getTableState() === "ready") return true;
  log("正在准备超星字形表…", "primary");
  const okTable = await prefetchTable();
  log(okTable ? "字形表就绪" : `字形表不可用: ${getLastError()}(题面可能乱码)`, okTable ? "primary" : "danger");
  return okTable;
}

/* ================================================================== *
 * 链路 A: 答题(半自动)
 * ================================================================== */

/** 没有答题页时点 ①②③ 该说的话 */
const NO_HANDLER_MSG = "当前页面不支持答题: 没找到答题页(顶层不是作业页, 页面内也没有内嵌的 doHomeWorkNew)";
/** 正文帧还没加载出来时的提示(可照着做, 不提内部术语) */
const NOT_READY_MSG = "页面正文还没加载完(内容帧是空的)，刷新一下这个页面再试";

/** 以前 handler 为空就静默 return, 用户点了像没点 → 现在一律打一条明确警告 */
function warnNoHandler() {
  // 章节页要分两级: 正文帧空了是「没加载完」(等一等/刷新就行), 正文帧出来了才是「这页确实没作业」
  if (currentRoute && currentRoute.workType === "chapter") {
    const st = contentFrameState(pageWin);
    if (st.found && !st.ready) {
      plog(NOT_READY_MSG, "warning");
      return;
    }
  }
  plog(NO_HANDLER_MSG, "warning");
}

/* ---- 章节页内嵌作业: 找那个帧并接管 ---- */

/** 帧常常是切内容块后才插进来的(还会晚几秒) → 有限次轮询, 找到就停; 不做永久 setInterval */
const EMBED_WORK_POLL = { tries: 10, intervalMs: 1500 };

/**
 * 扫一次内嵌答题帧(同步, 只扫不等): 找到就用它接管答题链。
 * 解析/填题/提交的 document 与 window 必须成对换成这一帧的;
 * 字体 @font-face 可能注入在帧外面的章节页上 → 把顶层当字体来源交过去。
 * @returns {object|null} 接管后的 handler
 */
function tryAttachEmbeddedWork(log) {
  if (handler) return handler;
  const topWin = pageWin || (typeof window !== "undefined" ? window : null);
  if (!topWin) return null;
  let hit = null;
  try {
    hit = findWorkFrame(topWin);
  } catch (e) {
    hit = null; // 同源策略挡住的帧一律当没看见
  }
  if (!hit) return null;
  // 接上了就别再让帧 load 的重试继续空转
  stopFrameLoadWatch();
  handler = new CxAdapter(hit.workType).setContext(hit.doc, hit.win, topWin);
  // 路由的 workType 跟着换成答题页的: 否则 autoSubmitIfWanted 会以为还在章节页
  // (交不交卷、考试页红线这两条判据都看 currentRoute.workType)
  if (currentRoute) currentRoute = Object.assign({}, currentRoute, { workType: hit.workType, embedded: true });
  const label = { zj: "doHomeWorkNew", zy: "dowork", ks: "exam-ans" }[hit.workType] || hit.workType;
  if (log) log(`作业在页面内嵌帧(第 ${hit.depth} 层 ${label})，已直接接管，不用跳页`, "success");
  return handler;
}

/** 章节页加载后: 等内嵌作业帧出现(最多 tries × intervalMs), 出现就接管 */
async function attachEmbeddedWork({ log, tries = EMBED_WORK_POLL.tries, intervalMs = EMBED_WORK_POLL.intervalMs } = {}) {
  for (let i = 0; i < tries; i++) {
    if (tryAttachEmbeddedWork(log)) return handler;
    if (i < tries - 1 && intervalMs > 0) await sleepMs(intervalMs);
  }
  return null;
}

/* ---- 帧 load 补重试(轮询窗口过了、帧晚加载时还能接上) ---- */

/**
 * 轮询只有 tries × 1.5s 的窗口, 站点晚一两分钟加载作业帧就永远错过了。
 * 这里在**顶层文档挂捕获阶段的 load 事件**(后插入的 iframe 也能覆盖到):
 * 每次有帧加载完就再跑一次 tryAttachEmbeddedWork。
 * 三条限制防止变高频空转: ① 同一波 load 合并成一次(300ms 去重);
 * ② 接管成功立刻摘监听; ③ 同一份文档只挂一次(用 WeakSet 记)。
 */
const FRAME_LOAD_DEBOUNCE_MS = 300;
const watchedDocs = new WeakSet();
let frameLoadTimer = null;
let frameLoadLog = () => {};

/** 装上帧 load 监听(章节页启动时调一次; 再调只补新文档、不重复挂) */
function watchFrameLoads(log) {
  if (typeof log === "function") frameLoadLog = log;
  watchFrameDocs();
}

function onFrameLoad() {
  if (handler) return; // 已接管: 不再跑
  if (frameLoadTimer) return; // 同一波 load 只跑一次
  frameLoadTimer = setTimeout(() => {
    frameLoadTimer = null;
    if (handler) return;
    watchFrameDocs(); // 新出现的帧文档也要挂上(嵌套帧的 load 事件在它自己的文档里)
    tryAttachEmbeddedWork(frameLoadLog);
  }, FRAME_LOAD_DEBOUNCE_MS);
}

/** 给当前帧树里每个文档挂上 load 监听(已挂过的跳过)。只读, 不点页面。 */
function watchFrameDocs() {
  const topWin = pageWin || (typeof window !== "undefined" ? window : null);
  if (!topWin) return;
  let docs = [];
  try {
    docs = collectDocs(topWin, 6);
  } catch (e) {
    return;
  }
  for (const d of docs) {
    const doc = d.doc;
    if (!doc || watchedDocs.has(doc) || typeof doc.addEventListener !== "function") continue;
    watchedDocs.add(doc);
    try {
      doc.addEventListener(
        "load",
        (ev) => {
          const tag = String((ev && ev.target && ev.target.tagName) || "").toLowerCase();
          if (tag && tag !== "iframe") return; // 只关心帧(图片等噪声不要)
          onFrameLoad();
        },
        true // 捕获阶段: 帧的 load 不冒泡, 只有捕获能拿到
      );
    } catch (e) {}
  }
}

/** 摘监听 —— 其实监听体里有 handler 短路, 但定时器要清(否则接管后会多跑一次) */
function stopFrameLoadWatch() {
  if (frameLoadTimer) {
    clearTimeout(frameLoadTimer);
    frameLoadTimer = null;
  }
}

/**
 * 面板接线: 三步按钮 + 逐题回调 + 全自动/停止。
 * 从 startAnswering 里拆出来, 是因为「页面不支持答题」的分支也要接上 ——
 * 以前那句分支直接 return, 面板上的 ①②③ 是空的, 用户点了没有任何反馈。
 */
function wireAnswerPanel() {
  if (!panel) return;
  panel.onParse = stepParse;
  panel.onAskAll = stepAskAll;
  panel.onFillAll = stepFillAll;
  panel.onAskOne = async (idx) => {
    const q = answerState.questions[idx];
    if (!q) return;
    if (!(await ensureBridge((m, t) => plog(m, t)))) return;
    const r = await askOne(provider, q);
    q.__ncaError = !r.ok;
    panel.renderQuestionItem(q, idx);
    plog(`第${idx + 1}题 ${r.ok ? "拿到答案: " + q.answer.join(" / ") : "失败: " + r.msg}`, r.ok ? "success" : "danger");
  };
  panel.onFillOne = async (idx) => {
    const q = answerState.questions[idx];
    if (!q || !q.answer || !q.answer.length) return;
    const r = await fillOne(handler, q);
    plog(`第${idx + 1}题 ${r.ok ? "已填入" : r.msg}`, r.ok ? "success" : "warning");
  };
  panel.resetQuestions();
  panel.log(
    `半自动模式: ①解析 → ②取答案 → ③填入, 随时可点「停止」; 当前自动提交: ${panel.getAutoSubmit() ? "开" : "关"}`,
    "primary"
  );
  // 「全自动答题」勾选框现在即时生效: 勾上立刻开跑, 取消立刻停(以前只在页面加载时看一眼)
  panel.onAutoAnswerChange = (on) => {
    if (on) {
      if (answerRun.running) stopAnswerRun("先停掉上一轮, 再开全自动");
      plog("「全自动答题」已勾上 → 立刻开跑(是否提交看「答完自动提交」)", "warning");
      runFullAuto().catch((e) => plog(`全自动答题异常: ${e && e.message}`, "danger"));
    } else {
      stopAnswerRun("「全自动答题」已取消 → 立即停止");
    }
  };
  panel.onStopAnswer = () => stopAnswerRun();
}

/** ① 解析: 只读抓题, 不点任何东西 */
async function stepParse() {
  if (practiceRun.running) {
    plog("AI陪练正在跑, 同一页面只允许一个操作者 —— 先停陪练再解析题目", "warning");
    return;
  }
  // 章节页的作业帧可能是刚点开的: 点一下①就再找一次(轮询窗口过了也不用重新加载页面)
  if (!handler && currentRoute && currentRoute.workType === "chapter") tryAttachEmbeddedWork((m, t) => plog(m, t));
  if (!handler) {
    warnNoHandler();
    return;
  }
  await ensureTable((m, t) => plog(m, t));
  panel.resetQuestions();
  const qs = parseAll(handler, { log: (m, t) => plog(m, t), onQuestion: () => {} });
  answerState = { questions: qs, asked: 0, filled: 0 };
  qs.forEach((q, i) => {
    q.__ncaIdx = i;
    panel.renderQuestionItem(q, i);
  });
  panel.setAnswerProgress(0, qs.length, qs.length ? `已解析 ${qs.length} 题, 待取答案` : "未解析到题目");
  plog(`解析完成: ${qs.length} 题(点「② 取答案」继续)`, qs.length ? "primary" : "danger");
}

/**
 * 复习测试页是「一题一 DOM」: 点答题卡换题后旧元素就失效了, 面板里的题目还指向旧的。
 * 轮询题目指纹, 一变就自动重新解析(只读抓题, 不点页面), 用户不用再点一次 ①。
 * 2026-11-09 真机反馈: 做完一题切到下一题, 面板还停在原来那题。
 */
const ZHS_REVIEW_WATCH_MS = 800;
function startZhsReviewTestWatcher({ win, log }) {
  if (!win || !win.document) return;
  if (win.__ncaZhsReviewWatch) {
    win.clearInterval(win.__ncaZhsReviewWatch);
    win.__ncaZhsReviewWatch = null;
  }
  const doc = win.document;
  let last = "";
  let busy = false;
  let timer = null;
  const tick = async () => {
    if (!win.location.pathname.startsWith("/studentReviewTestOrExam/")) {
      if (timer) win.clearInterval(timer);
      win.__ncaZhsReviewWatch = null;
      return;
    }
    if (busy || answerRun.running) return; // 正在问/填时不动, 免得抢页面
    const sig = zhsReviewTestSignature(doc);
    if (!sig || sig === last) return;
    last = sig;
    busy = true;
    try {
      log("检测到换题, 自动重新解析…", "primary");
      await stepParse();
    } catch (e) {
      log(`自动重新解析失败: ${e && e.message}`, "danger");
    } finally {
      busy = false;
    }
  };
  tick(); // 首次进页面也自动解析一次
  timer = win.setInterval(tick, ZHS_REVIEW_WATCH_MS);
  win.__ncaZhsReviewWatch = timer;
}

/** ② 取答案: 只问答题桥, 绝不碰页面 */
async function stepAskAll() {
  if (practiceRun.running) {
    plog("AI陪练正在跑, 先停陪练再取答案", "warning");
    return;
  }
  if (!handler) {
    warnNoHandler();
    return;
  }
  if (!answerState.questions.length) {
    plog("先点「① 解析题目」", "warning");
    return;
  }
  if (!(await ensureBridge((m, t) => plog(m, t)))) return;
  const run = startAnswerRun();
  const qs = answerState.questions;
  let last = 0;
  try {
    for (let i = 0; i < qs.length; i++) {
      if (run.stopped) break;
      const q = qs[i];
      if (q.answer && q.answer.length && !q.__ncaError) {
        continue; // 已有答案(手动改过/上次结果) → 不重复问
      }
      last = i + 1;
      const r = await askOne(provider, q);
      q.__ncaError = !r.ok;
      panel.renderQuestionItem(q, i);
      panel.setAnswerProgress(i + 1, qs.length, `取答案 ${i + 1}/${qs.length}`);
      plog(`第${i + 1}题 ${r.ok ? "拿到答案: " + q.answer.join(" / ") : "取答案失败: " + r.msg}`, r.ok ? "success" : "danger");
      if (i < qs.length - 1) await sleepMs(120);
    }
  } finally {
    finishAnswerRun(run);
  }
  if (run.stopped) {
    panel.setAnswerProgress(last, qs.length, `已停止(已问到第 ${last} 题)`);
    return;
  }
  answerState.asked = qs.filter((q) => q.answer && q.answer.length && !q.__ncaError).length;
  panel.setAnswerProgress(answerState.asked, qs.length, `已取答案 ${answerState.asked}/${qs.length}, 核对后点「③ 填入页面」`);
}

/** ③ 填入: 真正点页面选项(人工确认后) */
async function stepFillAll() {
  if (practiceRun.running) {
    plog("AI陪练正在跑, 先停陪练再填页面", "warning");
    return;
  }
  if (!handler) {
    warnNoHandler();
    return;
  }
  if (!answerState.questions.length) {
    plog("先解析并取答案", "warning");
    return;
  }
  const run = startAnswerRun();
  const qs = answerState.questions;
  let ok = 0;
  try {
    for (let i = 0; i < qs.length; i++) {
      if (run.stopped) break;
      const q = qs[i];
      if (!q.answer || !q.answer.length || q.__ncaError) {
        plog(`第${i + 1}题跳过(没有可用答案)`, "warning");
        continue;
      }
      const r = await fillOne(handler, q);
      if (r.ok) {
        ok++;
        plog(`第${i + 1}题已填入: ${q.answer.join(" / ")}`, "success");
      } else {
        plog(`第${i + 1}题${r.msg}`, "warning");
      }
      panel.renderQuestionItem(q, i);
      panel.setAnswerProgress(ok, qs.length, `已填入 ${ok}/${qs.length}`);
    }
  } finally {
    finishAnswerRun(run);
  }
  if (run.stopped) {
    panel.setAnswerProgress(ok, qs.length, `已停止(已填入 ${ok}/${qs.length})`);
    return; // 被停就不提交
  }
  plog(`填入完成: ${ok}/${qs.length}`, ok === qs.length ? "success" : "warning");
  await autoSubmitIfWanted(Math.round((ok / Math.max(1, qs.length)) * 100));
}

/**
 * 提交流程的公共部分(半自动填完 / 全自动跑完都走这里):
 *   考试页永不自动提交(红线) → 只对 zj/zy 且适配器实现了 autoSubmit → 看面板开关 → 低于阈值走页面暂存。
 * 以前这两处各写了一遍, 阈值/开关改动得改两地方。
 */
async function autoSubmitIfWanted(correctRate) {
  const wt = currentRoute && currentRoute.workType;
  if (wt === "ks") {
    plog("考试页: 不自动提交(红线) —— 请自己检查后手动交卷", "warning");
    return;
  }
  if (!(wt === "zj" || wt === "zy") || !handler || typeof handler.autoSubmit !== "function") return;
  if (panel && !panel.getAutoSubmit()) {
    plog("没开「答完自动提交」—— 答案已回填, 请手动提交", "primary");
    return;
  }
  const threshold = panel ? panel.getSubmitRate() : 85;
  plog(`尝试自动提交(正确率 ${correctRate}%, 阈值 ${threshold}%)…`, "primary");
  try {
    const r = await handler.autoSubmit({ log: (m, t) => plog(m, t), threshold, correctRate, saveDraftBelow: true });
    if (r && r.ok) plog("作业已提交 ✅", "success");
  } catch (e) {
    plog(`自动提交异常: ${e && e.message}`, "danger");
  }
}

/** 全自动模式(「全自动答题」勾选时跑; 勾选框是即时生效的, 取消勾选会打断它) */
async function runFullAuto() {
  if (!handler) {
    warnNoHandler();
    return;
  }
  if (practiceRun.running) {
    plog("AI陪练正在跑, 先停陪练再全自动答题", "warning");
    return;
  }
  const run = startAnswerRun();
  try {
    if (!(await ensureBridge((m, t) => plog(m, t)))) return;
    if (run.stopped) return;
    await ensureTable((m, t) => plog(m, t));
    panel.clearQuestions();
    answerState.questions = handler.questions || [];
    const correctRate = await runAnswer(handler, provider, {
      log: (m, t) => plog(m, t),
      shouldStop: () => run.stopped,
      onQuestion: (q) => {
        if (q.__ncaIdx == null) q.__ncaIdx = (answerState.questions.indexOf(q) + 1 || answerState.questions.length) - 1;
        panel.renderQuestionItem(q, q.__ncaIdx);
      },
    });
    answerState.filled = handler.correctNum || 0;
    panel.setAnswerProgress(answerState.filled, handler.questions.length, `本轮 ${correctRate}%`);
    if (run.stopped) {
      plog(`已停止: 本轮已回填 ${answerState.filled} 题, 未提交`, "warning");
      return;
    }
    plog(`本轮答题完成, 估算正确率 ${correctRate}%`, correctRate >= 85 ? "success" : "warning");
    await autoSubmitIfWanted(correctRate);
  } finally {
    finishAnswerRun(run);
  }
}

/**
 * 页面就绪后: 解析页面类型并接线(不自动答题 —— 半自动由按钮驱动)
 */
export async function startAnswering({ win = window, doc = document, log = () => {}, embedWork = {} } = {}) {
  if (doc.readyState !== "complete" && doc.readyState !== "interactive") {
    log("页面尚未就绪, 等待…", "warning");
  }
  await waitReady(doc, 15000);

  const url = win.location.href;
  const route = createAdapterForUrl(url);
  currentRoute = route;
  pageWin = win; // 内嵌作业帧只能从页面顶层往下扫

  if (!route) {
    log("当前页面不在支持列表, 仅展示面板", "primary");
    return;
  }

  // AI助教页: 一题一会话 + 自动评价(默认不自动开始, 面板点「开始」并确认后才跑)
  if (route.workType === "ai-tutor") {
    log("检测到「AI助教」页 —— 「AI助教」页签可一题一会话地提问, 并按字数自动赞/踩", "primary");
    setupAiTutor({ win, log });
    return;
  }

  // 讨论区页(列表页/详情页): 默认逐条确认, 面板点「开始」才跑
  if (route.workType === "discuss") {
    log("检测到超星讨论区 —— 「讨论区」页签可逐条生成回复(默认生成后停住, 你点「发送」才发)", "primary");
    setupDiscuss({ win, log, route }).catch((e) => log(`讨论区初始化失败: ${e && e.message}`, "danger"));
    return;
  }

  // AI陪练页(超星 qbank-ai/aiPracticeAssistant): 只挂陪练逻辑 —— 不把答题/刷课的自动流程带上来
  if (route.workType === "practice") {
    log("检测到超星「AI陪练」页 —— 「AI陪练」页签可自动作答并记判分(默认逐题确认)", "primary");
    setupPractice({ win, log });
    return;
  }

  // 章节页: 刷课链路(全自动, 点按钮触发) + 内嵌作业接管(两件事互不干扰)
  if (route.workType === "chapter") {
    log("检测到超星章节页 —— 「刷课」页签可全自动播完未完成视频任务点", "primary");
    setupCourse({ win, log, autoStart: consumeAutostart() });
    // 先把答题按钮接上: 就算没找到作业帧, 点 ①②③ 也要有话说(不静默)
    wireAnswerPanel();
    // 轮询只管开头那十几秒; 帧晚加载靠 load 事件补(接管成功后自己停)
    watchFrameLoads(log);
    await attachEmbeddedWork({ log, ...embedWork });
    if (handler && panel && panel.getAutoAnswer()) {
      log("「全自动答题」开着: 章节页不自动开跑(避开和刷课抢页面), 点「① 解析题目」或重新勾一次即可", "primary");
    }
    return;
  }

  // 智慧树新形态课程: 目录页/学习页 = 刷课中继; 课后复习列表页 = 刷题入口
  if (route.workType === "zhs-course") {
    log("检测到智慧树新形态课程页 —— 「刷课」页签可自动播完「课程视频」里未完成的知识点", "primary");
    setupZhsCourse({ win, log });
    return;
  }
  if (route.workType === "zhs-review-list") {
    log("智慧树「课后复习」列表页: 点开题目卡片会在新标签打开练习页, 到练习页用 ①解析 → ②取答案 → ③填入", "primary");
    return;
  }
  if (route.workType === "zhs-tasks") {
    log("智慧树「任务·作业·考试」页: 有作业/考试时点进去再用 ①解析 → ②取答案 → ③填入", "primary");
    return;
  }

  const h = route.makeHandler ? route.makeHandler() : null;
  if (!h) {
    log(`检测到 ${route.platform}/${route.workType} 页面; 该形态的答题编排待开发`, "warning");
    wireAnswerPanel(); // 按钮接上 → 点 ①②③ 会明白地警告, 而不是完全没反应
    return;
  }
  handler = h;

  log(`检测到 ${route.platform}/${route.workType} 答题页面(半自动模式)`, "primary");
  // 探活不阻塞接线: 桥没起时健康检查要等超时(后台标签还会被节流), 以前会把面板按钮卡成"点了没反应"。
  // 这里先接线, 探活结果异步回填 bridge 灯 + 日志。
  ensureBridge((m, t) => log(m, t)).catch(() => {});

  // 面板接线: 三步按钮 + 逐题回调
  wireAnswerPanel();

  // 复习测试页「一题一 DOM」: 换题后自动重新解析, 面板不能停在旧题上
  if (panel && route.zhsMode === "reviewTest") {
    startZhsReviewTestWatcher({ win, log });
  }

  // 上次勾了「全自动答题」→ 这次打开页面就接着跑(随时可停)
  if (panel && panel.getAutoAnswer()) {
    log("检测到「全自动答题」开关已开 → 直接跑完整流程(要停就点「停止」或取消勾选)", "warning");
    await runFullAuto();
  }
}

/** 章节页刷课: 把控制器挂到面板按钮上(全自动链路) */
let courseController = null;
/**
 * 刷课途中遇到「章节测验/作业」任务点(work 模块): 借答题链把它做掉。
 * 完成这类任务点只有一条路 —— 交卷; 所以只在面板「答完自动提交」开着、
 * 且估算正确率不低于阈值时才提交(autoSubmitWork 内部还会再判一次)。
 * 关着就只回填、如实说"任务点不会算完成", 不偷偷交。
 * @returns {Promise<{ok:boolean, note?:string, reason?:string}>}
 */
async function solveWorkTaskPoint(frameEl, { log = () => {}, shouldStop = () => false } = {}) {
  if (!frameEl) return { ok: false, reason: "没找到测验的 iframe" };
  // api/work 是 work/index.html 里再套一层的 iframe, 切块后要几秒才出题目
  let hit = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (shouldStop()) return { ok: false, reason: "已停止" };
    try {
      hit = findQuestionDoc(frameEl.contentWindow);
    } catch (e) {
      hit = null;
    }
    if (hit && hit.count) break;
    hit = null;
    await sleepMs(500);
  }
  if (!hit) return { ok: false, reason: "测验页 20s 内没加载出题目(可能还没开放/需要先看视频)" };
  const adapter = new CxAdapter("zj", frameEl);
  if (!(await ensureBridge((m, t) => log(m, t)))) return { ok: false, reason: "pi 桥没起, 取不到答案" };
  // 超星题面常用 font-cxsecret 加密: 字形表没就绪时题干是乱码, 这时候答/交都等于瞎猜
  await ensureTable((m, t) => log(m, t));
  adapter.parseHtml();
  (adapter.notes || []).forEach((n) => log(`  ↳ ${n.msg}`, n.type || "primary"));
  const qs = adapter.questions || [];
  if (!qs.length) return { ok: false, reason: "没解析到题目" };
  const decryptFailed = (adapter.notes || []).some((n) => /解密失败/.test(n.msg || ""));
  if (decryptFailed) {
    // .font-cxsecret 也用在普通排版上(真机 1.3 牛刀小试: 英文题面也带这个类)。
    // 只有"解不开 + 留下的还是成片汉字(乱码)"才当真加密, 不能一律拒绝。
    let suspect = "";
    try {
      hit.doc.querySelectorAll(".font-cxsecret").forEach((el) => {
        suspect += el.textContent || "";
      });
    } catch (e) {}
    const cjk = (suspect.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (suspect.match(/[A-Za-z]/g) || []).length;
    if (cjk > latin && cjk > 0) {
      return { ok: false, reason: "题面加密没解开(字形表不可用), 不瞎答也不交卷" };
    }
    log("  ↳ 题面带 font-cxsecret 但没解开; 这段是明文(英文/数字), 照常作答", "primary");
  }
  log(`  ↳ 章节测验/作业: 解析到 ${qs.length} 题, 开始逐题取答案`, "primary");
  log(`  ↳ 题型: ${qs.map((q) => `${q.type}${q.optionsText && q.optionsText.length ? `(${q.optionsText.length}项)` : ""}`).join(" / ")}`, "primary");
  const rate = await runAnswer(adapter, provider, {
    log,
    shouldStop,
    onQuestion: (q) => {
      const i = adapter.questions.indexOf(q);
      log(`  ↳ 第 ${i + 1}/${qs.length} 题已作答`);
    },
  });
  if (shouldStop()) return { ok: false, reason: "已停止(答案不回填不交卷)" };
  const filled = adapter.correctNum || 0;
  const auto = panel ? panel.getAutoSubmit() : true;
  const threshold = panel ? panel.getSubmitRate() : 85;
  if (!auto) return { ok: false, reason: `已填 ${filled}/${qs.length} 题, 但「答完自动提交」没开, 不交卷 → 任务点不会算完成` };
  if (rate < threshold) return { ok: false, reason: `估算正确率 ${rate}% < 阈值 ${threshold}%, 不交卷` };
  const r = await adapter.autoSubmit({ log: (m, t) => log(m, t), threshold, correctRate: rate, saveDraftBelow: true });
  if (r && r.ok) return { ok: true, note: `测验 ${qs.length} 题已交, 估算正确率 ${rate}%` };
  // unverified = 提交动作发出去了, 只是页面没出现「已完成/待批阅」。
  // 章节测验交卷一多就整页跳走, 页面上根本看不到结果 —— 交给调用方按任务点图标复核
  if (r && r.reason === "unverified") {
    return { ok: false, submitted: true, reason: "已交卷, 但页面上没看到结果; 以任务点图标为准" };
  }
  return { ok: false, reason: `交卷没成功(${(r && r.reason) || "未知原因"})` };
}

/* ================================================================== *
 * 链路 C: AI助教(一题一会话 + 自动评价)
 * ================================================================== */

/** AI助教本轮取消令牌(与答题/刷课的令牌互不干扰) */
let tutorRun = createCancelToken();

/**
 * 把「AI助教」页签接到执行器上。
 * 默认不自动开始: 点「开始」先弹一次确认(会说清楚发几条、每题新建会话), 中途可「停止」。
 * 停止语义: 不再发下一题; 正在等回复的那题直接放弃(不等完、不评价) —— 已发出的提问留在平台历史里。
 */
function setupAiTutor({ win, log }) {
  if (!panel) return;
  const doc = win && win.document;
  const say = (m, t) => log(m, t);

  panel.onTutorPreview = () => {
    const cfg = panel.getTutorConfig();
    const list = parseQuestionList(cfg.list);
    panel.resetTutorItems(list);
    if (!list.length) {
      say("问题清单为空: 一行一题, 先填进去再预览", "warning");
      return;
    }
    panel.setTutorProgress(0, list.length, `预览: 将连续发送 ${list.length} 条(未发送)`);
    say(`预览: ${list.length} 条; 每题新建会话, 回复少于 ${cfg.minChars} 字判踩、否则赞(还没发送)`, "primary");
  };

  panel.onTutorStart = async () => {
    if (tutorRun.running) {
      say("AI助教还在跑: 先点「停止」再开新一轮", "warning");
      return;
    }
    const cfg = panel.getTutorConfig();
    const list = parseQuestionList(cfg.list);
    if (!list.length) {
      say("问题清单为空: 一行一题, 先填进去", "warning");
      return;
    }
    const prompt =
      `将连续发送 ${list.length} 条问题, 每题新建会话。\n` +
      `判分: 回复少于 ${cfg.minChars} 字 → 踩, 否则赞。\n` +
      `中途可点「停止」: 停止后不再发下一题, 正在等回复的那题直接放弃(不评价)。\n\n继续?`;
    let proceed = true;
    try {
      if (win && typeof win.confirm === "function") proceed = win.confirm(prompt);
    } catch (e) {
      proceed = true;
    }
    if (!proceed) {
      say("已取消: 没发任何问题", "primary");
      return;
    }

    tutorRun = createCancelToken();
    tutorRun.begin();
    panel.setTutorRunning(true);
    panel.resetTutorItems(list);
    panel.setTutorProgress(0, list.length, `开始: 0/${list.length}`);
    let stats = null;
    try {
      stats = await runTutorRound({
        doc,
        win,
        items: list,
        opts: { praise: cfg.praise, criticize: cfg.criticize, minChars: cfg.minChars },
        log: (m, t) => say(m, t),
        onItem: (i, st, extra) => {
          panel.renderTutorItem(i, st, extra || {});
          if (st === "已评价" || st === "失败") panel.setTutorProgress(i + 1, list.length, `${i + 1}/${list.length} ${st}`);
          else if (st === "已提问") panel.setTutorProgress(i, list.length, `第 ${i + 1}/${list.length} 题已发, 等回复`);
        },
        shouldStop: () => tutorRun.stopped,
      });
    } catch (e) {
      say(`AI助教异常中止: ${e && e.message}`, "danger");
    } finally {
      tutorRun.done();
      panel.setTutorRunning(false);
    }
    if (!stats) return;
    const tail = stats.stopped ? "(已停止)" : "";
    panel.setTutorProgress(stats.rated, stats.total, `本轮${tail}: 发出 ${stats.asked} / 回复 ${stats.replied} / 评价 ${stats.rated}`);
    say(
      `本轮结束${tail}: 共 ${stats.total} 题, 发出 ${stats.asked}, 收到回复 ${stats.replied}, 评价 ${stats.rated}(赞 ${stats.zan} / 踩 ${stats.cai}), 失败 ${stats.failed}`,
      stats.failed ? "warning" : "success"
    );
  };

  panel.onTutorStop = () => {
    if (!tutorRun.running || tutorRun.stopped) return false;
    tutorRun.request();
    say("已停止: 不再发下一题, 正在等回复的那题直接放弃(不评价)", "warning");
    return true;
  };
}

// ---------------------------------------------------------------- 讨论区

let discussRun = createCancelToken();
// 逐条确认模式下, 生成完的草稿在等面板点「发送/跳过」 —— 这里存着那个 resolve
let discussPendingAsk = null;
let discussStateRef = { courseId: "", classId: "", bbsid: "" };
// 最近一轮的 run 报告(导出/抽样都读它; 不落盘也能用)
let discussLastReport = null;

/** 回复 uuid(发帖字段 uuid 是本条回复自己的随机 id, 不是话题 uuid) */
function makeReplyUuid() {
  try {
    const c = typeof crypto !== "undefined" ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  } catch (e) {
    /* 落到下面 */
  }
  let s = "";
  for (let i = 0; i < 32; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

/** 从 URL / 页面 / referrer 里凑出 courseId、classId、cpi、bbsid */
function readDiscussParams(win, ctx) {
  const out = { courseId: "", classId: "", cpi: "", bbsid: "", mode: "list", topicUuid: "" };
  if (ctx) Object.assign(out, ctx);
  const sources = [];
  try {
    sources.push(String(win.location.href || ""));
    sources.push(String(win.document.referrer || ""));
  } catch (e) {
    /* ignore */
  }
  for (const url of sources) {
    let q = null;
    try {
      q = new URL(url).searchParams;
    } catch (e) {
      continue;
    }
    if (!out.courseId) out.courseId = String(q.get("courseId") || "");
    if (!out.classId) out.classId = String(q.get("classId") || q.get("clazzId") || "");
    if (!out.cpi) out.cpi = String(q.get("cpi") || "");
    if (!out.bbsid) out.bbsid = String(q.get("bbsid") || "");
  }
  return out;
}

/** 缺 bbsid 时调这个接口拿(nav 配置里 linkUrl 带 bbsid), 拿不到返回 "" */
async function fetchDiscussBbsid({ courseId, classId, cpi }) {
  const qs = `courseId=${encodeURIComponent(courseId)}&clazzId=${encodeURIComponent(classId)}&cpi=${encodeURIComponent(cpi)}&navId=-1&pageHeader=-1`;
  const url = `https://mooc2-ans.chaoxing.com/mooc2-ans/coursemanagev3/stu-base-info?${qs}`;
  try {
    const text = await gmFetchText(url, { timeout: 20000 });
    return extractBbsid(text);
  } catch (e) {
    return "";
  }
}

/** 把面板上的草稿确认解析掉(发送/跳过/停止) */
function answerDiscussAsk(action, text) {
  const pending = discussPendingAsk;
  if (!pending) return false;
  discussPendingAsk = null;
  if (panel) panel.clearDiscussDraft();
  pending.resolve(text ? { action, text } : action);
  return true;
}

/**
 * 一轮结束: 留住本轮报告(面板「导出报告」/「抽样」读它) 并存进 GM(只留最近 5 轮)。
 * 报告只带话题/正文/计数 —— 不含 cookie / urlToken / visitorId。
 */
function finishDiscussReport(stats, { courseId, bbsid }, log) {
  const report = stats && stats.report;
  if (!report) return null;
  discussLastReport = report;
  try {
    saveRunReport({ courseId, bbsid, report, read: readSetting, write: writeSetting });
  } catch (e) {
    /* 存报告失败不影响本轮结论 */
  }
  const pending = report.failed.filter((f) => f.stage === "grounding").length;
  const say = typeof log === "function" ? log : () => {};
  say(
    `run 报告已存(最近 5 轮): 发出 ${report.sent.length} / 失败 ${report.failed.length}(接地待人工 ${pending}) / 跳过 ${report.skipped.length}` +
      (pending ? " —— 点「导出报告」复制给 agent 处理" : ""),
    pending ? "warning" : "primary"
  );
  return report;
}

/**
 * 把「讨论区」页签接到执行器上。
 * 默认不自动开跑; 默认逐条确认(生成完停住, 人点「发送」才发)。
 * 统计口径: 只存成功的; 额度看成功条数(失败/跳过不占额度)。
 */
async function setupDiscuss({ win, log, route }) {
  if (!panel) return;
  const doc = win && win.document;
  const say = (m, t) => log(m, t);
  const ctx = (route && route.discuss) || parseDiscussContext(win.location.href);
  const p = readDiscussParams(win, ctx);
  let { courseId, classId, bbsid } = p;

  if (!bbsid) {
    if (!courseId || !classId) {
      panel.setDiscussStatus(`缺 bbsid, 且 URL 里也没有 courseId/classId(当前: courseId=${courseId || "—"}, classId=${classId || "—"}) —— 先打开该课程讨论区列表页再试`, true);
      say("讨论区: 没有 bbsid, 也凑不出 courseId/classId, 没法取圈子 id", "danger");
      return;
    }
    panel.setDiscussStatus(`缺 bbsid, 正在用 stu-base-info 取…(courseId=${courseId} classId=${classId})`);
    bbsid = await fetchDiscussBbsid({ courseId, classId, cpi: p.cpi });
    if (!bbsid) {
      panel.setDiscussStatus(`stu-base-info 没取到 bbsid(courseId=${courseId} classId=${classId} cpi=${p.cpi || "—"}) —— 先在浏览器里打开一次课程讨论区`, true);
      say("讨论区: stu-base-info 没取到 bbsid, 不静默继续 —— 请先手动打开一次讨论区", "danger");
      return;
    }
  }

  panel.setDiscussStatus(`bbsid ${bbsid} · courseId ${courseId || "—"} · classId ${classId || "—"}`);
  discussStateRef = { courseId, classId, bbsid };

  let state = loadDiscussState({ courseId, bbsid, read: readSetting });
  const refreshCounts = () => {
    const c = discussCounts(state, Date.now());
    panel.setDiscussCounts(c.today, c.total);
    return c;
  };
  refreshCounts();
  say(`讨论区已就绪: bbsid ${bbsid}; 今日已发 ${discussCounts(state, Date.now()).today} / 累计 ${discussCounts(state, Date.now()).total}`, "primary");

  const origin = "https://groupweb.chaoxing.com";
  const withIds = (extra) =>
    `courseId=${encodeURIComponent(courseId)}&classId=${encodeURIComponent(classId)}${extra || ""}`;

  // 话题列表: 同页是列表页就读 DOM, 否则拉一次列表页 HTML 解析
  const listTopics = async () => {
    try {
      const fromDom = collectTopicsFromDoc(doc, bbsid);
      if (fromDom.length) return fromDom;
    } catch (e) {
      /* ignore */
    }
    const html = await gmFetchText(`${origin}/pc/topic/topiclist/index?bbsid=${encodeURIComponent(bbsid)}&${withIds()}`, {
      timeout: 25000,
    });
    const topics = parseTopicListHtml(html, bbsid);
    if (!topics.length) say("列表页里没解析到话题(页面结构可能变了); 确认这个 bbsid 下有帖子", "warning");
    return topics;
  };

  const fetchTopic = async ({ uuid, title }) => {
    const url = `${origin}/course/topic/v3/bbs/${bbsid}/${uuid}/replysList?${withIds()}`;
    let html = "";
    try {
      html = await gmFetchText(url, { timeout: 25000 });
    } catch (e) {
      html = "";
    }
    let token = extractUrlToken(html);
    if (!token) {
      // 万一就在这一页: 页面里渲染过 window.obj.urlToken
      try {
        token = String((win.obj && win.obj.urlToken) || "");
      } catch (e) {
        token = "";
      }
    }
    const body = extractTopicBody(html);
    if (!body) say(`话题「${String(title || uuid).slice(0, 16)}」正文没取到, 只用标题生成`, "warning");
    // 同时把整页 HTML 带出去: 发帖后的「楼层确认」靠它(见 discuss.js topicPageHasReply),
    // 因为 getReplyList 在真机上对已有回复的话题也可能返回 0 条, 不能当唯一判据。
    return { urlToken: token, body, title: String(title || ""), html };
  };

  const fetchReplies = async ({ uuid }) => {
    const qs = `bbsid=${encodeURIComponent(bbsid)}&uuid=${encodeURIComponent(uuid)}&tag=&order=2&lastValue=&lastAuxValue=`;
    let texts = [];
    try {
      texts = collectReplyTexts(await gmFetchJson(`${origin}/pc/invitation/getReplyList?${qs}`, { timeout: 20000 }));
    } catch (e) {
      texts = [];
    }
    if (!texts.length) {
      // 降级: 置顶回复列表 / 页面 DOM(排序会变, 但「别跟别人说一样的话」用得上)
      try {
        const qs2 = `bbsid=${encodeURIComponent(bbsid)}&uuid=${encodeURIComponent(uuid)}&order=2&tag=&kw=`;
        texts = collectReplyTexts(await gmFetchJson(`${origin}/pc/invitation/getTopReplyList?${qs2}`, { timeout: 20000 }));
      } catch (e) {
        texts = [];
      }
    }
    return texts;
  };

  const postReply = async ({ uuid, urlToken, text }) => {
    const body = new URLSearchParams({
      courseId,
      classId,
      replyId: "-1",
      uuid: makeReplyUuid(),
      topic_content: text,
      anonymous: "0",
      urlToken,
      bbsid,
    }).toString();
    // 同源 POST 一律先走 fetch: 带 cookie, 编码跟着页面走。
    // 2026-11-13 真机: 走 GM_xmlhttpRequest 时, 118 字的草稿在帖子里变成 118 个「?」——
    // 服务端一个字符都没认出来。同源页面没必要绕 GM, fetch 直接发反而干净。
    const postUrl = `${origin}/pc/invitation/${uuid}/addReplys`;
    const ctype = "application/x-www-form-urlencoded; charset=UTF-8";
    let raw = "";
    let via = "fetch";
    try {
      const resp = await fetch(postUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": ctype },
        body,
      });
      raw = await resp.text();
    } catch (e) {
      via = "gm";
      try {
        raw = await gmFetchText(postUrl, {
          method: "POST",
          headers: { "Content-Type": ctype },
          body,
          timeout: 25000,
        });
      } catch (e2) {
        return { ok: false, error: (e2 && e2.message) || "发送请求失败" };
      }
    }
    // 真机实测(2026-11-13): 成功返回 {"msg":"回复发表成功","datas":{...,"replyId":3831425327,...}}
    // 老正则只认 status:true / error:0 / \bsuccess\b / \bok\b —— 中文「成功」一个都匹配不上,
    // 会把成功的当失败, 也会被登录页 HTML 里的零散词误判成功。所以改成「中文成功」或「有 replyId」。
    const okRe = /回复发表成功|"(?:msg|message)"\s*:\s*"[^"]*成功|"replyId"\s*:\s*\d+|"(?:status|success)"\s*:\s*true|"error"\s*:\s*0/i;
    const badRe = /"(?:error|status)"\s*:\s*(?:false|1[0-9]{2,})|error_code\s*[:=]\s*[1-9]|请先登录|未登录|login/i;
    if (!raw.trim()) return { ok: false, error: "服务端返回空(可能没带 cookie)" };
    if (badRe.test(raw)) return { ok: false, error: `服务端拒绝: ${String(raw).slice(0, 120)}` };
    if (!okRe.test(raw)) return { ok: false, error: `返回内容无法确认成功: ${String(raw).slice(0, 120)}` };
    return { ok: true, via, raw: String(raw).slice(0, 200) };
  };

  const saveState = (s) => {
    try {
      persistDiscussState({ courseId, bbsid, state: s, write: writeSetting });
    } catch (e) {
      /* ignore */
    }
    refreshCounts();
  };

  const io = { compose: null, fetchTopic, fetchReplies, postReply, saveState, sleep: sleepMs };
  io.compose = async (payload) => {
    const text = await provider.compose(payload);
    return normalizeComposeText(text);
  };

  const askUser = (draft) =>
    new Promise((resolve) => {
      discussPendingAsk = { resolve };
      panel.showDiscussDraft(draft);
      say(`草稿已生成(${draft.chars} 字): 面板里点「发送」或「跳过」(也可以直接改正文)`, "primary");
    });

  /* ---------------- UI 发帖通道: 队列 + 跨页面续跑 ---------------- */

  /*
   * 页面 UI 通道必须真的导航到话题页(iframe 本机拿不到 contentDocument), 导航后脚本实例就没了。
   * 所以本轮状态(队列/游标/待发草稿)全落 GM 存储; 每个页面加载时 setupDiscuss 看有没有未跑完的一轮,
   * 有就接着发。发帖成功与否用 DOM 判: 正文前 16 字出现, 或「第N楼」的最大值变大。
   */

  let uiDriving = false;

  const sameUuidLocal = (a, b) =>
    String(a || "").toLowerCase() !== "" && String(a || "").toLowerCase() === String(b || "").toLowerCase();

  const saveUi = (q) => {
    try {
      saveUiQueue({ courseId, bbsid, queue: q, write: writeSetting });
    } catch (e) {
      /* 存队列失败只影响续跑 */
    }
  };

  const currentDetailUuid = () => {
    try {
      const ctx = parseDiscussContext(win.location.href);
      return ctx && ctx.mode === "detail" ? ctx.topicUuid : "";
    } catch (e) {
      return "";
    }
  };

  /** 一轮结束: 面板收尾 + run 报告(只报一次) */
  const finishUiRound = (q) => {
    const p = uiQueueProgress(q);
    panel.setDiscussProgress(
      p.done,
      p.total,
      `本轮${q.stopReason ? `(${q.stopReason})` : ""}: 发出 ${q.sent.length} / 跳过 ${q.skipped.length} / 失败 ${q.failed.length}`
    );
    if (!q.reportedAt) {
      q.reportedAt = Date.now();
      saveUi(q);
      const report = uiQueueToReport(q, Date.now());
      finishDiscussReport({ report }, { courseId, bbsid }, say);
      say(
        `本轮结束(${q.stopReason || "完成"}): 共 ${p.total} 条, 发出 ${q.sent.length}, 跳过 ${q.skipped.length}, 失败 ${q.failed.length}`,
        q.failed.length ? "warning" : "success"
      );
    }
    panel.setDiscussRunning(false);
  };

  /** 这一页就是 pending 的话题页 → 填字、点发表、等楼层 */
  const postPendingHere = async (q) => {
    const pending = q.pending;
    const p = uiQueueProgress(q);
    panel.setDiscussProgress(p.done, p.total, `本轮进度 ${p.label} · 正在填字发表…`);
    say(`现在发「${String(pending.title || pending.uuid).slice(0, 20)}」(${pending.chars} 字, 页面 UI)`, "primary");
    const res = await postReplyOnPage({
      doc: win.document,
      win,
      text: pending.text,
      sleep: sleepMs,
      log: say,
      waitMs: 20000,
      pollMs: 2000,
      confirmMs: 20000,
      confirmPollMs: 2000,
    });
    const label = res.ok ? "" : uiFailLabel(res.reason);
    resolveUiQueueTopic(q, {
      uuid: pending.uuid,
      title: pending.title,
      result: res.ok ? "ok" : "fail",
      reason: label,
      reasonCode: res.reason || "",
      text: pending.text,
      chars: pending.chars,
      groundingHits: pending.groundingHits,
      by: res.by || "",
    });
    if (res.ok) {
      recordReply(state, { uuid: pending.uuid, title: pending.title, chars: pending.chars, result: "ok", at: Date.now() });
    } else {
      recordReply(state, { uuid: pending.uuid, title: pending.title, chars: pending.chars, result: "fail", note: label, at: Date.now() });
    }
    saveState(state);
    saveUi(q);
    panel.renderDiscussItem(pending.uuid, res.ok ? "已发送" : "失败", {
      title: pending.title,
      note: res.ok ? `${pending.chars} 字` : label,
    });
    if (res.ok) say(`已回复「${String(pending.title || "").slice(0, 20)}」(${pending.chars} 字, 页面 UI 确认: ${res.by === "floor" ? "楼层数 +1" : "正文已出现"})`, "success");
    else say(`发帖失败「${String(pending.title || "").slice(0, 20)}」: ${label}`, "warning");
    return res;
  };

  /**
   * 生成一条并挂到队列上, 然后导航到它的话题页。
   * @returns {"nav"|"continue"|"stop"}
   */
  const composeAndGo = async (q, topic, cfg) => {
    const gate = canSend(state, { dailyLimit: cfg.dailyLimit, targetTotal: cfg.targetTotal });
    if (!gate.ok) {
      q.status = "stopped";
      q.stopReason = gate.reason;
      saveUi(q);
      say(`${gate.reason} —— 自动停止`, "warning");
      return "stop";
    }
    let detail = null;
    try {
      detail = await fetchTopic({ uuid: topic.uuid, title: topic.title });
    } catch (e) {
      detail = null;
    }
    let existing = [];
    try {
      existing = await fetchReplies({ uuid: topic.uuid });
    } catch (e) {
      existing = [];
    }
    if (!Array.isArray(existing)) existing = [];

    const terms = cfg.batch ? pickGroundingTerms(String(topic.title || ""), String((detail && detail.body) || "")) : [];
    let text = "";
    let check = null;
    let groundingOk = true;
    let groundingHits = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        text = await io.compose({
          topicTitle: String(topic.title || ""),
          topicBody: String((detail && detail.body) || ""),
          existingReplies: existing,
          minChars: cfg.minChars,
          maxChars: cfg.maxChars,
        });
      } catch (e) {
        text = "";
      }
      text = normalizeComposeText(text);
      check = checkComposeText(text, { minChars: cfg.minChars, maxChars: cfg.maxChars, existingReplies: existing });
      groundingOk = true;
      groundingHits = [];
      if (!check.ok) {
        say(`第 ${attempt} 次生成不合格: ${check.reasons.join("; ")}`, "warning");
        continue;
      }
      if (!terms.length) break;
      const g = checkGrounding(text, terms);
      groundingOk = g.ok;
      groundingHits = g.hit;
      if (g.ok) break;
      say(`第 ${attempt} 次接地未命中(备选词: ${terms.slice(0, 6).join("、")})`, "warning");
    }
    if (!check || !check.ok) {
      const reason = `两次生成都不合格: ${check ? check.reasons.join("; ") : "无正文"}`;
      resolveUiQueueTopic(q, { uuid: topic.uuid, title: topic.title, result: "fail", reason, reasonCode: "compose" });
      skipTopic(state, topic.uuid);
      saveState(state);
      saveUi(q);
      panel.renderDiscussItem(topic.uuid, "生成不合格·跳过", { title: topic.title, note: check ? `${check.chars} 字` : "" });
      return "continue";
    }
    if (!groundingOk) {
      const reason = `两次生成都没命中话题关键词(${terms.slice(0, 6).join("、") || "无可用关键词"})`;
      resolveUiQueueTopic(q, { uuid: topic.uuid, title: topic.title, result: "fail", reason, reasonCode: "grounding", chars: check.chars });
      saveUi(q);
      panel.renderDiscussItem(topic.uuid, "接地失败·待人工", { title: topic.title, note: `${check.chars} 字` });
      say(`接地失败, 未发送「${String(topic.title || "").slice(0, 18)}」`, "warning");
      return "continue";
    }

    if (!(cfg.auto || cfg.batch)) {
      panel.renderDiscussItem(topic.uuid, "草稿待确认", { title: topic.title, note: `${check.chars} 字` });
      let answer = "skip";
      try {
        answer = await askUser({ uuid: topic.uuid, title: topic.title, text, chars: check.chars });
      } catch (e) {
        answer = "skip";
      }
      let edited = null;
      if (answer && typeof answer === "object") {
        edited = typeof answer.text === "string" ? answer.text.trim() : null;
        answer = String(answer.action || "skip");
      }
      if (answer === "stop") {
        q.status = "stopped";
        q.stopReason = "用户停止";
        saveUi(q);
        return "stop";
      }
      if (answer !== "send") {
        resolveUiQueueTopic(q, { uuid: topic.uuid, title: topic.title, result: "skip", reason: "userSkipped" });
        skipTopic(state, topic.uuid);
        saveState(state);
        saveUi(q);
        panel.renderDiscussItem(topic.uuid, "已跳过", { title: topic.title });
        return "continue";
      }
      if (edited && edited !== text) {
        const recheck = checkComposeText(edited, { minChars: cfg.minChars, maxChars: cfg.maxChars, existingReplies: existing });
        if (!recheck.ok) {
          resolveUiQueueTopic(q, {
            uuid: topic.uuid,
            title: topic.title,
            result: "fail",
            reason: `手改正文不合格: ${recheck.reasons.join("; ")}`,
            reasonCode: "compose",
            chars: recheck.chars,
          });
          saveUi(q);
          panel.renderDiscussItem(topic.uuid, "失败", { title: topic.title, note: recheck.reasons[0] || "手改正文不合格" });
          return "continue";
        }
        text = edited;
        check = recheck;
      }
    }

    setUiQueuePending(q, { uuid: topic.uuid, title: topic.title, text, chars: check.chars, groundingHits });
    saveUi(q);
    const p = uiQueueProgress(q);
    panel.setDiscussProgress(p.done, p.total, `本轮进度 ${p.label} · 正在打开话题页…`);
    panel.renderDiscussItem(topic.uuid, "打开话题页", { title: topic.title, note: `${check.chars} 字` });
    say(`打开话题页发「${String(topic.title || "").slice(0, 20)}」(${p.label})`, "primary");
    win.location.href = replysListUrl({ bbsid, uuid: topic.uuid, courseId, classId });
    return "nav";
  };

  /** 队列驱动: 先发 pending, 再逐条生成+导航; 导航后由下次页面加载接着跑 */
  const driveUiQueue = async (cfgIn) => {
    if (uiDriving) return;
    const q = loadUiQueue({ courseId, bbsid, read: readSetting });
    if (!q || q.status !== "running" || q.postMode !== "ui") {
      if (q) finishUiRound(q);
      return;
    }
    const cfg = cfgIn || panel.getDiscussConfig();
    uiDriving = true;
    discussRun = createCancelToken();
    discussRun.begin();
    panel.setDiscussRunning(true);
    panel.resetDiscussItems(q.topics);
    try {
      if (q.pending) {
        const cur = currentDetailUuid();
        if (!sameUuidLocal(cur, q.pending.uuid)) {
          say(`继续未发的一条: 打开「${String(q.pending.title || "").slice(0, 20)}」…`, "primary");
          win.location.href = replysListUrl({ bbsid, uuid: q.pending.uuid, courseId, classId });
          return;
        }
        await postPendingHere(q);
      }
      while (q.status === "running") {
        if (discussRun.stopped) {
          q.status = "stopped";
          q.stopReason = "用户停止";
          saveUi(q);
          break;
        }
        const nxt = nextUiTopic(q);
        if (!nxt.ok) {
          q.status = "done";
          q.stopReason = q.stopReason || nxt.reason;
          saveUi(q);
          break;
        }
        const step = await composeAndGo(q, nxt.topic, cfg);
        if (step === "nav") return;
        if (step === "stop") break;
      }
      finishUiRound(q);
    } finally {
      uiDriving = false;
      if (discussPendingAsk) answerDiscussAsk("stop");
      discussRun.done();
      refreshCounts();
    }
  };

  // ---- 面板接线 ----
  panel.onDiscussStart = async () => {
    if (discussRun.running) {
      say("讨论区还在跑: 先点「停止」再开新一轮", "warning");
      return;
    }
    const cfg = panel.getDiscussConfig();
    const postMode = normalizePostMode(cfg.postMode);
    if (postMode === "ui") {
      // 页面 UI 通道: 状态在队列里, 导航回来后由 driveUiQueue 接着跑
      discussLastReport = null;
      const prev = loadUiQueue({ courseId, bbsid, read: readSetting });
      if (prev && prev.status === "running" && !isUiQueueStale(prev)) {
        const pp = uiQueueProgress(prev);
        say("检测到未跑完的一轮, 接着跑(成功过的话题不重发)", "primary");
        panel.setDiscussProgress(pp.done, pp.total, `本轮进度 ${pp.label} · 继续…`);
        await driveUiQueue(cfg);
        return;
      }
      let topics = [];
      try {
        panel.setDiscussRunning(true);
        panel.setDiscussProgress(0, 0, "正在取话题列表…");
        topics = await listTopics();
      } catch (e) {
        panel.setDiscussRunning(false);
        say(`讨论区异常: ${e && e.message}`, "danger");
        return;
      }
      const fresh = topics.filter((t) => t && t.uuid && !hasRepliedTopic(state, t.uuid) && !hasSkippedTopic(state, t.uuid));
      if (!fresh.length) {
        panel.setDiscussRunning(false);
        panel.setDiscussProgress(0, topics.length, "没有待处理话题");
        say(`没有待处理话题: ${topics.length} 条里都已回复过/被跳过`, "warning");
        return;
      }
      const q = createUiQueue({ courseId, bbsid, target: cfg.targetTotal, dailyLimit: cfg.dailyLimit, postMode: "ui", topics: fresh });
      saveUi(q);
      panel.setDiscussRunning(false);
      say(
        `开始(页面 UI 通道): ${fresh.length} 条话题, 目标总 ${cfg.targetTotal} 条 / 今日上限 ${cfg.dailyLimit} 条 / 字数 ${cfg.minChars}-${cfg.maxChars}`,
        "primary"
      );
      await driveUiQueue(cfg);
      return;
    }
    discussLastReport = null;
    discussRun = createCancelToken();
    discussRun.begin();
    panel.setDiscussRunning(true);
    panel.setDiscussProgress(0, 0, "正在取话题列表…");
    const modeLabel = cfg.batch ? "批量模式" : cfg.auto ? "连续自动" : "逐条确认";
    let stats = null;
    try {
      const topics = await listTopics();
      if (!topics.length) {
        panel.setDiscussProgress(0, 0, "没有话题可处理");
        say("没取到话题: 确认 bbsid 对、且这个圈子下真的有帖子", "warning");
        return;
      }
      panel.resetDiscussItems(topics);
      panel.setDiscussProgress(0, topics.length, `待处理 ${topics.length} 条(${modeLabel})`);
      say(`开始(${modeLabel}): ${topics.length} 条话题, 目标总 ${cfg.targetTotal} 条 / 今日上限 ${cfg.dailyLimit} 条 / 间隔 ${cfg.intervalMinSec}-${cfg.intervalMaxSec}s / 字数 ${cfg.minChars}-${cfg.maxChars}`, "primary");
      let done = 0;
      stats = await runDiscussRound({
        topics,
        state,
        opts: {
          targetTotal: cfg.targetTotal,
          dailyLimit: cfg.dailyLimit,
          intervalMinSec: cfg.intervalMinSec,
          intervalMaxSec: cfg.intervalMaxSec,
          minChars: cfg.minChars,
          maxChars: cfg.maxChars,
          auto: cfg.auto,
          batch: cfg.batch,
          interruptibleWait: true,
          postMode: "api",
          bbsid,
          courseId,
          classId,
        },
        io,
        askUser,
        shouldStop: () => discussRun.stopped,
        log: say,
        onItem: (uuid, status, extra) => {
          if (!/待确认/.test(String(status))) done += 1;
          panel.renderDiscussItem(uuid, status, extra || {});
          const c = discussCounts(state, Date.now());
          panel.setDiscussCounts(c.today, c.total);
          const title = extra && extra.title ? ` · ${String(extra.title).slice(0, 18)}` : "";
          panel.setDiscussProgress(done, topics.length, `第 ${Math.min(done || 1, topics.length)}/${topics.length} 条 · 今日 ${c.today} · 累计 ${c.total} · ${status}${title}`);
        },
      });
    } catch (e) {
      say(`讨论区异常中止: ${e && e.message}`, "danger");
    } finally {
      if (discussPendingAsk) answerDiscussAsk("stop");
      discussRun.done();
      panel.setDiscussRunning(false);
      refreshCounts();
    }
    if (!stats) return;
    const tail = stats.stopped ? `(已停止: ${stats.reason || "用户停止"})` : "";
    panel.setDiscussProgress(stats.sent, stats.total, `本轮${tail}: 发出 ${stats.sent} / 跳过 ${stats.skipped} / 失败 ${stats.failed}`);
    say(
      `本轮结束${tail}: 共 ${stats.total} 条, 发出 ${stats.sent}, 跳过 ${stats.skipped}, 生成不合格 ${stats.invalid}, 失败 ${stats.failed}`,
      stats.failed ? "warning" : "success"
    );
    finishDiscussReport(stats, { courseId, bbsid }, say);
  };

  panel.onDiscussStop = () => {
    const q = loadUiQueue({ courseId, bbsid, read: readSetting });
    if (q && q.status === "running" && q.postMode === "ui") {
      q.status = "stopped";
      q.stopReason = "用户停止";
      saveUi(q);
      say("已停止本轮(队列已标记停止, 不会再自动续跑)", "warning");
    }
    if (discussPendingAsk) answerDiscussAsk("stop");
    if (!discussRun.running || discussRun.stopped) return false;
    discussRun.request();
    say("已停止: 不再发下一条", "warning");
    return true;
  };

  panel.onDiscussSend = () => {
    if (!answerDiscussAsk("send", panel.getDiscussDraftText())) say("当前没有待确认的草稿", "warning");
  };

  panel.onDiscussSkip = () => {
    if (!answerDiscussAsk("skip")) say("当前没有待确认的草稿", "warning");
  };

  // 抽样: 从本轮已发里等距抽 1/10(1-5 条), 纯本地拼文本, 不花 token
  panel.onDiscussSample = () => {
    const sent = (discussLastReport && discussLastReport.sent) || [];
    if (!sent.length) {
      say("本轮还没有发出的回复可抽样: 先跑一轮", "warning");
      return;
    }
    const picked = sampleSentForReview(sent);
    panel.showDiscussExport(formatSamplesForReview(picked), `已等距抽取 ${picked.length}/${sent.length} 条(当前轮已发), 全选复制给 agent 抽查`);
  };

  // 导出报告: JSON 塞进可复制文本框, 外层 agent 直接读
  panel.onDiscussReport = () => {
    const report = discussLastReport;
    if (!report) {
      say("还没有本轮报告: 先跑一轮(中途「停止」也算一轮)", "warning");
      return;
    }
    panel.showDiscussExport(
      reportToJson(report),
      `报告已导出: 发出 ${report.sent.length} / 失败 ${report.failed.length} / 跳过 ${report.skipped.length}(不含 cookie/urlToken/visitorId)`
    );
  };

  // 重发: 对「上一条草稿/上一条已发」的话题强制再发一次(已回复过的话题也发)
  panel.onDiscussResend = async () => {
    if (normalizePostMode(panel.getDiscussConfig().postMode) === "ui") {
      say("页面 UI 通道下不用「重发上一条」: 直接点「开始」, 未发过的会接着发", "warning");
      return;
    }
    if (discussRun.running) {
      say("还在跑: 先停止再重发", "warning");
      return;
    }
    const lastOk = [...(state.records || [])].reverse().find((r) => r && r.uuid);
    const targetUuid = (panel.discussDraft && panel.discussDraft.uuid) || (lastOk && lastOk.uuid) || "";
    if (!targetUuid) {
      say("没有可重发的话题: 先跑一轮(或先发一条)", "warning");
      return;
    }
    const cfg = panel.getDiscussConfig();
    discussRun = createCancelToken();
    discussRun.begin();
    panel.setDiscussRunning(true);
    let stats = null;
    try {
      const all = await listTopics();
      const hit = all.find((t) => String(t.uuid).toLowerCase() === String(targetUuid).toLowerCase());
      const topics = [hit || { uuid: targetUuid, title: (lastOk && lastOk.title) || "" }];
      panel.resetDiscussItems(topics);
      stats = await runDiscussRound({
        topics,
        state,
        opts: {
          targetTotal: cfg.targetTotal,
          dailyLimit: cfg.dailyLimit,
          intervalMinSec: 0,
          intervalMaxSec: 0,
          minChars: cfg.minChars,
          maxChars: cfg.maxChars,
          auto: cfg.auto,
          batch: cfg.batch,
          interruptibleWait: true,
          allowResendUuid: targetUuid,
          postMode: "api",
          bbsid,
          courseId,
          classId,
        },
        io,
        askUser,
        shouldStop: () => discussRun.stopped,
        log: say,
        onItem: (uuid, status, extra) => panel.renderDiscussItem(uuid, status, extra || {}),
      });
    } catch (e) {
      say(`重发异常: ${e && e.message}`, "danger");
    } finally {
      if (discussPendingAsk) answerDiscussAsk("stop");
      discussRun.done();
      panel.setDiscussRunning(false);
      refreshCounts();
    }
    if (stats) say(`重发结束: 发出 ${stats.sent}, 失败 ${stats.failed}`, stats.failed ? "warning" : "success");
    if (stats) finishDiscussReport(stats, { courseId, bbsid }, say);
  };

  // 页面导航回来: 有未完成的一轮(UI 通道)就接着跑。
  // 超过 30 分钟没动过 = 页面早被关了, 不自动续跑 —— 否则一打开讨论区就自己往外发。
  (async () => {
    const q = loadUiQueue({ courseId, bbsid, read: readSetting });
    if (!q || q.status !== "running" || q.postMode !== "ui") return;
    if (isUiQueueStale(q)) {
      q.status = "stopped";
      q.stopReason = "上次没跑完且超过 30 分钟(页面关过?), 不自动续跑";
      saveUi(q);
      finishUiRound(q);
      say("上次没跑完的一轮已超时, 不自动续跑; 点「开始」会重开一轮", "warning");
      return;
    }
    const pp = uiQueueProgress(q);
    say(`检测到未跑完的一轮(${pp.label}), 继续…`, "primary");
    await driveUiQueue();
  })();
}

// ---------------------------------------------------------------- AI陪练
// 页面结构依据: 2026-11-13 真机侦察(见 一手侦察记录(未随仓库分发))。
// 铁律: 同一标签页只允许一个操作者 —— 陪练开跑时答题/刷课/别的流程都不能动页面。
const PRACTICE_SEL = {
  direction: "textarea#practiceTextarea, textarea.practiceTextarea",
  weakPoint: "span.weakKnowledgepoint",
  selectedPoint: ".text-points span.quekKowledge",
  startBtn: "span.practiceBtn",
  endBtn: ".endPracticeBtn",
  continueBtn: "span.blueBgBtn.continuePracticeBtn, .continuePracticeBtn",
  unKnow: ".questionDiv .questionTitle span.redBorBtn.unKnow, .questionDiv .unKnow",
  editorTextarea: "textarea#midTextarea",
  sendBtn: "span.enterBtn",
  judgeBlock: ".aiAnswertCon_white",
  question: ".questionDiv",
  loading: ".loadingDiv",
  correctAnswer: ".correctAnswer",
  resultAnswer: ".resultAnswer",
};

let practiceRun = createCancelToken();
// 逐题确认: 生成完在等面板点「发送/跳过/停止」—— 这里存着那个 resolve
let practicePending = null;
// 最近一轮 run 报告(导出/抽样读它)
let practiceReport = null;

function practiceEventCtor(doc, name) {
  const win = doc && doc.defaultView;
  const Ctor = win && win[name];
  return Ctor || (typeof globalThis !== "undefined" ? globalThis[name] : null) || null;
}

/** 页面点击(与讨论区一样: 先 mousedown/mouseup 再 click — 实测 UEditor 的「发送」要这样才真发) */
function dispatchPracticeClick(el) {
  if (!el) return false;
  const doc = el.ownerDocument;
  for (const type of ["mousedown", "mouseup"]) {
    try {
      const Ev = practiceEventCtor(doc, "MouseEvent") || practiceEventCtor(doc, "Event");
      if (Ev) el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: doc && doc.defaultView }));
    } catch (e) {
      /* 派发失败不影响后面的 click */
    }
  }
  try {
    el.click();
    return true;
  } catch (e) {
    try {
      const Ev = practiceEventCtor(doc, "Event");
      if (Ev) el.dispatchEvent(new Ev("click", { bubbles: true }));
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/** 原生 setter 写 textarea + input/change(超星页面监听的是这两个事件) */
function setPracticeTextarea(doc, el, value) {
  if (!el) return false;
  try {
    const win = doc && doc.defaultView;
    const proto = win && win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") desc.set.call(el, String(value));
    else el.value = String(value);
  } catch (e) {
    el.value = String(value);
  }
  for (const type of ["input", "change"]) {
    try {
      const Ev = practiceEventCtor(doc, "Event");
      if (Ev) el.dispatchEvent(new Ev(type, { bubbles: true }));
    } catch (e) {
      /* ignore */
    }
  }
  return true;
}

function countPracticePoints(doc) {
  try {
    return doc.querySelectorAll(PRACTICE_SEL.selectedPoint).length;
  } catch (e) {
    return 0;
  }
}

/** 页面上「薄弱知识点」去重(实测 12 个渲染, 其中 6 个重复) */
function uniquePracticePoints(doc) {
  const seen = new Set();
  const out = [];
  let list = [];
  try {
    list = Array.from(doc.querySelectorAll(PRACTICE_SEL.weakPoint));
  } catch (e) {
    list = [];
  }
  for (const el of list) {
    const id = el.getAttribute("topicid") || el.getAttribute("topicname") || String(el.textContent || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(el);
  }
  return out;
}

/** 把每一个薄弱知识点都点上(已经是选中态的不会被点掉) */
function selectAllPracticePoints(doc) {
  const points = uniquePracticePoints(doc);
  const want = points.length;
  for (const el of points) {
    if (countPracticePoints(doc) >= want) break;
    const before = countPracticePoints(doc);
    el.click();
    if (countPracticePoints(doc) < before) el.click(); // 原来就选中, 被我们点掉了 → 点回来
  }
  return countPracticePoints(doc);
}

/** 取消页面上所有已选知识点 */
function clearPracticePoints(doc) {
  for (const el of uniquePracticePoints(doc)) {
    const before = countPracticePoints(doc);
    if (before === 0) break;
    el.click();
    if (countPracticePoints(doc) > before) el.click(); // 原来是未选, 被我们点上了 → 点回去
  }
  return countPracticePoints(doc);
}

/** 等一道新题(prevKey 用来识别「换题了」; 逐题流式生成时旧题会先在页面上) */

/** 等页面把流式输出收完(没有 .loadingDiv), 超时就放弃等待(不阻断主流程) */

/** 页面上「正确答案:X」的字母 —— 判分文本里没取到时兜底用 */
function readPracticeCorrectLetter(doc) {
  const nodes = [PRACTICE_SEL.correctAnswer, PRACTICE_SEL.resultAnswer];
  for (const sel of nodes) {
    try {
      const n = doc.querySelector(sel);
      const t = String((n && (n.innerText || n.textContent)) || "");
      const m = t.match(/正确答案\s*[:：]\s*([A-Za-z]+|对|错)/) || t.match(/^\s*([A-Za-z]{1,4})\s*$/);
      if (m) return m[1].toUpperCase();
    } catch (e) {
      /* 继续看下一个 */
    }
  }
  return "";
}

async function waitPracticeIdle(doc, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!doc.querySelector(PRACTICE_SEL.loading)) return true;
    await sleepMs(800);
  }
  return false;
}

async function waitPracticeQuestion(doc, prevKey, timeoutMs = 60000, onTick) {
  const t0 = Date.now();
  let lastTick = 0;
  while (Date.now() - t0 < timeoutMs) {
    const q = readQuestion(doc);
    if (q.ok && q.stem && q.key !== prevKey) return q;
    const elapsed = Date.now() - t0;
    if (typeof onTick === "function" && elapsed - lastTick >= 30000) {
      lastTick = elapsed;
      onTick(Math.round(elapsed / 1000));
    }
    await sleepMs(600);
  }
  return { ok: false, reason: "no-question" };
}

/** 判分文本落在聊天区 —— 取 body 文本里从「你的答案/正确答案/答案解析」开始的一段 */
function practiceBodyText(doc) {
  try {
    const body = doc && doc.body;
    return String((body && (body.innerText || body.textContent)) || "");
  } catch (e) {
    return "";
  }
}


/** 「结束陪练」按钮: 实测页面没有 .endPracticeBtn —— 它就是 span.practiceBtn 换文案(开始练习/结束陪练) */
function practiceEndButton(doc) {
  // 实测(2026-11-13): 点 .endPracticeBtn 页面没反应; 点文案变成「结束陪练」的 span.practiceBtn 才真结束。
  // 所以顺序反过来: 先认 practiceBtn 的文案, 再退回 .endPracticeBtn。
  const btn = doc.querySelector(PRACTICE_SEL.startBtn);
  if (btn && /结束/.test(String(btn.textContent || btn.innerText || ""))) return btn;
  return doc.querySelector(PRACTICE_SEL.endBtn);
}

/** 结束/重开陪练会弹页面自己的确认框(不是原生 confirm): 找可见的「确定」点掉 */
function confirmPracticeEndPopup(doc) {
  try {
    const nodes = doc.querySelectorAll("a, span, button, div");
    for (const n of nodes) {
      const txt = String(n.textContent || "").trim();
      if (txt !== "确定" && txt !== "确认") continue;
      if (n.children && n.children.length) continue;
      if (!n.offsetParent && getComputedStyle(n).position !== "fixed") continue;
      const box = n.closest("[class*=pop], [class*=Pop], [class*=layer], [class*=Layer], [class*=dialog], [class*=Dialog]");
      if (!box) continue;
      return dispatchPracticeClick(n);
    }
  } catch (e) {
    /* 弹层结构变了就算了, 反正只是一步收尾 */
  }
  return false;
}

/**
 * 页面上所有可能含判分的文本块。
 * 2026-11-13 真机: 判分挂在 `.aiAnswertCon_white`, **不在** `.questionDiv` 里;
 * 而且答完会一直留着(下一题还看得见) —— 所以取全部候选, 交给 pickJudgeText 按内容去重。
 */
function practiceJudgeCandidates(doc) {
  const out = [];
  try {
    const nodes = doc.querySelectorAll(PRACTICE_SEL.judgeBlock);
    for (const n of nodes) {
      const t = String(n.innerText || n.textContent || "").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
  } catch (e) {
    /* 落到整体文本兜底 */
  }
  if (!out.length) {
    // 兜底: 从整页文本里裁一段以「正确答案」为中心的窗口
    const body = practiceBodyText(doc);
    const i = body.indexOf("正确答案");
    if (i >= 0) out.push(body.slice(Math.max(0, i - 80), i + 900).replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * 等「这一题」的判分。seen 是本轮已消费过的判分文本集合 —— 旧判分不会被当成新判分。
 * 不用「文本变长」判断: 实测发送后编辑器/提示收缩会让整页 innerText 变短, 按长度偏移会永远读不到。
 */
async function waitPracticeJudge(doc, seen, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = pickJudgeText(practiceJudgeCandidates(doc), seen);
    if (hit) {
      // 「你的答案是正确的」先到, 「正确答案:B」「答案解析」随后才流进来 —— 再等 4s 补全
      if (!/正确答案/.test(hit)) {
        const head = hit.slice(0, 12);
        for (let k = 0; k < 15; k++) {
          await sleepMs(700);
          const richer = practiceJudgeCandidates(doc).find(
            (c) => /正确答案/.test(c) && c.indexOf(head) !== -1 && !seen.has(c)
          );
          if (richer) {
            if (seen && typeof seen.add === "function") seen.add(richer);
            return richer;
          }
        }
      }
      return hit;
    }
    await sleepMs(700);
  }
  return "";
}

/** 拿 UEditor 实例(实测 UE.getEditor('midTextarea') 有效; textarea 本身是隐藏的源码框) */
function practiceEditor(win) {
  try {
    const UECtor = (win && win.UE) || (win && win.unsafeWindow && win.unsafeWindow.UE);
    if (UECtor && typeof UECtor.getEditor === "function") return UECtor.getEditor("midTextarea");
  } catch (e) {
    /* 落到 textarea 兜底 */
  }
  return null;
}

/** 往编辑器里写答案; 返回 false = 找不到任何可写入口 */
function writePracticeAnswer(win, doc, answer) {
  const ed = practiceEditor(win);
  if (ed && typeof ed.setContent === "function") {
    try {
      ed.setContent(String(answer));
      if (typeof ed.getContentTxt !== "function" || String(ed.getContentTxt() || "").trim()) return true;
    } catch (e) {
      /* 落到 textarea */
    }
  }
  const ta = doc.querySelector(PRACTICE_SEL.editorTextarea);
  if (ta) return setPracticeTextarea(doc, ta, String(answer));
  return false;
}

/** 逐题确认下, 等面板点发送/跳过/停止 */
function waitPracticeAction() {
  return new Promise((resolve) => {
    practicePending = { resolve };
  });
}

function answerPracticePending(action) {
  const pending = practicePending;
  if (!pending) return false;
  practicePending = null;
  if (panel) panel.clearPracticeCurrent();
  pending.resolve(action === "skip" ? "skip" : action === "stop" ? "stop" : "send");
  return true;
}

function stopPractice(log) {
  const interrupted = practiceRun.request();
  if (practicePending) answerPracticePending("stop");
  if (interrupted) log("AI陪练: 停止 —— 不再发下一题, 已生成的题留在页面上", "warning");
  return interrupted;
}

/** 页面上还有没有别的流程在跑(同一标签页只允许一个操作者) */
function practiceOtherBusy() {
  if (answerRun.running || tutorRun.running || discussRun.running) return true;
  if (courseController && typeof courseController.isRunning === "function" && courseController.isRunning()) return true;
  return false;
}

/**
 * AI陪练主循环(可停)。
 * 开始 → 选知识点/填方向 → 点「开始练习」→ 等题 → (逐题确认/连跑) → 桥答题 → 写 UEditor 并发送
 * → 等判分 → 记报告 → 到 N 题点「结束陪练」, 否则点「继续」进下一题。
 */
async function runPractice({ win, log }) {
  if (!panel) return;
  if (practiceRun.running) return;
  if (practiceOtherBusy()) {
    panel.setPracticeStatus("别的流程正在跑, 先停掉再开陪练(同一页面只允许一个操作者)", true);
    log("AI陪练: 页面上还有别的流程在跑, 拒绝开始", "warning");
    return;
  }
  const doc = win.document;
  const cfg = panel.getPracticeConfig();
  const run = practiceRun.begin();
  const report = createPracticeReport({ direction: cfg.direction, maxQuestions: cfg.maxQuestions, mode: cfg.mode });
  practiceReport = report;
  let index = 0;
  let stopReason = "";
  // 本轮已消费过的判分文本(页面会把旧判分留着, 不按内容去重会把上一题判分当这一题)
  const seenJudge = new Set();
  const finish = () => {
    report.endedAt = Date.now();
    const st = practiceStats(report);
    const bad = ["no-question", "bridge-fail", "send-fail"].includes(stopReason);
    panel.setPracticeStatus(
      `已结束: 共 ${index} 题 · 正确 ${st.right} / 错误 ${st.wrong} / 跳过 ${st.skipped} · 正确率 ${st.graded ? st.accuracy + "%" : "—"}${stopReason ? ` (${stopReason})` : ""}`,
      bad
    );
    panel.setPracticeProgress(index, cfg.maxQuestions, `已结束 ${index}/${cfg.maxQuestions}`);
    panel.setPracticeStats(st, index);
    panel.clearPracticeCurrent();
    panel.setPracticeRunning(false);
    run.done();
    if (practicePending) practicePending = null;
    log(`AI陪练结束: ${index} 题, 正确 ${st.right} / 错误 ${st.wrong} / 跳过 ${st.skipped}; 「导出报告」可拿走本轮明细`, bad ? "danger" : "success");
  };

  panel.resetPracticeItems();
  panel.setPracticeRunning(true);
  panel.setPracticeProgress(0, cfg.maxQuestions, "准备中…");
  panel.setPracticeStats(practiceStats(report), 0);
  panel.clearPracticeCurrent();
  try {
    panel.setPracticePoints(countPracticePoints(doc));
    if (!countPracticePoints(doc)) log("AI陪练: 页面上没有选中知识点 —— 可点「用薄弱知识点」或自己点几个", "warning");
    if (cfg.direction.trim()) {
      const ta = doc.querySelector(PRACTICE_SEL.direction);
      if (ta) setPracticeTextarea(doc, ta, cfg.direction);
    }
    const startBtn = doc.querySelector(PRACTICE_SEL.startBtn);
    if (!startBtn) {
      stopReason = "no-question";
      log("AI陪练: 找不到「开始练习」按钮(span.practiceBtn) —— 页面结构可能变了", "danger");
      return;
    }
    if (practiceEndButton(doc)) log("AI陪练: 页面上还有没结束的练习, 这次会重新开一轮", "warning");
    dispatchPracticeClick(startBtn);
    await sleepMs(900);
    // 页面上已有练习时, 点开始会弹自己的「确定要重新开始陪练吗?」确认框 —— 不点掉就永远出不了题
    if (confirmPracticeEndPopup(doc)) log("AI陪练: 已点掉「重新开始陪练」确认框", "primary");
    log("AI陪练: 已点「开始练习」, 等出题…", "primary");

    let prevKey = "";
  let lastRow = null;
    while (!run.stopped && index < cfg.maxQuestions) {
      const q = await waitPracticeQuestion(doc, prevKey, 900000, (sec) => {
        // 页面出题慢(实测继续后 2-5 分钟), 每 30s 报一次, 免得看着像死机
        log(`AI陪练: 等第 ${index + 1} 题生成… 已等 ${sec}s`, "primary");
      });
      if (!q.ok) {
        reportFail(report, { index: index + 1, reasonCode: "no-question", reason: "900s 内没等到新题干" });
        stopReason = "no-question";
        log("AI陪练: 900s 内没等到新题干, 停", "danger");
        break;
      }
      prevKey = q.key;
      index += 1;
      q.index = index;
      panel.setPracticeProgress(index, cfg.maxQuestions, `第 ${index} 题`);
      panel.setPracticeStatus(`第 ${index} 题: 已生成, ${cfg.mode === "confirm" ? "等你点「发送」或「跳过」" : "自动作答中…"}`);
      panel.showPracticeCurrent(q);

      let action = "send";
      if (cfg.mode === "confirm") action = await waitPracticeAction();
      if (run.stopped || action === "stop") {
        stopReason = "stopped";
        break;
      }

      if (action === "skip") {
        if (!dispatchPracticeClick(doc.querySelector(PRACTICE_SEL.unKnow))) {
          reportFail(report, { index, type: q.type, stem: q.stem, reasonCode: "send-fail", reason: "找不到「不会」按钮" });
          stopReason = "send-fail";
          log("AI陪练: 找不到「不会」按钮(span.unKnow), 停", "danger");
          break;
        }
        reportSkip(report, { index, type: q.type, stem: q.stem });
        log(`AI陪练: 第 ${index} 题跳过(点了「不会」)`, "warning");
      } else {
        let raw = "";
        try {
          raw = await provider.practice({ type: q.type, stem: q.stem, options: q.options, direction: cfg.direction });
        } catch (e) {
          reportFail(report, { index, type: q.type, stem: q.stem, reasonCode: "bridge-fail", reason: (e && e.message) || "调用答题桥失败" });
          stopReason = "bridge-fail";
          log(`AI陪练: 第 ${index} 题取答案失败: ${(e && e.message) || e}`, "danger");
          break;
        }
        const answer = normalizeAnswer(raw, q.type, q.options);
        if (!answer) {
          reportFail(report, { index, type: q.type, stem: q.stem, reasonCode: "bridge-fail", reason: "桥返回空答案" });
          stopReason = "bridge-fail";
          break;
        }
        if (run.stopped) {
          stopReason = "stopped";
          break;
        }
        panel.setPracticeStatus(`第 ${index} 题: 发送答案 ${answer.slice(0, 40)}…`);
        if (!writePracticeAnswer(win, doc, answer)) {
          reportFail(report, { index, type: q.type, stem: q.stem, reasonCode: "send-fail", reason: "找不到 UEditor/textarea" });
          stopReason = "send-fail";
          log("AI陪练: 找不到编辑器(UEditor midTextarea), 停", "danger");
          break;
        }
        const sendBtn = doc.querySelector(PRACTICE_SEL.sendBtn);
        if (!sendBtn || !dispatchPracticeClick(sendBtn)) {
          reportFail(report, { index, type: q.type, stem: q.stem, reasonCode: "send-fail", reason: "找不到「发送」按钮" });
          stopReason = "send-fail";
          log("AI陪练: 找不到「发送」按钮(span.enterBtn), 停", "danger");
          break;
        }
        log(`AI陪练: 第 ${index} 题已发送答案「${answer}」, 等判分…`, "primary");
        const tail = await waitPracticeJudge(doc, seenJudge, 90000);
        const judge = parseJudge(tail);
        if (!tail) {
          reportFail(report, { index, type: q.type, stem: q.stem, reasonCode: "no-judge", reason: "90s 内没等到判分文本" });
          log("AI陪练: 90s 内没等到判分文本, 这题记 unknown", "warning");
          panel.setPracticeStatus(`第 ${index} 题: 判分没读到(记 unknown), 继续下一题…`, true);
        }
        const row = reportAnswer(report, {
          index,
          type: q.type,
          stem: q.stem,
          answer,
          correct: judge.correct,
          result: judge.result,
          analysis: judge.analysis,
        });
        panel.renderPracticeItem(row);
        lastRow = row;
        log(
          `AI陪练: 第 ${index} 题 ${judge.result === "right" ? "答对 ✅" : judge.result === "wrong" ? "答错 ❌" : "判不出"}${judge.correct ? ` (正确答案 ${judge.correct})` : ""}`,
          judge.result === "right" ? "success" : judge.result === "wrong" ? "warning" : "primary"
        );
      }

      const st = practiceStats(report);
      panel.setPracticeStats(st, index);
      panel.clearPracticeCurrent();

      if (index >= cfg.maxQuestions) {
        reportFail(report, { index, reasonCode: "reach-limit", reason: `已到上限 ${cfg.maxQuestions} 题` });
        stopReason = "reach-limit";
        break;
      }
      const cont = doc.querySelector(PRACTICE_SEL.continueBtn);
      if (!cont) {
        log("AI陪练: 没找到「继续」按钮 —— 页面可能已经收尾", "warning");
        break;
      }
      // 判分/解析还在流式输出时点「继续」会被页面吞掉(实测: 点完 5 分钟都不出新题)。
      // 先等 loadingDiv 收掉, 最多 120s。
      await waitPracticeIdle(doc, 120000);
      // 等流式的功夫「正确答案」常常才落地 —— 这时补一次, 错题表才不是「(未取到)」
      if (lastRow && !lastRow.correct) {
        const late = readPracticeCorrectLetter(doc);
        if (late) {
          lastRow.correct = late;
          if (panel && typeof panel.patchPracticeItem === "function") panel.patchPracticeItem(lastRow);
          log(`AI陪练: 第 ${index} 题补到正确答案 ${late}`, "primary");
        }
      }
      panel.setPracticeStatus(`第 ${index} 题: 已判分, 点「继续」生成下一题…`);
      let advanced = false;
      for (let attempt = 0; attempt < 3 && !advanced; attempt++) {
        dispatchPracticeClick(cont);
        await sleepMs(2500);
        // 页面开始生成 = loadingDiv 出现, 或者题卡被清空
        advanced = !!doc.querySelector(PRACTICE_SEL.loading) || !doc.querySelector(PRACTICE_SEL.question);
        if (!advanced) log(`AI陪练: 点「继续」第 ${attempt + 1} 次没反应, 再点一次`, "warning");
      }
      if (!advanced) log("AI陪练: 连点 3 次「继续」都没开始生成, 继续等出题…", "warning");
    }
  } catch (e) {
    log(`AI陪练异常: ${e && e.message}`, "danger");
    stopReason = stopReason || "stopped";
  } finally {
    if (lastRow && !lastRow.correct) {
      const late = readPracticeCorrectLetter(doc);
      if (late) {
        lastRow.correct = late;
        if (panel && typeof panel.patchPracticeItem === "function") panel.patchPracticeItem(lastRow);
        log(`AI陪练: 第 ${lastRow.index} 题补到正确答案 ${late}`, "primary");
      }
    }
    if ((stopReason === "reach-limit" || index >= cfg.maxQuestions) && !run.stopped) {
      const endBtn = practiceEndButton(doc);
      if (endBtn && dispatchPracticeClick(endBtn)) {
        log("AI陪练: 到上限, 已点「结束陪练」", "primary");
        await sleepMs(1200);
        if (confirmPracticeEndPopup(doc)) log("AI陪练: 已点掉结束确认框", "primary");
        await sleepMs(800);
      } else {
        log("AI陪练: 到上限了但没找到「结束陪练」按钮, 请自己点一下", "warning");
      }
    }
    finish();
  }
}

/** 把「AI陪练」页签接到执行器上(默认不自动开跑) */
function setupPractice({ win, log }) {
  const doc = win.document;
  if (!panel) return;
  const prefill = doc.querySelector(PRACTICE_SEL.direction);
  if (prefill && prefill.value) panel.setPracticeDirection(prefill.value);
  panel.setPracticeStatus("未开始");
  panel.setPracticeRunning(false);
  panel.setPracticeProgress(0, 0, "未开始");
  panel.setPracticeStats(practiceStats(null), 0);
  panel.setPracticePoints(countPracticePoints(doc));

  panel.onPracticeWeak = () => {
    const n = selectAllPracticePoints(doc);
    panel.setPracticePoints(n);
    log(`AI陪练: 已点薄弱知识点, 当前选中 ${n} 个`, "primary");
  };
  panel.onPracticeClear = () => {
    const n = clearPracticePoints(doc);
    panel.setPracticePoints(n);
    log(n ? `AI陪练: 清空后还剩 ${n} 个选中(可能不是薄弱知识点)` : "AI陪练: 已取消选中的知识点", "primary");
  };
  panel.onPracticeStart = () => {
    runPractice({ win, log }).catch((e) => log(`AI陪练启动失败: ${e && e.message}`, "danger"));
  };
  panel.onPracticeStop = () => stopPractice(log);
  panel.onPracticeSend = () => {
    if (!answerPracticePending("send")) log("AI陪练: 现在没有等确认的题", "warning");
  };
  panel.onPracticeSkip = () => {
    if (!answerPracticePending("skip")) log("AI陪练: 现在没有等确认的题", "warning");
  };
  panel.onPracticeReport = () => {
    if (!practiceReport) {
      log("AI陪练: 还没有跑过, 没有报告", "warning");
      return;
    }
    panel.showPracticeExport(practiceReportToJson(practiceReport), "AI陪练: 本轮报告已导出(JSON, 不含凭据)");
  };
  panel.onPracticeSample = () => {
    const rows = samplePracticeForReview(practiceReport);
    if (!rows.length) {
      log("AI陪练: 本轮没有错题可抽", "primary");
      return;
    }
    panel.showPracticeExport(formatPracticeSamples(rows), `AI陪练: 已抽 ${rows.length} 道错题`);
  };
}

function setupCourse({ win, log, autoStart = false }) {
  // threshold 走 DEFAULT_PLAY_OPTIONS 的 0.999(必须到片尾): 90% 平台不认账, 2026-11-10 真机验证
  const courseOptions = { rate: panel ? panel.getCourseRate() : 1.5, stopGraceMs: 6000, settleMs: 5000 };
  if (!panel) return; // 非顶层窗口没有面板, 也不跑刷课(避免多帧重复)
  panel.onCourseRate = (r) => {
    courseOptions.rate = r;
  };
  const newPage = isNewCoursePage(win);
  if (newPage) {
    log("检测到新版课程页(泛雅3): 「开始刷课」会自动进入第一个未完成章节", "primary");
  }
  panel.onCourseToggle = (want) => {
    if (want && newPage) {
      const r = startFromNewCoursePage(win, (m, t) => panel.log(m, t));
      if (r.ok) {
        panel.setCourseOn(true);
        panel.setCourseState(`进入「${(r.chapter.title || "").slice(0, 18)}」…`);
        panel.setCourseProgress(`进入「${(r.chapter.title || "").slice(0, 20)}」`, 5);
      } else {
        panel.setCourseOn(false);
      }
      return;
    }
    if (want) {
      courseController = createCxCourseController({
        win,
        options: courseOptions,
        log: (m, t) => panel.log(m, t),
        // 章节测验/作业任务点: 交给答题链(是否交卷看面板设置)
        solveWork: (frameEl, opts) =>
          solveWorkTaskPoint(frameEl, Object.assign({ log: (m, t) => panel.log(m, t) }, opts)),
        onState: (s) => {
          if (!s) return;
          if (s.phase === "enter" && s.item) {
            panel.setCourseState(`进入 ${s.item.title}`);
            panel.setCourseProgress(`进入 ${s.item.title}(待完成 ${s.item.unfinished})`, 10);
          } else if (s.phase === "branch" && s.branch) {
            panel.setCourseState(`分支: ${s.branch.label || s.branch.key}`);
          } else if (s.phase === "scan") {
            panel.setCourseState(`扫描第 ${s.pass} 轮`);
          } else if (s.phase === "settle") {
            panel.setCourseState("等待页面刷新…");
          } else if (s.phase === "done") {
            panel.setCourseState(s.summary || "已完成");
            panel.setCourseProgress(s.summary || "已完成", 100);
          }
          // 进度条: 用 stats 估算(完成分支数 / 本章任务点数)
          const st = s.stats;
          if (st && st.branches) {
            panel.setCourseProgress(`完成 ${st.done} 个分支 / 共 ${st.branches}`, Math.round((st.done / Math.max(1, st.branches)) * 100));
          }
        },
      });
      courseController.start();
      panel.setCourseOn(true);
    } else {
      courseController && courseController.stop();
      panel.setCourseOn(false);
    }
  };
  if (autoStart && !newPage) {
    log("接上一次「开始刷课」: 自动开跑", "primary");
    panel.onCourseToggle(true);
  }
}

/**
 * 智慧树「新形态课程」刷课: 中继控制器挂到面板按钮上。
 * 目录页 ↔ 学习页会整页跳转, 状态在 localStorage 里接力; 第二次打开同一门课会自动继续,
 * 直到「课程视频」全部完成或用户点「停止刷课」。
 */
function setupZhsCourse({ win, log }) {
  if (!panel) return; // 非顶层窗口没有面板, 也不跑刷课(避免重复)
  let relay = null;
  let storage = null;
  try {
    storage = win.localStorage;
  } catch (e) {
    storage = null;
  }
  const onState = (s) => {
    if (!s) return;
    const st = (s.state && s.state.stats) || {};
    const total = st.total || 0;
    const pct = total ? Math.round(((st.done || 0) / total) * 100) : 0;
    if (s.phase === "enter" && s.unit) {
      panel.setCourseState(`进入 ${s.unit.title}`);
      panel.setCourseProgress(`完成 ${st.done || 0}/${total} · ${(s.unit.title || "").slice(0, 16)}`, pct);
    } else if (s.phase === "playing") {
      panel.setCourseState(`播放中 ${Math.round((s.progress || 0) * 100)}%`);
      panel.setCourseProgress(`完成 ${st.done || 0}/${total} · 播放中`, pct);
    } else if (s.phase === "learn") {
      panel.setCourseState("学习页: 等待视频加载…");
    } else if (s.phase === "done") {
      panel.setCourseOn(false);
      panel.setCourseState(s.summary || "已完成");
      panel.setCourseProgress(s.summary || "已完成", 100);
    } else if (s.phase === "stopped" || s.phase === "idle") {
      panel.setCourseOn(false);
    }
  };
  const makeRelay = () =>
    createZhsCourseRelay({
      win,
      storage,
      log: (m, t) => panel.log(m, t),
      options: { rate: panel.getCourseRate() },
      onState,
    });
  const startRelay = () => {
    if (!relay) relay = makeRelay();
    panel.setCourseOn(true);
    if (!relay.start()) panel.setCourseOn(false);
  };
  panel.onCourseToggle = (want) => {
    if (want) {
      startRelay();
    } else {
      relay && relay.stop();
      panel.setCourseOn(false);
    }
  };
  if (isZhsRelayActive(storage)) {
    log("接上一次智慧树刷课: 自动继续(要停就点「停止刷课」)", "warning");
    startRelay();
  } else {
    panel.setCourseOn(false);
  }
}

/** 轮询等待 DOM 就绪(最多 timeoutMs) */
async function waitReady(doc, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (doc.readyState === "complete") return true;
    if (doc.querySelector(".questionLi, .TiMu, .examPaper_subject")) return true;
    await sleepMs(500);
  }
  return false;
}

/** 挂载面板(需 document.body 存在) */
export function mountPanel() {
  if (panel && panel.root) return panel;
  panel = new Panel();
  panel.mount();
  // 抓取按钮栏: 与页面类型无关(答题页/章节页/课件页都能用), 所以挂完面板就接上
  mountHarvestBar(panel, { win: window, log: (m, t) => panel && panel.log(m, t) });
  return panel;
}

/**
 * 直接把面板交给 runtime(生产路径只有 mountPanel() 会调 —— 顶层面板只挂一次)。
 * 单测靠它投喂假面板: 「页面上没有答题页时点 ①②③ 要打警告」这种是面板↔runtime 的接口行为,
 * 只查源码字符串查不出来。
 */
export function usePanel(p) {
  panel = p;
  return panel;
}

/**
 * 单测用: 把模块单例清回初始状态(handler / 路由 / 页面窗口 / 帧 load 监听定时器)。
 * 生产路径不调 —— runtime 每个页面只 bootstrap 一次, 单例就是"当前页面"的状态。
 * 为什么需要: 一个测试文件里连着跑几个章节页场景时, 上一个场景接管到的 handler 会黏住,
 * 后面「没找到答题页」的场景就永远走不到了。
 */
export function resetRuntimeForTest() {
  handler = null;
  pageWin = null;
  currentRoute = null;
  answerState = { questions: [], asked: 0, filled: 0 };
  stopFrameLoadWatch();
}

/** 插件主入口(由合并产物调用) */
export function bootstrap() {
  provider = new PiBridgeProvider();
  const boot = () => {
    if (!document.body) {
      setTimeout(boot, 200);
      return;
    }
    // 只在顶层窗口挂面板(iframe 里照常答题, 但不重复挂 UI)
    let isTop = true;
    try {
      isTop = window.top === window;
    } catch (e) {}
    if (isTop) mountPanel();
    prefetchTable();
    startAnswering({ log: (m, t) => panel && panel.log(m, t) }).catch((e) => panel && panel.log(`运行异常: ${e && e.message}`, "danger"));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
