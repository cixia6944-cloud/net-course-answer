// 智慧树「新形态课程」刷课中继（ai-smart-course-student-pro.zhihuishu.com）。
//
// 与超星章节页的差别（2026-11-09 真机实测）：
//   · 课程目录页 /singleCourse/knowledgeStudy/<courseId>/<clazzId> 的「课程视频」模块
//     就是任务清单：58 个知识单元，每个带「学习进度 N%」；单元点开后跳到
//     /learnPage/<courseId>/<knowledgeId>/<clazzId>，页面里是普通 video.js 播放器
//     （video.vjs-tech，mp4 直链），不是 iframe。
//   · 点单元 = 整页跳转（Vue 路由但会重建页面），所以刷课状态不能只放内存：
//     这里用 localStorage 记一条中继状态，目录页 ↔ 学习页来回跳时接力。
//
// 原则与超星一致：自然播放、不伪造心跳、不 seek。到片尾（或 99.9%）才算完成，
// 再回目录页核对「学习进度」是否变成 100%，没变就重进一次（最多 maxAttempts 次）。
import { createVideoDriver } from "../core/player.js";

export const ZHS_COURSE_STATE_KEY = "nca.zhsCourse.v2";
export const ZHS_STATE_TTL_MS = 6 * 60 * 60 * 1000; // 超过 6 小时的中继状态视为过期

/** 解析智慧树新形态课程的 URL。返回 {mode, courseId, clazzId, knowledgeId} 或 null。 */
export function parseZhsCourseRoute(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch (e) {
    return null;
  }
  if (!/(^|\.)zhihuishu\.com$/i.test(u.hostname)) return null;
  const p = u.pathname;
  let m = /^\/singleCourse\/knowledgeStudy\/(\d+)\/(\d+)/.exec(p);
  if (m) return { mode: "catalog", courseId: m[1], clazzId: m[2] };
  m = /^\/learnPage\/(\d+)\/(\d+)\/(\d+)/.exec(p);
  if (m) return { mode: "learn", courseId: m[1], knowledgeId: m[2], clazzId: m[3] };
  m = /^\/singleCourse\/afterClassReview\/(\d+)\/(\d+)/.exec(p);
  if (m) return { mode: "review", courseId: m[1], clazzId: m[2] };
  m = /^\/singleCourse\/taskAndExam\/(\d+)\/(\d+)/.exec(p);
  if (m) return { mode: "tasks", courseId: m[1], clazzId: m[2] };
  if (p === "/weakTest") {
    const q = u.searchParams;
    return { mode: "weakTest", courseId: q.get("courseId") || "", clazzId: q.get("classId") || "" };
  }
  // 复习测试/考试页(2026-11-09 真机): studentexamcomh5.zhihuishu.com/studentReviewTestOrExam/<paper>/...
  // 一页一题, 有答题卡和「提交作业」; courseId 藏在第 4 段路径里。
  if (u.hostname === "studentexamcomh5.zhihuishu.com" && p.startsWith("/studentReviewTestOrExam/")) {
    const m2 = /^\/studentReviewTestOrExam\/[^/]+\/[^/]+\/[^/]+\/(\d+)/.exec(p);
    const q = u.searchParams;
    return {
      mode: "reviewTest",
      courseId: m2 ? m2[1] : "",
      clazzId: q.get("classId") || "",
      paperId: q.get("paperId") || "",
    };
  }
  return null;
}

/** 是否新形态课程的刷课页（目录 / 学习页） */
export function isZhsCourseRunPage(url) {
  const r = parseZhsCourseRoute(url);
  return !!r && (r.mode === "catalog" || r.mode === "learn");
}

/** 目录 URL */
export function makeZhsCatalogUrl(state, origin) {
  return `${origin || "https://ai-smart-course-student-pro.zhihuishu.com"}/singleCourse/knowledgeStudy/${state.courseId}/${state.clazzId}`;
}

/** 学习页 URL */
export function makeZhsLearnUrl(state, knowledgeId, origin) {
  return `${origin || "https://ai-smart-course-student-pro.zhihuishu.com"}/learnPage/${state.courseId}/${knowledgeId}/${state.clazzId}`;
}

