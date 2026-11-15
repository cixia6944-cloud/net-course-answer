// 刷课编排(S1: 章节任务点遍历) + 视频任务点驱动接线(S2)。
// 设计原则:
//   · 只走 A 路线(自然播放) —— 绝不构造心跳、绝不 seek;
//   · 所有"能对外部产生影响"的动作(点击任务点/找视频文档/播放)都通过注入的适配器,
//     这样纯逻辑可以在 node 里用假 DOM/假适配器跑单测(tools/course-test.mjs);
//   · 完成条件按实测: 观看 ≥ 总时长 90%(cards iframe 原文), 所以到阈值后即可离开。
import { createVideoDriver, DEFAULT_PLAY_OPTIONS } from "./player.js";
// 选择器/结构契约集中管理(改版只改 contract/cx-study-contract.js) —— 采集依据: 一手侦察记录(未随仓库分发)
import { CX_STUDY_SEL, readUnfinished } from "../contract/cx-study-contract.js";

/**
 * 刷课默认选项。
 * 播放类那四个(threshold/rate/mute/tickMs)以 player.js 的 DEFAULT_PLAY_OPTIONS 为唯一来源,
 * 这里只补「刷课编排」专有的键 —— 改倍速/阈值只改一处。
 */
export const DEFAULT_COURSE_OPTIONS = Object.assign({}, DEFAULT_PLAY_OPTIONS, {
  stopGraceMs: 5000, // 到阈值后再等一会儿, 让页面把最后一次心跳发出去
  videoTimeoutMs: 15000, // 等视频 iframe 就绪
  playTimeoutMs: 45 * 60 * 1000, // 单个视频最长播放时长(防止卡死)
  settleMs: 4000, // 完成一个任务点后等页面刷新状态
  maxPasses: 5, // 同一章最多扫几轮(任务点计数可能刷新滞后)
  maxAttemptsPerItem: 2,
  maxBranchTries: 2, // 同一个「分支(任务点)」最多试几次(失败才重试; 成功/无视频即算结束)
});

/* ------------------------------------------------------------------ *
 * S1-1 章节树解析
 * 实测结构(2026-09-10 真机):
 *   <div class="posCatalog_level">(章)
 *      ... <span class="posCatalog_name" onclick="getTeacherAjax('courseId','clazzId','knowledgeId');">1.1 标题</span>
 *          <i class="catalog_points_yi"></i> <span class="jobUnfinishCount">1</span>
 *   未完成数还可能只以文本出现: 「N个待完成任务点」+ 一个数字; 已完成渲染成裸「0」。
 * ------------------------------------------------------------------ */

/**
 * 解析页面上的章节任务点列表。
 * @returns {Array<{index:number,title:string,courseId:string,clazzId:string,knowledgeId:string,unfinished:number,el:Element}>}
 */
export function parseTaskTree(doc) {
  if (!doc || !doc.querySelectorAll) return [];
  const out = [];
  const names = Array.from(doc.querySelectorAll(CX_STUDY_SEL.old.item));
  names.forEach((el, i) => {
    const onclick = (el.getAttribute && el.getAttribute("onclick")) || "";
    const m = /getTeacherAjax\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(onclick);
    if (!m) return; // 不是任务点(可能是章节标题本身)
    const row =
      (el.closest &&
        (el.closest(CX_STUDY_SEL.old.row) || el.closest(CX_STUDY_SEL.old.level) || el.closest("li"))) ||
      el.parentElement ||
      el;
    out.push({
      index: i,
      title: String(el.textContent || "").trim().replace(/\s+/g, " "),
      courseId: m[1],
      clazzId: m[2],
      knowledgeId: m[3],
      unfinished: readUnfinished(row),
      el,
    });
  });
  return out;
}

