#!/usr/bin/env node
// 章节内"内容块标签"契约自测(node tools/cx-tabs-test.mjs)
//
// 背景(2026-11-10 用户实测): 学习通新版章节页一章里有 11 个内容块
// (1课程视频 / 2预习 / 3课件 / 4课程思政 / …), 每块是**独立的一次 cards 请求**(num = idx-1)。
// 旧实现只枚举当前块里的任务点 → 视频做完就以为整章完事, 后面的预习/课件被整章略过。
// 这里守住两件纯逻辑: ① 标签解析(含没有 onclick 的老形态兜底) ② idx → num 的换算。
import { parseChapterTabs, tabNum } from "../src/contract/cx-study-contract.js";
import fs from "node:fs";

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

/* ---------- 极简假 DOM(只覆盖 parseChapterTabs 用到的那几个口) ---------- */
function tabEl({ id, cls = "", num = "", text = "", onclick = "" }) {
  const spanText = { textContent: text };
  return {
    id,
    className: cls,
    getAttribute: (n) => (n === "onclick" ? onclick : n === "class" ? cls : null),
    querySelector: (s) => (s === ".spanText" ? spanText : null),
    get textContent() {
      return `${num ? num + " " : ""}${text}`.trim();
    },
    click() {},
  };
}
const docOf = (tabs) => ({ querySelectorAll: () => tabs });

console.log("== 1) 新版章节页 11 块(用户实测那一章)");
{
  const labels = [
    "课程视频",
    "预习",
    "课件",
    "课程思政",
    "辅助视频",
    "课堂实录",
    "牛刀小试",
    "参考文献",
    "学生展示视频",
    "扩展阅读",
    "拓展阅读",
  ];
  const tabs = labels.map((t, i) =>
    tabEl({ id: `dct${i + 1}`, num: String(i + 1), text: t, cls: i === 0 ? "active" : "", onclick: `changeDisplayContent(${i + 1},${i + 1},'1227861714','100000005','100000003','');` })
  );
  const got = parseChapterTabs(docOf(tabs));
  ok(got.length === 11, `解析出 11 块(实际 ${got.length})`);
  ok(got.every((t, i) => t.idx === i + 1), "idx 按 changeDisplayContent 的第一个参数 1..11");
  ok(got[1].label === "预习" && got[2].label === "课件", `label 取 .spanText, 不是数字(实际 ${got[1].label}/${got[2].label})`);
  ok(got[0].active === true && got[1].active === false, "active 按 class 判定");
  ok(got.every((t) => tabNum(t) === String(t.idx - 1)), "tabNum = idx - 1");
  ok(tabNum(got[3]) === "3", `第 4 块 → num=3(毛概2.6 实测值, 实际 ${tabNum(got[3])})`);
}

console.log("== 2) 老页面 2 块(1视频 / 2章节测验)");
{
  const got = parseChapterTabs(
    docOf([
      tabEl({ id: "dct1", cls: "active", num: "1", text: "视频", onclick: "changeDisplayContent(1,2,'1103250729','100000006','100000007','');" }),
      tabEl({ id: "dct2", num: "2", text: "​章节测验", onclick: "changeDisplayContent(2,2,'1103250729','100000006','100000007','');" }),
    ])
  );
  ok(got.length === 2, `解析出 2 块(实际 ${got.length})`);
  ok(got[0].type === 2 && got[1].type === 2, "type 取第二个参数");
  ok(tabNum(got[1]) === "1", "第 2 块 → num=1");
}

console.log("== 3) 没有 onclick 的 li#dct(老形态) → 按 DOM 顺序兜底, 不整章只认一块");
{
  const got = parseChapterTabs(docOf([tabEl({ id: "dct1", num: "1", text: "视频" }), tabEl({ id: "dct2", num: "2", text: "课件" })]));
  ok(got.length === 2, `两张标签都认(实际 ${got.length})`);
  ok(got[1].idx === 2 && tabNum(got[1]) === "1", "idx 按顺序兜底为 2");
  ok(got[0].type === null, "没有 onclick 时 type 为 null");
}

