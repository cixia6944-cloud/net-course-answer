// 视频任务点驱动器(A 路线: 自然播放)。
// 只做「播/静音/倍速/防暂停/播完回调」, **绝不**伪造心跳、绝不 seek(isdrag 必须是 0)。
// 设计成可注入 doc, 便于在 node 里用假 DOM 做单元测试(tools/player-test.mjs)。
//
// 已核实的事实(超星 2026-09, 见 文档\刷课调研与方案.md §三):
//   · 播放器是 video.js, 视频元素 id = #video_html5_api, 类名 .vjs-tech
//   · 完成条件:「观看时长需 ≥ 总时长的 90%」(未完成前不可拖拽)
//   · 心跳 multimedia/log 由页面自己上报, 我们一行都不碰
import { CX_STUDY_SEL } from "../contract/cx-study-contract.js";

/**
 * 播放相关的「共享默认值」—— 唯一来源。
 * core/course.js 的 DEFAULT_COURSE_OPTIONS 以它为基底再补刷课专有键,
 * 避免同一批值(rate/mute/threshold/tickMs)在两处各写一遍、改一处漏一处。
 */
export const DEFAULT_PLAY_OPTIONS = {
  rate: 1.5, // 默认倍速(建议 1.0–2.0; 超过 2 倍速风控观感差)
  mute: true,
  threshold: 0.999, // 完成阈值: 必须到片尾
  // 2026-11-10 真机纠错: 原来写 0.9(「超星要求 ≥90%」)—— 实测 1.3 课程视频播到 90.8%,
  // 平台上图标仍是「任务点未完成」, 目录里的待完成数也没减。超星是按**看完**记的,
  // 90% 只够我们停手, 不够让平台认账。现在留 0.999 给"ended 没触发但确实到片尾"兜底。
  tickMs: 1000, // 看门狗/进度检查周期
  stallMs: 12000, // 「在播但时钟不走」多久算异常(后台标签会被节流; 真机 143s 视频跑成 8m50s)
};

/** 视频驱动器(configVideoDriver)的默认选项 = 共享默认值 + 驱动器专有 */
export const DEFAULT_PLAYER_OPTIONS = Object.assign({}, DEFAULT_PLAY_OPTIONS, {
  maxRate: 2,
  minRate: 1,
  guard: true, // 防暂停: 被外部暂停后自动恢复
});

const clampRate = (r, min, max) => {
  const n = Number(r);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};

/** 视频元素候选选择器(单源: 契约表) —— 改版只改契约表 */
const VIDEO_SELECTORS = CX_STUDY_SEL.video.element;

/**
 * 找一个视频元素。优先 video.js 的 id, 再退到通用选择器。
 * @param {Document|Object} doc
 */
export function findVideoElement(doc) {
  if (!doc || !doc.querySelector) return null;
  for (const sel of VIDEO_SELECTORS) {
    try {
      const el = doc.querySelector(sel);
      if (el && el.tagName && String(el.tagName).toUpperCase() === "VIDEO") return el;
    } catch (e) {}
  }
  try {
    const list = doc.querySelectorAll("video");
    if (list && list.length) return list[0];
  } catch (e) {}
  return null;
}

/**
 * 创建视频驱动器。
 * @param {Object} cfg
 * @param {Document} [cfg.doc] 承载视频的文档(视频任务点 iframe 的 document)
 * @param {Function} [cfg.log]
 * @param {Function} [cfg.onProgress] (progress, state) => void
 * @param {Function} [cfg.onReady] 观看达阈值时回调一次
 * @param {Function} [cfg.onEnded] 播完回调
 * @param {Function} [cfg.onReattach] 视频元素被换掉时回调(可用来重新挂载)
 * @param {Object} [cfg.options]
 */