/** 选下一个要刷的任务点(第一个未完成且没被跳过的) */
export function pickNextUnfinished(items, { skip = new Set(), attempts = new Map(), maxAttempts = Infinity } = {}) {
  for (const it of items) {
    if (!it.unfinished || it.unfinished <= 0) continue;
    if (skip.has(it.knowledgeId)) continue;
    if ((attempts.get(it.knowledgeId) || 0) >= maxAttempts) continue;
    return it;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * S2-1 播放一个视频文档里的视频, 直到"达阈值"或"播完"
 * ------------------------------------------------------------------ */

/**
 * @param {Document} vdoc 视频任务点 iframe 的 document
 * @param {Object} cfg { threshold, rate, mute, tickMs, timeoutMs, graceMs, log, onProgress, driverFactory }
 * @returns {Promise<{ok:boolean, reason:string, progress:number}>}
 */
export function playVideoDoc(vdoc, cfg = {}) {
  const o = Object.assign({}, DEFAULT_COURSE_OPTIONS, cfg);
  return new Promise((resolve) => {
    let settled = false;
    let graceTimer = null;
    let timeoutTimer = null;
    let driver = null;
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const progress = driver ? driver.state().lastProgress : 0;
      if (driver) driver.stop();
      if (cfg.onDriver) cfg.onDriver(null, null);
      if (reason === "stopped") {
        // "停止刷课"要立刻停画面(不是等这个视频播完)
        const v = driver && driver.video && driver.video();
        if (v) {
          try {
            v.pause();
          } catch (e) {}
        }
      }
      resolve({ ok, reason, progress });
    };
    const factory = cfg.driverFactory || createVideoDriver;
    driver = factory({
      doc: vdoc,
      log: cfg.log || (() => {}),
      options: { rate: o.rate, mute: o.mute, threshold: o.threshold, tickMs: o.tickMs, guard: true },
      onReady: (p) => {
        if (graceTimer) return;
        cfg.log && cfg.log(`观看已达 ${(p * 100).toFixed(1)}%, ${Math.round(o.stopGraceMs / 1000)}s 后进入下一节`);
        graceTimer = setTimeout(() => done(true, "threshold"), o.stopGraceMs);
      },
      onEnded: () => done(true, "ended"),
      onProgress: cfg.onProgress,
    });
    // 把"立即中止"的句柄交给调用方(面板点停止时用, 免得卡到超时)
    if (cfg.onDriver) cfg.onDriver(driver, (reason) => done(false, reason || "stopped"));
    if (!driver.start()) return done(false, "no-video");
    timeoutTimer = setTimeout(() => done(false, "timeout"), o.playTimeoutMs);
  });
}

/* ------------------------------------------------------------------ *
 * S1-2 编排状态机(适配器注入 → 可单测)
 * ------------------------------------------------------------------ */

/**
 * @param {Object} cfg
 * @param {Document} cfg.doc 顶层章节页文档
 * @param {Function} cfg.enterItem (item) => Promise<void>  点击/切换任务点
 * @param {Function} cfg.waitVideoDoc (item, timeoutMs) => Promise<Document|null>  等视频 iframe
 * @param {Function} cfg.playVideo (vdoc, item) => Promise<{ok,reason}>  默认用 playVideoDoc
 * @param {Function} [cfg.handleNonVideo] (item, branch) => Promise<{ok,reason,note}>  非视频分支(课件等)的处理器
 * @param {Function} [cfg.parse] () => items  默认 parseTaskTree(doc)
 * @param {Function} [cfg.sleep] (ms) => Promise
 * @param {Function} [cfg.log] (msg, type)
 * @param {Function} [cfg.onState] (state) => void  面板状态回调
 */
export function createCourseRunner(cfg = {}) {
  const o = Object.assign({}, DEFAULT_COURSE_OPTIONS, cfg.options || {});
  const log = cfg.log || (() => {});
  const sleep = cfg.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const parse = cfg.parse || (() => parseTaskTree(cfg.doc));
  const waitVideoDoc = cfg.waitVideoDoc || (async () => null);
  const listTabs = cfg.listTaskTabs || (async () => []);
  const activateTab = cfg.activateTab || (async () => {});
  let stopped = false;
  let running = false;
  let activeAbort = null; // 当前视频的"立即中止"句柄(由 playVideoDoc 给出)
  const stats = { done: 0, failed: 0, skippedBranch: 0, skippedItem: 0, branches: 0, passes: 0, total: 0 };
  /** 分支状态: key = knowledgeId + "|" + 分支key → { ok, tries } */
  const branchState = new Map();
  /** 见过的分支 key(去重 —— 面板进度条的分母; 多轮扫描不能重复累加) */
  const branchKeys = new Set();

  const emit = (state) => cfg.onState && cfg.onState(Object.assign({ stats, running, stopped }, state));

  const setDriver = (d, abort) => {
    activeAbort = abort || null;
  };

  async function playVideo(vdoc, item) {
    if (cfg.playVideo) return cfg.playVideo(vdoc, item, { onDriver: setDriver });
    return playVideoDoc(vdoc, {
      onDriver: setDriver,
      threshold: o.threshold,
      rate: o.rate,
      mute: o.mute,
      tickMs: o.tickMs,
      stopGraceMs: o.stopGraceMs,
      playTimeoutMs: o.playTimeoutMs,
      log,
      driverFactory: cfg.driverFactory,
    });
  }

  async function run() {
    if (running) return stats;
    running = true;
    stopped = false;
    const attempts = new Map();
    const skip = new Set();
    log("开始刷课(自然播放模式, 不伪造心跳)", "primary");
    try {
      for (let pass = 1; pass <= o.maxPasses && !stopped; pass++) {
        stats.passes = pass;
        const items = parse();
        stats.total = items.length;
        const pending = items.filter((i) => i.unfinished > 0);
        log(`第 ${pass} 轮: 共 ${items.length} 个任务点, 未完成 ${pending.length} 个`);
        emit({ phase: "scan", pass });
        if (!pending.length) {
          log("✅ 本页任务点都已完成", "success");
          break;
        }
        const progressed = await runPass(items, { skip, attempts });
        if (!progressed && pass > 1) {
          log("本轮没有新完成的任务点, 收工", "warning");
          break;
        }
        if (progressed) log(`第 ${pass} 轮结束: 累计完成 ${stats.done} 个`, "primary");
      }
    } finally {
      running = false;
      const summary = `刷课结束: 完成 ${stats.done} 个分支, 失败 ${stats.failed} 个分支, 非视频分支 ${stats.skippedBranch} 个, 放弃目录项 ${stats.skippedItem} 个`;
      log(summary, stats.failed ? "warning" : "success");
      emit({ phase: "done", summary });
    }
    return stats;
  }

  /** 一轮扫描: 逐个未完成目录项 → 处理它的所有分支。返回本轮是否有新完成的任务点 */
  async function runPass(items, { skip, attempts }) {
    let progressed = false;
    for (;;) {
      if (stopped) break;
      const fresh = cfg.reparseEachItem === false ? items : parse();
      const target = pickNextUnfinished(fresh, { skip, attempts, maxAttempts: o.maxAttemptsPerItem });
      if (!target) break;
      attempts.set(target.knowledgeId, (attempts.get(target.knowledgeId) || 0) + 1);
      emit({ phase: "enter", item: target });
      log(`▶ 进入任务点: ${target.title}(待完成 ${target.unfinished})`);
      try {
        await cfg.enterItem(target);
      } catch (e) {
        log(`进入任务点失败: ${e && e.message}`, "warning");
      }
      if (stopped) break;

      const r = await handleItem(target);
      if (r.itemProgress) progressed = true;
      // 所有分支都已处理完(成功 / 无视频 / 重试用尽) → 整项不再重进, 避免空转
      if (r.allHandled) {
        skip.add(target.knowledgeId);
        if (!r.itemProgress) stats.skippedItem++;
      }
    }
    return progressed;
  }

  /**
   * 一个目录项: 枚举它下面的分支(任务点)并逐个处理。
   * 实测一个目录项可含多个分支(有的章节 4 个待完成任务点) —— 旧代码只看第一个,
   * 碰上文文档/课件分支就把整章跳过, 这就是"多个小分支被略过"的根因。
   */
  async function handleItem(target) {
    let branches = [];
    try {
      branches = (await listTabs(target)) || [];
    } catch (e) {
      log(`枚举分支失败: ${e && e.message}`, "warning");
    }
    if (!branches.length) branches = [{ key: "__single__", label: target.title, el: null }];
    branches.forEach((br) => branchKeys.add(`${target.knowledgeId}|${br.key}`));
    stats.branches = branchKeys.size;
    const todo = branches.filter((b) => b.done !== true).length;
    if (branches.length > 1) {
      log(`该章节有 ${branches.length} 个任务点(待处理 ${todo} 个), 逐个处理`);
    }

    let itemProgress = false;
    for (const br of branches) {
      if (stopped) break;
      const st = branchState.get(`${target.knowledgeId}|${br.key}`);
      if (st && (st.ok || st.tries >= o.maxBranchTries)) continue; // 已经处理过 → 不重复进
      const r = await handleBranch(target, br);
      if (r.done) itemProgress = true;
      emit({ phase: "settle", item: target });
      await sleep(o.settleMs);
    }

    const allHandled = branches.every((br) => {
      const st = branchState.get(`${target.knowledgeId}|${br.key}`);
      return st && (st.ok || st.tries >= o.maxBranchTries);
    });
    return { allHandled, itemProgress };
  }

  /**
   * 一个分支(任务点): 切换 → 等它自己的视频 → 自然播放;
   * 不是视频就交给 handleNonVideo(课件翻页等); 失败在本次进入内重试(maxBranchTries)。
   */
  async function handleBranch(target, br) {
    const bkey = `${target.knowledgeId}|${br.key}`;
    const st = branchState.get(bkey) || { ok: false, tries: 0 };
    branchState.set(bkey, st);
    const shortLabel = br.label || br.key;
    if (br.done === true) {
      // 采集实测: cards 页 `aria-label="任务点已完成"` 的任务点不用重播
      st.ok = true;
      log(`  ↳ ${shortLabel} 已完成, 跳过`);
      return { done: false };
    }
    emit({ phase: "branch", item: target, branch: br });
    let done = false;
    while (!stopped && !st.ok && st.tries < o.maxBranchTries) {
      if (br.el) {
        try {
          await activateTab(br);
        } catch (e) {
          log(`切换分支失败: ${e && e.message}`, "warning");
        }
      }
      log(`  ↳ 分支 ${shortLabel}${st.tries ? `(重试 ${st.tries + 1}/${o.maxBranchTries})` : ""}`);
      const vdoc = await waitVideoDoc(target, o.videoTimeoutMs, br);
      if (stopped) break;
      if (!vdoc) {
        const handled = await runNonVideo(target, br);
        // 用户点了「停止」: 处理器应当已经收尾(翻页循环看 shouldStop), 这一支不计完成/跳过。
        if (stopped) break;
        st.ok = true; // 既非视频也处理不了: 本分支结束, 但不放弃整个目录项
        if (handled.ok) {
          stats.done++;
          done = true;
          log(`✔ 完成: ${br.label || target.title}${handled.note ? "(" + handled.note + ")" : ""}`, "success");
        } else {
          stats.skippedBranch++;
          log(`  ↳ 该分支没有可自动处理的媒体${handled.reason ? "(" + handled.reason + ")" : ""}, 记下继续`, "warning");
          await sleep(800);
        }
        break;
      }
      const r = await playVideo(vdoc, target);
      if (stopped) break;
      st.tries++;
      if (r && r.ok) {
        // 本地进度条到片尾 ≠ 平台认账: 让适配器去问平台(超星 90% 不解锁, 2026-11-10 真机)
        let confirmed;
        if (cfg.verifyBranchDone) {
          try {
            confirmed = await cfg.verifyBranchDone(br, target);
          } catch (e) {
            confirmed = undefined;
          }
        }
        if (stopped) break;
        if (confirmed === false) {
          // 不重播(视频已在片尾, 重放一遍是白烧时间); 平台没记上就如实说, 下一轮进这块会再核对
          st.ok = true;
          stats.failed++;
          log(`✖ 播完了, 平台仍显示「任务点未完成」(可能站点没记上), 先放这一支`, "warning");
          break;
        }
        st.ok = true;
        stats.done++;
        done = true;
        const tail = br.label && br.label !== target.title ? ` · ${br.label}` : "";
        log(`✔ 完成: ${target.title}${tail}${r.reason === "threshold" ? "(到片尾阈值)" : "(播完)"}`, "success");
      } else {
        stats.failed++;
        const left = st.tries < o.maxBranchTries;
        log(`✖ 未完成分支: ${shortLabel}(${(r && r.reason) || "未知原因"})${left ? ", 重试一次" : ", 放弃该分支"}`, "warning");
        if (left) await sleep(2000);
      }
    }
    return { done };
  }

  /** 非视频分支: 交给注入的处理器(如课件自动翻页 S4); 没处理器就算跳过 */
  async function runNonVideo(target, br) {
    if (!cfg.handleNonVideo) return { ok: false, reason: "" };
    try {
      const r = await cfg.handleNonVideo(target, br, { log, stats, shouldStop: () => stopped });
      return r || { ok: false, reason: "" };
    } catch (e) {
      log(`  ↳ 非视频分支处理异常: ${e && e.message}`, "warning");
      return { ok: false, reason: "" };
    }
  }

  return {
    run,
    stop() {
      stopped = true;
      if (typeof activeAbort === "function") {
        const abort = activeAbort;
        activeAbort = null;
        log("已停止刷课: 立刻停掉当前视频", "warning");
        try {
          abort("stopped");
        } catch (e) {}
      } else {
        log("已请求停止刷课(当前没有正在播放的视频)", "warning");
      }
    },
    isRunning: () => running,
    stats: () => Object.assign({}, stats),
  };
}
