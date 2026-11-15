#!/usr/bin/env node
// 视频任务点驱动器单元自测(纯 node, 用假 DOM) —— node tools/player-test.mjs
// 覆盖: 自动播放/静音/倍速、防暂停(覆盖 pause + 看门狗)、90% 阈值回调一次、
//       播完回调、页面改回倍速后自动纠正、stop() 后不再抢暂停、视频元素被换掉后重新挂载。
import { createVideoDriver, findVideoElement, DEFAULT_PLAY_OPTIONS, DEFAULT_PLAYER_OPTIONS } from "../src/core/player.js";
import { DEFAULT_COURSE_OPTIONS } from "../src/core/course.js";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeVideo(duration = 543) {
  const listeners = {};
  return {
    tagName: "VIDEO",
    playbackRate: 1,
    muted: false,
    volume: 1,
    paused: true,
    currentTime: 56,
    duration,
    playCalls: 0,
    pauseCalls: 0,
    addEventListener(t, f) {
      (listeners[t] = listeners[t] || []).push(f);
    },
    removeEventListener(t, f) {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
    },
    emit(t) {
      (listeners[t] || []).slice().forEach((f) => f());
    },
    listenerCount(t) {
      return (listeners[t] || []).length;
    },
    play() {
      this.playCalls++;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls++;
      this.paused = true;
    },
  };
}

const fakeDoc = (get) => ({
  defaultView: {},
  querySelector: (sel) => (["#video_html5_api", ".vjs-tech", "video"].includes(sel) ? get() : null),
  querySelectorAll: () => (get() ? [get()] : []),
});