console.log("== 4) 不是内容块的东西不被当成块");
{
  const got = parseChapterTabs(
    docOf([
      tabEl({ id: "dct1", num: "1", text: "视频", onclick: "changeDisplayContent(1,1,'1','2','3','');" }),
      tabEl({ id: "", num: "", text: "讨论", onclick: "switchDiscuss();" }),
      tabEl({ id: "other", num: "", text: "笔记", onclick: "" }),
    ])
  );
  ok(got.length === 1, `只认 changeDisplayContent / li#dct(实际 ${got.length})`);
}

console.log("== 5) 适配器确实逐块枚举(源码级护栏)");
{
  const src = fs.readFileSync(new URL("../src/adapters/cx-course.js", import.meta.url), "utf8");
  ok(/parseChapterTabs/.test(src), "cx-course.js 用 parseChapterTabs 枚举内容块");
  ok(/for \(const tab of tabs\)/.test(src), "逐块循环收集任务点(不是只看当前块)");
  ok(/switchTab/.test(src), "有切块动作");
  ok(/jobIndex/.test(src), "换块后按序号重新定位任务点元素");
  ok(/stopRequested/.test(src), "切块循环看停止令牌");
  ok(/内容块切换一直没生效/.test(src), "一块都切不到时退回只处理当前块(不比修前更差)");
  ok(/12s 内没等到 cards 换成 num=/.test(src), "切块超时要明说, 不静默判成无任务点");
  ok(/完成态已落定/.test(src), "完成态要连续两轮一致才认(切块后 374ms 还是「未完成」)");
}