export function createVideoDriver(cfg = {}) {
  const { doc = typeof document !== "undefined" ? document : null, log = () => {} } = cfg;
  const opts = Object.assign({}, DEFAULT_PLAYER_OPTIONS, cfg.options || {});
  const state = {
    video: null,
    started: false,
    ready: false,
    ended: false,
    playCalls: 0,
    resumeCount: 0,
    rate: opts.rate,
    lastProgress: 0,
    reason: "init",
    lastMediaTime: -1,
    stallSince: 0,
    lastStallLog: 0,
    pauseBlocks: 0,
    lastPauseBlockLog: 0,
  };
  let timer = null;
  let videojsPatched = null;

  /** 「拦下暂停」日志限流: 站点连丢几次 pause 时别刷屏(5 秒内只打一行, 带次数) */
  function noteBlockedPause(tag) {
    const nowP = Date.now();
    state.pauseBlocks = (state.pauseBlocks || 0) + 1;
    if (nowP - (state.lastPauseBlockLog || 0) < 5000) return;
    const n = state.pauseBlocks;
    log(`[刷课] 拦下视频暂停${tag}${n > 1 ? ` (5s 内 ${n} 次)` : ""}`);
    state.lastPauseBlockLog = nowP;
    state.pauseBlocks = 0;
  }

  /** 尽量把 video.js 播放器实例上的 pause 也拦下来(拿不到就跳过) */
  function patchVideojsPlayer(video) {
    try {
      const win = doc && doc.defaultView;
      const videojs = win && win.videojs;
      if (!videojs || !videojs.getPlayers) return;
      const players = videojs.getPlayers();
      for (const id in players) {
        const p = players[id];
        if (!p || !p.el || !p.el().contains(video)) continue;
        if (!p.__ncaPatched) {
          const orig = p.pause.bind(p);
          p.__ncaOriginalPause = orig;
          p.pause = function (...a) {
            if (opts.guard && state.started) {
              state.resumeCount++;
              noteBlockedPause("(video.js)");
              return;
            }
            return orig(...a);
          };
          p.__ncaPatched = true;
        }
        videojsPatched = p;
      }
    } catch (e) {}
  }

  /** 覆盖元素自身的 pause: 外部(页面/控件)暂停一律恢复 */
  function patchPause(video) {
    if (video.__ncaPatched) return;
    const orig = typeof video.pause === "function" ? video.pause.bind(video) : () => {};
    video.__ncaOriginalPause = orig;
    video.pause = function (...a) {
      if (opts.guard && state.started) {
        state.resumeCount++;
        noteBlockedPause("");
        try {
          video.play();
        } catch (e) {}
        return;
      }
      return orig(...a);
    };
    video.__ncaPatched = true;
    patchVideojsPlayer(video);
  }

  function applyRate() {
    const v = state.video;
    if (!v) return;
    const want = clampRate(state.rate, opts.minRate, opts.maxRate);
    if (want == null) return;
    try {
      if (v.playbackRate !== want) v.playbackRate = want;
    } catch (e) {}
  }

  function applyMute() {
    const v = state.video;
    if (!v) return;
    try {
      if (v.muted !== !!opts.mute) v.muted = !!opts.mute;
      if (opts.mute) v.volume = 0;
    } catch (e) {}
  }

  function progressOf(v) {
    const d = Number(v.duration);
    const t = Number(v.currentTime);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t)) return 0;
    return Math.min(1, Math.max(0, t / d));
  }

  function play() {
    const v = state.video;
    if (!v) return false;
    state.playCalls++;
    try {
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch((e) => log("[刷课] 播放被拒绝: " + (e && e.message)));
    } catch (e) {
      log("[刷课] play 异常: " + (e && e.message));
    }
    return true;
  }

  /** 看门狗 + 进度检查(测试里可直接调用, 不必等定时器) */
  function tick() {
    if (!state.started) return;
    const found = findVideoElement(doc);
    if (!found) return;
    if (found !== state.video) {
      log("[刷课] 视频元素已更换, 重新挂载");
      attach(found);
      if (cfg.onReattach) cfg.onReattach(found);
    }
    const v = state.video;
    const p = progressOf(v);
    // 时钟看门狗: "在播"但 currentTime 不走 = 标签被挂后台, 媒体时钟和计时器都被节流。
    // 只拦 paused 抓不到这种情况(真机: 后台标签里 143s 的视频跑了 8m50s)。
    if (!v.paused && !state.ended) {
      const nowTick = Date.now();
      const stallMs = Number(opts.stallMs) || 12000;
      const tMedia = Number(v.currentTime) || 0;
      if (tMedia > state.lastMediaTime + 0.05) {
        state.lastMediaTime = tMedia;
        state.stallSince = 0;
      } else if (!state.stallSince) {
        state.stallSince = nowTick;
      } else if (nowTick - state.stallSince > stallMs && nowTick - (state.lastStallLog || 0) > 60000) {
        state.lastStallLog = nowTick;
        log(
          `[刷课] 视频时钟 ${Math.round(stallMs / 1000)} 秒没走: 浏览器很可能把这个标签页挂到后台了` +
            "(媒体和计时器都会被节流); 请把课程标签留在前台可见"
        );
        play();
      }
    }
    state.lastProgress = p;
    applyRate();
    applyMute();
    if (p >= opts.threshold && !state.ready) {
      state.ready = true;
      state.reason = "threshold";
      log(`[刷课] 观看已达 ${(p * 100).toFixed(1)}% (阈值 ${opts.threshold * 100}%)`);
      if (cfg.onReady) cfg.onReady(p, state);
    }
    if (cfg.onProgress) cfg.onProgress(p, state);
    // 防暂停: 不该暂停却暂停了 → 恢复
    if (opts.guard && v.paused && !state.ended) {
      state.resumeCount++;
      log("[刷课] 检测到暂停, 恢复播放");
      play();
    }
  }

  function onEnded() {
    state.ended = true;
    state.ready = true;
    log("[刷课] 视频播放结束");
    if (cfg.onReady) cfg.onReady(1, state);
    if (cfg.onEnded) cfg.onEnded(state);
  }

  function onTimeUpdate() {
    if (!state.video) return;
    const p = progressOf(state.video);
    if (p >= opts.threshold && !state.ready) {
      state.ready = true;
      log(`[刷课] 观看已达 ${(p * 100).toFixed(1)}%`);
      if (cfg.onReady) cfg.onReady(p, state);
    }
    if (cfg.onProgress) cfg.onProgress(p, state);
  }

  let handlers = null;
  function attach(video) {
    detachEvents();
    state.video = video;
    state.ended = false;
    state.lastMediaTime = -1;
    state.stallSince = 0;
    patchPause(video);
    handlers = { ended: onEnded, timeupdate: onTimeUpdate };
    try {
      video.addEventListener("ended", handlers.ended);
      video.addEventListener("timeupdate", handlers.timeupdate);
    } catch (e) {}
  }

  function detachEvents() {
    const v = state.video;
    if (v && handlers) {
      try {
        v.removeEventListener("ended", handlers.ended);
        v.removeEventListener("timeupdate", handlers.timeupdate);
      } catch (e) {}
    }
    handlers = null;
  }

  return {
    /** 开始刷这个视频 */
    start() {
      const v = findVideoElement(doc);
      if (!v) {
        log("[刷课] 没找到视频元素");
        return false;
      }
      attach(v);
      state.started = true;
      state.ready = false;
      applyMute();
      applyRate();
      if (v.paused || state.playCalls === 0) play();
      if (timer == null) timer = setInterval(tick, opts.tickMs);
      log(`[刷课] 开始播放(倍速 ${state.rate}x${opts.mute ? ", 静音" : ""})`);
      return true;
    },
    /** 停止(恢复原始 pause 行为) */
    stop() {
      state.started = false;
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
      detachEvents();
      const v = state.video;
      if (v && v.__ncaPatched) {
        try {
          v.pause = v.__ncaOriginalPause;
        } catch (e) {}
        v.__ncaPatched = false;
      }
      if (videojsPatched && videojsPatched.__ncaPatched) {
        try {
          videojsPatched.pause = videojsPatched.__ncaOriginalPause;
        } catch (e) {}
        videojsPatched.__ncaPatched = false;
      }
      log("[刷课] 已停止");
    },
    setRate(r) {
      const c = clampRate(r, opts.minRate, opts.maxRate);
      if (c != null) {
        state.rate = c;
        applyRate();
      }
      return state.rate;
    },
    setMute(m) {
      opts.mute = !!m;
      applyMute();
      return opts.mute;
    },
    tick,
    state: () => Object.assign({}, state, { progress: state.lastProgress, options: Object.assign({}, opts) }),
    video: () => state.video,
  };
}