/**
 * 从目录页解析「课程视频」模块的知识单元（真机结构）：
 *   .knowledge-content > div（模块块）
 *     .content-list-title → 模块名（这里取含「课程视频」的那块）
 *     .item-content[knowledgeid] × N
 *       .item-title（title 属性是全称）
 *       .progress-num（"0%" / "100%"）
 * @returns {Array<{id:string,title:string,progress:number,el:Element}>}
 */
export function parseZhsVideoUnits(doc) {
  if (!doc || !doc.querySelectorAll) return [];
  const blocks = Array.from(doc.querySelectorAll(".knowledge-content > div"));
  if (!blocks.length) return [];
  const block =
    blocks.find((b) => /课程视频/.test((b.querySelector(".content-list-title") || {}).textContent || "")) || blocks[0];
  return Array.from(block.querySelectorAll(".item-content")).map((el) => {
    const titleEl = el.querySelector(".item-title");
    const pctEl = el.querySelector(".progress-num");
    const raw = ((pctEl && pctEl.textContent) || "").replace(/\s+/g, "");
    const n = parseFloat(raw);
    return {
      id: el.getAttribute("knowledgeid") || String(el.id || "").replace(/^knowledgeId-/, ""),
      title: ((titleEl && (titleEl.getAttribute("title") || titleEl.textContent)) || "").trim(),
      progress: Number.isFinite(n) ? n : 0,
      el,
    };
  }).filter((u) => u.id);
}

/** 下一个要刷的单元（纯函数，便于单测）：跳过已完成 / 已放弃 / 重试用尽 / 进度 100% */
export function pickNextZhsUnit(units, state) {
  const done = new Set((state && state.done) || []);
  const skipped = new Set((state && state.skipped) || []);
  const attempts = (state && state.attempts) || {};
  const max = (state && state.maxAttempts) || 2;
  for (const u of units || []) {
    if (!u || !u.id) continue;
    if (done.has(u.id) || skipped.has(u.id)) continue;
    if (u.progress >= 100) continue;
    if ((attempts[u.id] || 0) >= max) continue;
    return u;
  }
  return null;
}

/** 新建中继状态 */
export function newZhsCourseState(courseId, clazzId, opts = {}) {
  return {
    v: 2,
    courseId: String(courseId || ""),
    clazzId: String(clazzId || ""),
    auto: true,
    savedAt: 0,
    current: null,
    pendingDone: null,
    done: [],
    skipped: [],
    attempts: {},
    stats: { done: 0, failed: 0, total: 0 },
    maxAttempts: opts.maxAttempts || 2,
    rate: opts.rate || 1.5,
  };
}