console.log("== 6) 切块后要重新定位「这块的、还在文档里的」任务点(源码级护栏)");
{
  const src = fs.readFileSync(new URL("../src/adapters/cx-course.js", import.meta.url), "utf8");
  ok(/async function refreshBranchElement/.test(src), "refreshBranchElement 改成异步轮询(切块是先换 URL 的 num, 再重建 DOM)");
  ok(/cards\.contains\(j\.el\)/.test(src), "要求任务点元素还在当前 cards 文档里(排除枚举时那份已脱离文档的 iframe)");
  ok(/const located = await refreshBranchElement\(br\)/.test(src), "activateTab 等定位结果再决定要不要等视频");
  ok(/locateFailed/.test(src), "定位失败要留痕, 不再白等 12s 后判成「非课件/文档」");
  ok(/这块标的是视频任务点, 但没等到 <video> 元素/.test(src), "视频类等不到 <video> 时给准确告警");
  ok(/async function recheckJobDone/.test(src), "翻完课件要以服务端状态复核(重新拉这块)");
  ok(/平台已显示「任务点已完成」/.test(src), "复核到已完成时如实记完成, 不硬报未完成");
  ok(/cfg\.solveWork\(br\.frameEl, \{ shouldStop \}\)/.test(src), "测验任务点交给答题链(带停止令牌)");
  ok(/测验已交卷, 平台仍显示「任务点未完成」/.test(src), "交卷后仍要平台复核, 没记上就如实报");
  ok(/wr\.submitted && confirmed !== true/.test(src), "交卷了但确认不了时如实说, 不冒充满分");
  ok(/function jobLooksLikeWork/.test(src), "测验任务点按 kind 或 work iframe 地址识别(kind 可能晚一步才认出来)");
  ok(/if \(br && br\.jobKey\) return null/.test(src), "多块分支没自己的媒体 iframe 时不退回「第一个视频」(会播错)");
  ok(/if \(j\.kind\) \{\s*br\.kind = j\.kind;\s*return true;/.test(src), "切块后要等任务点类型认出来再收工");
}

console.log("== 7) 连续滚动型 PDF: 滚到底才是正规完成动作(2026-11-10 真机)");
{
  const { scrollHost } = await import("../src/adapters/cx-courseware.js");
  const mkDoc = (h, c, top) => {
    const de = { scrollHeight: h, clientHeight: c, scrollTop: top };
    const body = { scrollHeight: h, clientHeight: c, scrollTop: 0 };
    return { scrollingElement: de, documentElement: de, body };
  };
  const long = scrollHost(mkDoc(3786, 687, 0));
  ok(long && long.max === 3099 && long.frac === 0, "长页按 scrollHeight-clientHeight 算可滚距离");
  const half = scrollHost(mkDoc(3786, 687, 1550));
  ok(half && half.frac > 0.49 && half.frac < 0.51, "滚动进度按比例算(不认 span.pageNum 页码标签)");
  const noscroll = scrollHost(mkDoc(687, 687, 0));
  ok(noscroll && noscroll.max === 0 && noscroll.frac === 1, "没有滚动区的文档 max=0(站点自己 finishJob)");

  const src = fs.readFileSync(new URL("../src/adapters/cx-courseware.js", import.meta.url), "utf8");
  ok(/export function scrollHost/.test(src), "课件适配器有滚动容器探测");
  ok(/滚到底站点自己上报完成/.test(src), "说清是站点自己上报, 不是我们调接口");
  ok(/reason: "scroll-to-end"/.test(src), "滚到底单独一种收尾原因(便于上层复核)");
  ok(!/\/mooc-ans\/job\/document/.test(src), "绝不自己调 /mooc-ans/job/document(红线: 伪造心跳)");
  ok(/if \(shouldStop\(\)\) \{\s*log\("\[课件\] 已停止刷课, 收工"/.test(src), "滚动循环每轮看停止令牌");

  const adapter = fs.readFileSync(new URL("../src/adapters/cx-course.js", import.meta.url), "utf8");
  ok(/滚到底了/.test(adapter) && /平台仍显示「任务点未完成」/.test(adapter), "课件走完也要让平台复核, 没记上就如实报未完成");
  ok(/滚到底\(\$\{r\.visited/.test(adapter), "完成文案写清滚了几屏");
  ok(/没等到 cards 帧\(页面可能卡在加载中\)/.test(adapter), "切章后页面卡在加载中要停止并说清楚, 不能当这章没任务点静默跳过");
  ok(/function watchVisibility/.test(adapter) && /visibilitychange/.test(adapter), "后台标签要提示用户(计时器会被节流)");
}

console.log("== 8) 刷课里的章节测验/作业: 借答题链做掉, 交不交看面板(源码级护栏)");
{
  const src = fs.readFileSync(new URL("../src/runtime.js", import.meta.url), "utf8");
  ok(/async function solveWorkTaskPoint/.test(src), "有「刷课途中做测验」的入口");
  ok(/findQuestionDoc\(frameEl\.contentWindow\)/.test(src), "先等 api/work 那层把题目加载出来(切块后要几秒)");
  ok(/new CxAdapter\("zj", frameEl\)/.test(src), "复用 zj 适配器解析/填题");
  ok(/if \(!auto\) return \{ ok: false, reason: `已填/.test(src), "没开「答完自动提交」就只回填, 不偷偷交卷");
  ok(/rate < threshold\) return \{ ok: false, reason: `估算正确率/.test(src), "低于阈值不交卷");
  ok(/adapter\.autoSubmit\(\{/.test(src), "满足条件才调交卷");
  ok(/submitted: true/.test(src), "交卷后页面整页跳走看不到结果时, 交给任务点图标复核");
  ok(/不瞎答也不交卷/.test(src) && /await ensureTable\(/.test(src), "题面加密解不开就不答不交(乱码答了也是瞎猜)");
  ok(/solveWork: \(frameEl, opts\) =>/.test(src), "答卷入口接进刷课控制器");
  const ctl = fs.readFileSync(new URL("../src/adapters/cx-course.js", import.meta.url), "utf8");
  ok(/const submittedJobs = new Set\(\)/.test(ctl), "同一次刷课记住交过卷的任务点");
  ok(/submittedJobs\.has\(jobUidOf\(br\)\)/.test(ctl) && /本次已交过卷, 不重复提交/.test(ctl), "平台图标没刷新时不许再交一遍(有的测验允许多次尝试)");
  ok(/jobUid: `\$\{kid \|\| ""\}\|\$\{tab\.key\}\|\$\{j\.index\}`/.test(ctl), "任务点身份要带章节 id(dct 编号每章都一样, 不带就串)");
  ok(/if \(wr\.submitted && br && jobUidOf\(br\)\) submittedJobs\.add/.test(ctl), "交了卷才记账");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
