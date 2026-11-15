#!/usr/bin/env node
// 刷课编排单元自测(纯 node, 假 DOM + 假适配器) —— node tools/course-test.mjs
// 覆盖: 章节树解析(真机结构) / 未完成数三种写法 / 选下一个任务点 / 多轮扫描 /
//       非视频任务点跳过 / 失败不空转 / 阈值即离开(stopGraceMs) / 超时判失败 / stop() 提前收工。
import { parseTaskTree, pickNextUnfinished, createCourseRunner, playVideoDoc, DEFAULT_COURSE_OPTIONS } from "../src/core/course.js";
import { readUnfinished } from "../src/contract/cx-study-contract.js";

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

/* ---------- 极简假 DOM(只实现被用到的 API) ---------- */
function classMatch(el, sel) {
  const cls = "." + String(el.className || "").split(/\s+/).join(".");
  return sel.startsWith(".") && String(el.className || "").split(/\s+/).includes(sel.slice(1));
}
function makeEl(tag, { cls = "", text = "", onclick = null, children = [] } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    className: cls,
    _text: text,
    _children: children,
    parent: null,
    clicked: 0,
    getAttribute: (n) => (n === "onclick" ? onclick : null),
    click() {
      el.clicked++;
    },
    get textContent() {
      return [el._text, ...el._children.map((c) => c.textContent)].filter(Boolean).join(" ");
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n._children) {
          if (classMatch(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    closest(sel) {
      let n = el;
      while (n) {
        if (classMatch(n, sel)) return n;
        n = n.parent;
      }
      return null;
    },
  };
  children.forEach((c) => (c.parent = el));
  return el;
}
const taskRow = (title, knowledgeId, unfinished) =>
  makeEl("div", {
    cls: "posCatalog_select",
    children: [
      makeEl("span", { cls: "posCatalog_name", text: title, onclick: `getTeacherAjax('100000006','100000007','${knowledgeId}');` }),
      ...(unfinished > 0
        ? [makeEl("span", { cls: "jobUnfinishCount", text: String(unfinished) })]
        : [makeEl("span", { cls: "catalog_points_yi", text: "0" })]),
    ],
  });

const README_LIKE_ROWS = [
  taskRow("1.1 马克思主义为什么要中国化？", "1000000101", 1),
  taskRow("1.2 马克思主义为什么要时代化？", "1000000102", 2),
  taskRow("1.5 红色经典实践活动2021年剧本", "1000000111", 0),
  taskRow("2.6 毛泽东思想活的灵魂", "1000000103", 4),
  taskRow("10.1 问卷调查", "1000000112", 0),
];
const fakeDoc = (rows) => ({ querySelectorAll: (sel) => (sel === ".posCatalog_name" ? rows.flatMap((r) => r.querySelectorAll(sel)) : []) });

/* ---------- 假适配器 ---------- */
function makeFakeRunner(opts = {}) {
  const state = { doneIds: new Set(), entered: [], activated: [], nonVideo: opts.nonVideo || new Set(), parseCalls: 0 };
  let curBranch = null;
  const rows = opts.rows || README_LIKE_ROWS;
  const parse = () => {
    state.parseCalls++;
    return rows.flatMap((r) => parseTaskTree({ querySelectorAll: () => r.querySelectorAll(".posCatalog_name") })).map((it) => ({
      ...it,
      unfinished: state.doneIds.has(it.knowledgeId) ? 0 : it.unfinished,
    }));
  };
  const runner = createCourseRunner({
    doc: fakeDoc(rows),
    log: opts.log || (() => {}),
    sleep,
    parse,
    options: Object.assign({ settleMs: 5, stopGraceMs: 10, videoTimeoutMs: 20, maxPasses: 4, maxAttemptsPerItem: 2 }, opts.options || {}),
    enterItem: async (item) => {
      state.entered.push(item.knowledgeId);
      curBranch = null; // 进入新目录项 → 分支上下文重置
      if (opts.onEnter) opts.onEnter(item, state);
    },
    listTaskTabs: async (item) => (opts.branches && opts.branches[item.knowledgeId]) || [],
    activateTab: async (br) => {
      curBranch = br;
      state.activated.push(br.key);
    },
    waitVideoDoc: async (item, timeoutMs, br) => {
      // 多任务点: 分支自己带 jobId 时, 返回"属于它的"视频文档(可断言定位是否正确)
      if (br && br.jobId) {
        state.docRequests = state.docRequests || [];
        state.docRequests.push(br.jobId);
        if (br.video === false) return null;
        return { fake: "video-doc", jobId: br.jobId };
      }
      const kind = curBranch ? curBranch.kind : state.nonVideo.has(item.knowledgeId) ? "doc" : "video";
      return kind === "doc" ? null : { fake: "video-doc" };
    },
    playVideo: async (vdoc, item) => {
      if (vdoc && vdoc.jobId) {
        state.played = state.played || [];
        state.played.push(vdoc.jobId);
      }
      if (opts.onPlay) await opts.onPlay(item, state);
      if (opts.failIds && opts.failIds.has(item.knowledgeId)) return { ok: false, reason: "timeout" };
      if (opts.failBranches && curBranch && opts.failBranches.has(curBranch.key)) {
        const n = (state.branchFails = state.branchFails || new Map()).get(curBranch.key) || 0;
        state.branchFails.set(curBranch.key, n + 1);
        if (n < (opts.failBranchesTimes || 1)) return { ok: false, reason: "timeout" };
      }
      state.doneIds.add(item.knowledgeId);
      return { ok: true, reason: "threshold" };
    },
  });
  return { runner, state };
}

async function main() {
  console.log("== 1) 未完成数的三种写法");
  const rowCount = makeEl("div", { cls: "posCatalog_select", children: [makeEl("span", { cls: "jobUnfinishCount", text: "3" })] });
  const rowText = makeEl("div", { cls: "posCatalog_select", text: "1.1 标题 2个待完成任务点2" });
  const rowDone = makeEl("div", { cls: "posCatalog_select", text: "1.1 标题 0" });
  ok(readUnfinished(rowCount) === 3, ".jobUnfinishCount=3 → 3");
  ok(readUnfinished(rowText) === 2, "「2个待完成任务点2」→ 2");
  ok(readUnfinished(rowDone) === 0, "只有裸 0 → 0(视为已完成)");
  ok(readUnfinished(null) === 0, "null 安全返回 0");

  console.log("== 2) 解析章节树(真机结构)");
  const items = parseTaskTree(fakeDoc(README_LIKE_ROWS));
  ok(items.length === 5, `解析出 5 个任务点(实际 ${items.length})`);
  ok(items[0].title === "1.1 马克思主义为什么要中国化？", "标题取 .posCatalog_name 文本");
  ok(items[0].knowledgeId === "1000000101" && items[0].courseId === "100000006" && items[0].clazzId === "100000007", "从 onclick 里拿到三个参数");
  ok(items.map((i) => i.unfinished).join(",") === "1,2,0,4,0", `未完成数 = 1,2,0,4,0(实际 ${items.map((i) => i.unfinished).join(",")})`);

  console.log("== 3) 选下一个未完成");
  ok(pickNextUnfinished(items).knowledgeId === "1000000101", "第一个未完成");
  ok(pickNextUnfinished(items, { skip: new Set(["1000000101", "1000000102"]) }).knowledgeId === "1000000103", "跳过已处理的, 取到 2.6");
  ok(pickNextUnfinished(items, { attempts: new Map([["1000000101", 2], ["1000000102", 2], ["1000000103", 2]]), maxAttempts: 2 }) === null, "尝试次数超限后不再返回");
  ok(pickNextUnfinished([{ knowledgeId: "x", unfinished: 0 }]) === null, "全完成返回 null");

  console.log("== 4) 完整跑一遍(2 个已完成 + 3 个视频 + 1 个非视频)");
  const rows = README_LIKE_ROWS.concat([taskRow("1.4 红色文化实践教学", "1000000104", 1)]);
  const r2 = makeFakeRunner({ rows, nonVideo: new Set(["1000000104"]) });
  const stats = await r2.runner.run();
  ok(stats.done === 3, `完成 3 个视频任务点(实际 ${stats.done})`);
  ok(stats.skippedBranch === 1, `跳过 1 个非视频分支(实际 ${stats.skippedBranch})`);
  ok(stats.failed === 0, "没有失败项");
  ok(r2.state.entered.join(",") === "1000000101,1000000102,1000000103,1000000104", `进入顺序正确(按目录顺序, 实际 ${r2.state.entered.join(",")})`);
  ok(r2.state.parseCalls > 2, `每完成一个都重新扫描目录(scan ${r2.state.parseCalls} 次)`);
  ok(r2.runner.isRunning() === false, "跑完 running=false");

  console.log("== 5) 全部完成时立即收工");
  const allDone = [taskRow("1.1 已完成", "1000000101", 0), taskRow("1.2 已完成", "1000000102", 0)];
  const r3 = makeFakeRunner({ rows: allDone });
  const s3 = await r3.runner.run();
  ok(s3.done === 0 && r3.state.entered.length === 0, "没有任何进入动作");
  ok(r3.state.parseCalls === 1, "只扫了一轮");

  console.log("== 6) 失败的视频会在同一次进入内重试, 用尽后放弃(不空转)");
  const r4 = makeFakeRunner({ failIds: new Set(["1000000101"]) });
  const s4 = await r4.runner.run();
  ok(s4.failed === 2, `失败分支重试用尽 = 2 次(实际 ${s4.failed})`);
  ok(r4.state.entered.filter((id) => id === "1000000101").length === 1, "同一目录项只进入一次(重试在内部进行)");
  ok(s4.skippedItem === 1, `放弃 1 个目录项(实际 ${s4.skippedItem})`);
  ok(s4.done === 2, `其余任务点照常完成(实际 ${s4.done} 个)`);

  console.log("== 7) stop() 能提前收工");
  let stopAfter = 0;
  const r5 = makeFakeRunner({
    onPlay: async () => {
      if (++stopAfter === 1) r5.runner.stop();
      await sleep(5);
    },
  });
  const s5 = await r5.runner.run();
  ok(s5.done <= 1, `停止后不再继续(完成 ${s5.done} 个)`);
  ok(r5.state.entered.length <= 2, `进入次数受控(实际 ${r5.state.entered.length})`);

  console.log("== 8) playVideoDoc: 达阈值后按 stopGraceMs 离开");
  const t0 = Date.now();
  const res = await playVideoDoc(
    {},
    {
      stopGraceMs: 60,
      playTimeoutMs: 5000,
      driverFactory: ({ onReady }) => ({
        start() {
          setTimeout(() => onReady(0.95), 5);
          return true;
        },
        stop() {},
        state: () => ({ lastProgress: 0.95 }),
      }),
    }
  );
  const dt = Date.now() - t0;
  ok(res.ok === true && res.reason === "threshold", "原因 = threshold");
  ok(dt >= 55 && dt < 1000, `等待了 grace(${dt}ms, 应 ≈60ms)`);
  ok(Math.abs(DEFAULT_COURSE_OPTIONS.threshold - 0.999) < 1e-9, "默认完成阈值 = 0.999(必须到片尾: 90% 平台不认账, 2026-11-10 真机)");

  console.log("== 9) playVideoDoc: 找不视频 → no-video; 卡住 → timeout");
  const noV = await playVideoDoc({}, { driverFactory: () => ({ start: () => false, stop() {}, state: () => ({}) }) });
  ok(noV.ok === false && noV.reason === "no-video", "没有视频 → no-video");
  const t1 = Date.now();
  const to = await playVideoDoc(
    {},
    { playTimeoutMs: 80, driverFactory: () => ({ start: () => true, stop() {}, state: () => ({ lastProgress: 0.1 }) }) }
  );
  ok(to.ok === false && to.reason === "timeout", "一直不动 → timeout");
  ok(Date.now() - t1 >= 75, "确实等到了超时时间");

  console.log("== 11) 多分支章节: 视频/文档/视频 → 三个分支都走到, 不整章略过");
  {
    const rowsM = [taskRow("7.1 中国式现代化道路", "1103250750", 3)];
    const r = makeFakeRunner({
      rows: rowsM,
      branches: {
        "1103250750": [
          { key: "dct1", label: "1微课", kind: "video", el: { click() {} } },
          { key: "dct2", label: "2课件", kind: "doc", el: { click() {} } },
          { key: "dct3", label: "3微课", kind: "video", el: { click() {} } },
        ],
      },
    });
    const st = await r.runner.run();
    ok(st.done === 2, `完成 2 个视频分支(实际 ${st.done})`);
    ok(st.skippedBranch === 1, `跳过 1 个非视频分支(实际 ${st.skippedBranch})`);
    ok(st.skippedItem === 0, "没有放弃整章");
    ok(r.state.activated.join(",") === "dct1,dct2,dct3", `三个分支都切过(实际 ${r.state.activated.join(",")})`);
    ok(r.state.entered.length === 1, `只进入目录项 1 次(实际 ${r.state.entered.length})`);
  }

  console.log("== 12) 全是非视频分支 → 整个目录项记为放弃(但有日志, 不空转)");
  {
    const r = makeFakeRunner({
      rows: [taskRow("6.1 教学课件", "1000000113", 2)],
      branches: { "1000000113": [{ key: "dct1", label: "1课件", kind: "doc", el: { click() {} } }, { key: "dct2", label: "2课件", kind: "doc", el: { click() {} } }] },
    });
    const st = await r.runner.run();
    ok(st.done === 0 && st.skippedBranch === 2 && st.skippedItem === 1, `分支 2 个都跳过、放弃 1 项(实际 done=${st.done} skip=${st.skippedBranch} item=${st.skippedItem})`);
    ok(r.state.entered.length === 1, "不会反复进入");
  }

  console.log("== 13) 分支首次失败, 重试成功");
  {
    const r = makeFakeRunner({
      rows: [taskRow("2.6 毛泽东思想活的灵魂", "1000000103", 1)],
      branches: { "1000000103": [{ key: "dct1", label: "1微课", kind: "video", el: { click() {} } }] },
      failBranches: new Set(["dct1"]),
      failBranchesTimes: 1,
    });
    const st = await r.runner.run();
    ok(st.done === 1, `重试后成功(实际完成 ${st.done})`);
    ok(st.failed === 1, `记录 1 次失败(实际 ${st.failed})`);
    ok(r.state.activated.length === 2, `分支被激活 2 次(实际 ${r.state.activated.length})`);
  }

  console.log("== 14) 点「停止刷课」→ 立刻停掉当前视频(不用等 45 分钟超时)");
  {
    const rows = [taskRow("1.1 马克思主义为什么要中国化？", "1000000101", 1)];
    const st = { stoppedCalls: 0, paused: 0, startCalls: 0 };
    const fakeVideo = {
      paused: false,
      pause() {
        st.paused++;
        this.paused = true;
      },
    };
    const driverFactory = () => ({
      start() {
        st.startCalls++;
        return true;
      },
      stop() {
        st.stoppedCalls++;
      },
      video: () => fakeVideo,
      state: () => ({ lastProgress: 0.1 }),
      tick() {},
      setRate() {},
      setMute() {},
    });
    const runner = createCourseRunner({
      doc: fakeDoc(rows),
      log: () => {},
      sleep,
      parse: () => parseTaskTree({ querySelectorAll: () => rows[0].querySelectorAll(".posCatalog_name") }),
      options: { settleMs: 5, playTimeoutMs: 60000, videoTimeoutMs: 20 },
      enterItem: async () => {},
      waitVideoDoc: async () => ({ fake: "video-doc" }),
      driverFactory,
    });
    const t0 = Date.now();
    const p = runner.run();
    await sleep(60);
    runner.stop();
    const s14 = await p;
    const dt = Date.now() - t0;
    ok(st.startCalls === 1, "视频驱动器已启动");
    ok(dt < 3000, `stop() 后立刻收工(实际 ${dt}ms; 若未生效会卡到 60000ms 超时)`);
    ok(st.stoppedCalls >= 1, "当前视频驱动器被 stop()");
    ok(st.paused === 1, `停止时把画面也暂停了(实际 ${st.paused} 次)`);
    ok(s14.done === 0, "被停止的视频不计入完成");
    ok(!runner.isRunning(), "runner 已退出");
  }

  console.log("== 15) 一页多个视频任务点(3.9 真机结构): 跳过的、未完成的分别处理, 且各播自己的视频");
  {
    // 真机: 3.9 的 cards 页并排 3 个视频, aria-label 指示第 1 个已完成
    const branches = {
      "1103250738": [
        { key: "job-0", label: "1video", done: true, jobId: "J0" },
        { key: "job-1", label: "2video", done: false, jobId: "J1" },
        { key: "job-2", label: "3video", done: false, jobId: "J2" },
      ],
    };
    const r = makeFakeRunner({ rows: [taskRow("3.9 统一战线", "1103250738", 2)], branches: Object.assign({}, branches, {}) });
    // 上面的分支对象带 jobId → 走"自己的视频文档"分支; el 让它走 activateTab
    Object.keys(branches["1103250738"]).forEach((k) => (branches["1103250738"][k].el = { click() {} }));
    const st = await r.runner.run();
    ok(st.done === 2, `完成 2 个未完成任务点(实际 ${st.done})`);
    ok((r.state.played || []).join(",") === "J1,J2", `只播未完成的那两个、各播自己的(实际 ${(r.state.played || []).join(",")})`);
    ok((r.state.docRequests || []).join(",") === "J1,J2", `未给"已完成"的任务点取视频文档(实际 ${(r.state.docRequests || []).join(",")})`);
  }

  console.log("== 16) 任务点里没有视频(文档/课件) → 只跳该任务点, 不牵连整章");
  {
    const branches = {
      "1103250999": [
        { key: "job-0", label: "1pdf", done: false, jobId: "D0", video: false, el: { click() {} } },
        { key: "job-1", label: "2video", done: false, jobId: "V1" },
      ],
    };
    branches["1103250999"][1].el = { click() {} };
    const r = makeFakeRunner({ rows: [taskRow("9.9 混合章节", "1103250999", 2)], branches });
    const st = await r.runner.run();
    ok(st.skippedBranch === 1 && st.done === 1, `1 个非视频 + 1 个视频完成(实际 skip=${st.skippedBranch} done=${st.done})`);
    ok((r.state.played || []).join(",") === "V1", "只有视频任务点被播放");
  }

  console.log("== 10) 播完(ended)也算完成");
  const ended = await playVideoDoc(
    {},
    { playTimeoutMs: 2000, driverFactory: ({ onEnded }) => ({ start() { setTimeout(onEnded, 5); return true; }, stop() {}, state: () => ({ lastProgress: 1 }) }) }
  );
  ok(ended.ok === true && ended.reason === "ended", "原因 = ended");

  console.log("== 17) 翻课件时点「停止」→ 处理器拿到 shouldStop, 立刻收尾, 不计完成");
  {
    const rows = [taskRow("1.9 只有课件", "1103250919", 1)];
    let ticks = 0;
    let sawStop = false;
    const runner = createCourseRunner({
      doc: fakeDoc(rows),
      log: () => {},
      sleep,
      parse: () => parseTaskTree({ querySelectorAll: () => rows[0].querySelectorAll(".posCatalog_name") }),
      options: { settleMs: 5, videoTimeoutMs: 10, maxPasses: 1, maxBranchTries: 1 },
      enterItem: async () => {},
      listTaskTabs: async () => [{ key: "job-0", label: "1pdf", done: false, frameEl: {} }],
      waitVideoDoc: async () => null,
      handleNonVideo: async (item, br, ctx) => {
        while (!ctx.shouldStop()) {
          ticks++;
          await sleep(5);
        }
        sawStop = true;
        return { ok: false, reason: "stopped" };
      },
    });
    const t0 = Date.now();
    const p = runner.run();
    await sleep(40);
    runner.stop();
    const s17 = await p;
    const dt = Date.now() - t0;
    ok(sawStop, "非视频处理器收到 shouldStop=true");
    ok(dt < 2000, `stop() 后课件循环立刻收尾(实际 ${dt}ms; 若未生效会一直翻到 timeout)`);
    ok(s17.done === 0, "被停止的课件分支不计入完成");
    ok(!runner.isRunning(), "runner 已退出");
  }

  console.log("== 18) 播完但平台没记完成 → 如实记失败, 不冒充满分");
  {
    const rows = [taskRow("1.8 视频未记上", "1103250918", 1)];
    const logs = [];
    const runner = createCourseRunner({
      doc: fakeDoc(rows),
      log: (m) => logs.push(m),
      sleep,
      parse: () => parseTaskTree({ querySelectorAll: () => rows[0].querySelectorAll(".posCatalog_name") }),
      options: { settleMs: 5, videoTimeoutMs: 20, maxPasses: 1, maxBranchTries: 2 },
      enterItem: async () => {},
      listTaskTabs: async () => [{ key: "job-0", label: "1video", done: false, frameEl: {} }],
      waitVideoDoc: async () => ({ fake: "video-doc" }),
      playVideo: async () => ({ ok: true, reason: "ended" }),
      verifyBranchDone: async () => false, // 平台: 我还是没记上
    });
    const s18 = await runner.run();
    ok(s18.done === 0, `平台没记上就不许记完成(实际 done=${s18.done})`);
    ok(s18.failed >= 1, `如实记失败(实际 failed=${s18.failed})`);
    ok(logs.some((m) => /平台仍显示「任务点未完成」/.test(m)), "日志说清是平台没记上, 不是播失败");
  }

  console.log("== 19) 平台已记完成(verify=true) → 正常记完成");
  {
    const rows = [taskRow("1.7 视频正常", "1103250917", 1)];
    const runner = createCourseRunner({
      doc: fakeDoc(rows),
      log: () => {},
      sleep,
      parse: () => parseTaskTree({ querySelectorAll: () => rows[0].querySelectorAll(".posCatalog_name") }),
      options: { settleMs: 5, videoTimeoutMs: 20, maxPasses: 1, maxBranchTries: 1 },
      enterItem: async () => {},
      listTaskTabs: async () => [{ key: "job-0", label: "1video", done: false, frameEl: {} }],
      waitVideoDoc: async () => ({ fake: "video-doc" }),
      playVideo: async () => ({ ok: true, reason: "ended" }),
      verifyBranchDone: async () => true,
    });
    const s19 = await runner.run();
    ok(s19.done === 1 && s19.failed === 0, `核对通过 → 记完成(实际 done=${s19.done} failed=${s19.failed})`);
  }

  console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