/** 读中继状态（过期 / 版本不符 / 损坏 → null） */
export function loadZhsState(storage, now = Date.now()) {
  try {
    const raw = storage && storage.getItem(ZHS_COURSE_STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.v !== 2 || !s.courseId || !s.clazzId) return null;
    if (!Number.isFinite(s.savedAt) || now - s.savedAt > ZHS_STATE_TTL_MS) {
      try {
        storage.removeItem(ZHS_COURSE_STATE_KEY);
      } catch (e) {}
      return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

export function saveZhsState(storage, state) {
  try {
    state.savedAt = Date.now();
    storage && storage.setItem(ZHS_COURSE_STATE_KEY, JSON.stringify(state));
  } catch (e) {}
}

export function clearZhsState(storage) {
  try {
    storage && storage.removeItem(ZHS_COURSE_STATE_KEY);
  } catch (e) {}
}

/** 是否有「正在刷」的中继（页面加载后据此自动接力） */
export function isZhsRelayActive(storage, now = Date.now()) {
  const s = loadZhsState(storage, now);
  return !!(s && s.auto);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(doc, sel, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const el = doc.querySelector(sel);
      if (el) return resolve(el);
      if (Date.now() - t0 >= timeoutMs) return resolve(null);
      setTimeout(tick, 400);
    };
    tick();
  });
}

/**
 * 刷课控制器。每个页面加载时 start() 一次，靠 localStorage 中继：
 *   目录页 → 选下一个未完成单元 → 跳学习页
 *   学习页 → 等视频 → 自然播完 → 等页面存进度 → 回目录页
 *   目录页 → 核对进度是否 100% → 是则记完成，否则重进（有次数上限）
 */
export function createZhsCourseRelay({ win, storage, log = () => {}, onState = () => {}, options = {} } = {}) {
  const o = Object.assign(
    {
      rate: 1.5,
      mute: true,
      threshold: 1, // 片尾才算完成；不提前离开
      tickMs: 1000,
      videoWaitMs: 30000,
      catalogWaitMs: 15000,
      settleMs: 9000,
      playTimeoutMs: 90 * 60 * 1000,
      maxAttempts: 2,
    },
    options || {}
  );
  let running = false;
  let stopped = false;
  let driver = null;

  const doc = () => win.document;
  const emit = (state, extra) => onState(Object.assign({ state, running }, extra || {}));
  const origin = () => {
    try {
      return win.location.origin;
    } catch (e) {
      return "";
    }
  };

  function start() {
    if (running) return false;
    const route = parseZhsCourseRoute(win.location.href);
    if (!route || (route.mode !== "catalog" && route.mode !== "learn")) {
      log("当前页面不是智慧树课程的目录页/学习页", "warning");
      return false;
    }
    running = true;
    stopped = false;
    let state = loadZhsState(storage);
    if (!state || state.courseId !== route.courseId || state.clazzId !== route.clazzId) {
      state = newZhsCourseState(route.courseId, route.clazzId, { maxAttempts: o.maxAttempts, rate: o.rate });
    }
    state.auto = true;
    state.rate = o.rate;
    state.maxAttempts = o.maxAttempts;
    saveZhsState(storage, state);
    emit(state, { phase: "start", route });
    log(`🔄 智慧树刷课中继启动（${state.stats.done} 个已记录完成）`, "primary");
    const flow = route.mode === "learn" ? runLearn(route, state) : runCatalog(route, state);
    flow
      .catch((e) => {
        running = false;
        log(`刷课异常: ${e && e.message}`, "danger");
      })
      .then(() => {
        if (!running) emit(state, { phase: "idle" });
      });
    return true;
  }

  /** 目录页：核对上一单元 → 选下一个 → 跳学习页 / 收工 */
  async function runCatalog(route, state) {
    await waitFor(doc(), ".knowledge-content .item-content", o.catalogWaitMs);
    if (stopped) return;
    const units = parseZhsVideoUnits(doc());
    if (!units.length) {
      running = false;
      log("没解析到「课程视频」的知识单元（目录可能没加载完），本次停止", "danger");
      emit(state, { phase: "error" });
      return;
    }
    state.stats.total = units.length;

    // 核对上一单元：页面刷新后进度可能晚一拍，所以以目录页为准
    if (state.pendingDone) {
      const u = units.find((x) => x.id === state.pendingDone);
      if (u && u.progress >= 100) {
        if (!state.done.includes(u.id)) state.done.push(u.id);
        state.stats.done = state.done.length;
        log(`✔ 已确认完成: ${u.title}（${state.done.length}/${units.length}）`, "success");
      } else if (u && (state.attempts[u.id] || 0) >= o.maxAttempts) {
        if (!state.skipped.includes(u.id)) state.skipped.push(u.id);
        state.stats.failed = state.skipped.length;
        log(`✖ 重试 ${o.maxAttempts} 次进度仍未刷新，放弃: ${u.title}`, "warning");
      } else if (u) {
        log(`进度还是 ${u.progress}%，再进一次: ${u.title}`, "warning");
      }
      state.pendingDone = null;
    }

    const next = pickNextZhsUnit(units, state);
    if (!next) {
      running = false;
      state.auto = false;
      state.finishedAt = Date.now();
      saveZhsState(storage, state);
      const msg = `课程视频已全部完成（${state.done.length}/${units.length}，放弃 ${state.skipped.length}）`;
      log(`✅ ${msg}`, "success");
      emit(state, { phase: "done", summary: msg });
      return;
    }

    state.current = next.id;
    state.attempts[next.id] = (state.attempts[next.id] || 0) + 1;
    saveZhsState(storage, state);
    emit(state, { phase: "enter", unit: next });
    log(`▶ 第 ${state.done.length + 1}/${units.length} 个: ${next.title}（第 ${state.attempts[next.id]} 次）`, "primary");
    win.location.href = makeZhsLearnUrl(state, next.id, origin());
  }

  /** 学习页：等视频 → 自然播完 → 回目录页核对 */
  async function runLearn(route, state) {
    const kid = route.knowledgeId;
    if (state.current && state.current !== kid) {
      log("浏览器当前单元与中继记录不一致，以地址栏为准", "warning");
    }
    state.current = kid;
    saveZhsState(storage, state);
    emit(state, { phase: "learn", transition: true });

    log("等待视频加载…", "primary");
    const video = await waitForVideo(doc(), o.videoWaitMs);
    if (stopped) return;
    if (!video) {
      log("这个单元没有视频（可能「建设中」），跳过", "warning");
      if (!state.skipped.includes(kid)) state.skipped.push(kid);
      state.stats.failed = state.skipped.length;
      state.current = null;
      saveZhsState(storage, state);
      goCatalog(state);
      return;
    }

    const title = currentVideoTitle(doc()) || kid;
    log(`▶ 播放: ${title}（${formatDuration(video.duration)}，${o.rate}x${o.mute ? "，静音" : ""}）`, "primary");
    const r = await playToEnd(video);
    if (stopped) return;
    state.current = null;
    if (!r.ok) {
      log(`✖ 播放未完成（${r.reason}），交回目录页重试`, "warning");
      saveZhsState(storage, state);
      goCatalog(state);
      return;
    }
    log(`✔ 播放结束，等 ${Math.round(o.settleMs / 1000)}s 让页面保存进度`, "success");
    await sleep(o.settleMs);
    if (stopped) return;
    state.pendingDone = kid;
    saveZhsState(storage, state);
    goCatalog(state);
  }

  function goCatalog(state) {
    win.location.href = makeZhsCatalogUrl(state, origin());
  }

  /** 驱动一个视频到片尾（或阈值），返回 {ok, reason} */
  function playToEnd(video) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let timeout = null;
      const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        if (timeout) clearTimeout(timeout);
        try {
          driver && driver.stop();
        } catch (e) {}
        resolve({ ok, reason, progress: driver ? driver.state().lastProgress : 0 });
      };
      driver = createVideoDriver({
        doc: doc(),
        log: (m) => log(m),
        options: { rate: o.rate, mute: o.mute, threshold: o.threshold, tickMs: o.tickMs, guard: true },
        onEnded: () => finish(true, "ended"),
        onReady: (p) => {
          if (p >= o.threshold) finish(true, "threshold");
        },
        onProgress: (p) => emit(loadZhsState(storage) || { stats: {} }, { phase: "playing", progress: p }),
      });
      if (!driver.start()) {
        finish(false, "no-video");
        return;
      }
      timer = setInterval(() => {
        if (stopped) finish(false, "stopped");
      }, 1000);
      timeout = setTimeout(() => finish(false, "timeout"), o.playTimeoutMs);
    });
  }

  function stop() {
    stopped = true;
    running = false;
    try {
      driver && driver.stop();
    } catch (e) {}
    const state = loadZhsState(storage);
    if (state) {
      state.auto = false;
      state.stoppedAt = Date.now();
      saveZhsState(storage, state);
    }
    log("已停止刷课（再点「开始刷课」会从第一个未完成单元继续）", "warning");
    if (state) emit(state, { phase: "stopped" });
  }

  return { start, stop, isRunning: () => running };
}

/** 等页面里出现 video 元素（新形态课程的播放器要几秒才挂上） */
export function waitForVideo(doc, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const v = doc && doc.querySelector("video");
      if (v) return resolve(v);
      if (Date.now() - t0 >= timeoutMs) return resolve(null);
      setTimeout(tick, 400);
    };
    tick();
  });
}

/** 播放器上方/资源卡里的视频标题（只用于日志） */
export function currentVideoTitle(doc) {
  const el =
    doc.querySelector(".basic-info-video-card-container .video-title") ||
    doc.querySelector(".video-title") ||
    doc.querySelector(".video-info h5");
  return ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
}

export function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "时长未知";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