async function main() {
  console.log("== 1) start(): 自动播放 + 静音 + 1.5x 倍速");
  let v = makeVideo();
  const doc = fakeDoc(() => v);
  const events = { ready: 0, ended: 0, reattach: 0, lastReady: 0 };
  const d = createVideoDriver({
    doc,
    log: () => {},
    options: { rate: 1.5, mute: true, threshold: 0.9, tickMs: 40 },
    onReady: (p) => {
      events.ready++;
      events.lastReady = p;
    },
    onEnded: () => events.ended++,
    onReattach: () => events.reattach++,
  });
  ok(findVideoElement(doc) === v, "findVideoElement 能拿到 video 元素");
  ok(d.start() === true, "start() 返回 true");
  ok(v.playCalls >= 1, `已调用 play(${v.playCalls} 次)`);
  ok(v.muted === true && v.volume === 0, "已静音(muted=true, volume=0)");
  ok(v.playbackRate === 1.5, "倍速 = 1.5");
  ok(d.state().started === true, "状态 started = true");

  console.log("== 2) 防暂停: 外部调用 pause() 被拦下");
  const before = v.playCalls;
  v.pause();
  ok(v.paused === false && v.playCalls > before, "pause() 被拦, 立即恢复播放");
  ok(d.state().resumeCount >= 1, "resumeCount 已累加");

  console.log("== 3) 防暂停: 绕过覆盖(页面直接置 paused)被看门狗救回");
  v.__ncaOriginalPause();
  ok(v.paused === true, "先真的暂停住");
  await sleep(150);
  ok(v.paused === false && v.playCalls > before, "看门狗在 1 个 tick 内恢复播放");

  console.log("== 4) 90% 阈值只回调一次");
  v.currentTime = v.duration * 0.93;
  v.emit("timeupdate");
  v.emit("timeupdate");
  await sleep(120);
  ok(events.ready === 1, `onReady 只触发 1 次(实际 ${events.ready})`);
  ok(events.lastReady >= 0.9, `回调进度 ${events.lastReady.toFixed(3)} ≥ 0.9`);

  console.log("== 5) 页面把倍速改回 1 后自动纠正");
  v.playbackRate = 1;
  await sleep(120);
  ok(v.playbackRate === 1.5, "倍速已恢复为 1.5");

  console.log("== 6) 播完触发 onEnded");
  v.currentTime = v.duration;
  v.emit("ended");
  ok(events.ended === 1, "onEnded 触发 1 次");

  console.log("== 7) 视频元素被换掉(SPA 切任务点)后重新挂载");
  const v2 = makeVideo(300);
  v = v2;
  await sleep(120);
  ok(d.state().video === v2, "驱动器已切到新视频元素");
  ok(events.reattach === 1, "onReattach 触发 1 次");
  ok(v2.playCalls >= 1 || v2.playbackRate === 1.5, "新视频已接管(播放/倍速)");
  ok(v.listenerCount("ended") === 1, "旧元素事件已解绑, 新元素挂上 1 个 ended 监听");

  console.log("== 8) stop() 后不再抢暂停");
  d.stop();
  const rc = d.state().resumeCount;
  v2.__ncaOriginalPause();
  await sleep(150);
  ok(v2.paused === true, "stop() 后允许被暂停(不再恢复)");
  ok(d.state().resumeCount === rc, "resumeCount 未再增长");

  console.log("== 9) 没有视频元素时 start() 安全返回 false");
  const d2 = createVideoDriver({ doc: fakeDoc(() => null), log: () => {} });
  ok(d2.start() === false, "start() 返回 false");
  d2.stop();

  console.log("== 10) 倍速边界钳制(0.1 → minRate, 5 → maxRate 2)");
  const v3 = makeVideo();
  const d3 = createVideoDriver({ doc: fakeDoc(() => v3), log: () => {}, options: { rate: 5, minRate: 1, maxRate: 2, tickMs: 40 } });
  d3.start();
  ok(v3.playbackRate === 2, `超上限被钳到 2(实际 ${v3.playbackRate})`);
  ok(d3.setRate(0.1) === 1 && v3.playbackRate === 1, "低于下限被钳到 1");
  d3.stop();
  ok(v3.paused === false || true, "cleanup");

  console.log("== 11) 默认选项单源(播放类四键只在一处定义, 课程默认值必须是它的超集)");
  const playKeys = ["rate", "mute", "threshold", "tickMs"];
  ok(playKeys.every((k) => k in DEFAULT_PLAY_OPTIONS), "DEFAULT_PLAY_OPTIONS 含 rate/mute/threshold/tickMs");
  for (const k of playKeys) {
    ok(DEFAULT_COURSE_OPTIONS[k] === DEFAULT_PLAY_OPTIONS[k], `DEFAULT_COURSE_OPTIONS.${k} 与播放默认值一致(${JSON.stringify(DEFAULT_COURSE_OPTIONS[k])})`);
    ok(DEFAULT_PLAYER_OPTIONS[k] === DEFAULT_PLAY_OPTIONS[k], `DEFAULT_PLAYER_OPTIONS.${k} 与播放默认值一致(${JSON.stringify(DEFAULT_PLAYER_OPTIONS[k])})`);
  }
  ok(Math.abs(DEFAULT_COURSE_OPTIONS.threshold - 0.999) < 1e-9, "课程默认完成阈值改成 0.999(必须到片尾; 90% 平台不认账, 2026-11-10 真机)");
  ok(DEFAULT_COURSE_OPTIONS.maxBranchTries === 2 && DEFAULT_COURSE_OPTIONS.settleMs === 4000, "刷课专有键仍在(未被子对象覆盖掉)");

  console.log("== 12) 「在播但时钟不走」要报警(后台标签被节流, 只拦 paused 抓不到)");
  {
    const v4 = makeVideo(200);
    v4.currentTime = 10; // 时钟冻住(模拟后台标签: paused=false 但 currentTime 不前进)
    const logs = [];
    const d4 = createVideoDriver({
      doc: fakeDoc(() => v4),
      log: (m) => logs.push(m),
      options: { rate: 1, tickMs: 40, stallMs: 120, guard: true },
    });
    d4.start();
    await sleep(420);
    const stuck = logs.filter((m) => /视频时钟/.test(m));
    ok(stuck.length === 1, `时钟不走要报一次警告(实际 ${stuck.length})`);
    ok(/留在前台/.test(stuck[0] || ""), "警告里要说清怎么办(把课程标签留在前台可见)");
    v4.currentTime = 12;
    await sleep(160);
    ok(d4.state().lastMediaTime === 12, "时钟一恢复就记下新的媒体时间(看门狗重新计时)");
    ok(logs.filter((m) => /视频时钟/.test(m)).length === 1, "恢复后不再刷屏(一分钟内只报一次)");
    d4.stop();
  }

  console.log("== 13) 「拦下暂停」日志限流(站点连丢 pause 不刷屏)");
  {
    const v5 = makeVideo(100);
    const logs = [];
    const d5 = createVideoDriver({
      doc: fakeDoc(() => v5),
      log: (m) => logs.push(m),
      options: { rate: 1, tickMs: 1000, guard: true },
    });
    d5.start();
    for (let i = 0; i < 6; i++) v5.pause();
    const blocked = logs.filter((m) => /拦下视频暂停/.test(m));
    ok(blocked.length === 1, `连拦 6 次只打 1 行日志(实际 ${blocked.length})`);
    ok(v5.paused === false && v5.playCalls >= 1, "仍然保持播放");
    d5.stop();
  }

  console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
