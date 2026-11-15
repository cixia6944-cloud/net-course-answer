// 平台探测与路由表(0.2.4 urlLogicPairs 的声明式重写)。
import { CxAdapter } from "./cx.js";
import { ZhsAdapter } from "./zhs.js";
import { ZhsReviewAdapter } from "./zhs-review.js";
import { parseZhsCourseRoute } from "./zhs-course.js";
import { parseDiscussContext } from "../core/discuss.js";

/**
 * 超星答题页 URL → workType。
 * 顶层路由(下面 createAdapterForUrl)与「章节页内嵌作业帧」共用这一处判据 —— 两处各写一份,
 * 改版时必然漂一个(内嵌接管找不到帧, 或找到却用错适配器)。
 * 只管路径形态; "是不是超星域名"由调用方判(顶层路由自己看 host, 帧扫描只从章节页往下扫)。
 * @returns {"zj"|"zy"|"ks"|null} zj=章节作业 doHomeWorkNew / zy=新版作业 dowork / ks=考试 exam-ans
 */
export function cxWorkTypeForUrl(url) {
  const u = String(url || "");
  // 章节测验 / 作业作答页(实测: doHomeWorkNew 是平级页面, DOM 结构 = zj: .TiMu + .fontLabel + .before-after)
  if (u.includes("/work/doHomeWorkNew")) return "zj";
  if (u.includes("/mooc2/work/dowork")) return "zy";
  if (u.includes("/exam-ans/exam")) return "ks";
  return null;
}

/**
 * 页面匹配器:URL 关键字命中时, 用该 URL 的 document/window 构造适配器并返回答题编排参数。
 * 两种形态: 平级作业/考试页在这里就能拿到适配器; 章节页(studentstudy)的作业在嵌套 iframe 里
 *   → 这里只能返回 workType="chapter"、handler=null, 由 runtime 用 adapters/work-frame.js 找到那一帧再接管。
 * @typedef {Object} RouteMatch
 * @property {string} keyword
 * @property {string} platform  "cx" | "zhs"
 * @property {string} workType
 * @property {(win?: Window) => Object} makeHandler  返回 { adapter, hooks? } 或 null(不答)
 */
export function createAdapterForUrl(url) {
  const u = String(url || "");

  // 智慧树老版考试页
  if (u.includes("stuExamWeb.html")) {
    return { platform: "zhs", workType: "zhs", makeHandler: () => new ZhsAdapter() };
  }

  // 智慧树新形态课程(AI 教学中心): 目录/学习页 = 刷课; weakTest = 单题练习页
  const zhs = parseZhsCourseRoute(u);
  if (zhs) {
    if (zhs.mode === "weakTest" || zhs.mode === "reviewTest") {
      return { platform: "zhs", workType: "zhs", zhsMode: zhs.mode, makeHandler: () => new ZhsReviewAdapter() };
    }
    if (zhs.mode === "catalog" || zhs.mode === "learn") {
      return { platform: "zhs", workType: "zhs-course", zhsMode: zhs.mode, makeHandler: () => null };
    }
    if (zhs.mode === "review") {
      return { platform: "zhs", workType: "zhs-review-list", zhsMode: zhs.mode, makeHandler: () => null };
    }
    if (zhs.mode === "tasks") {
      return { platform: "zhs", workType: "zhs-tasks", zhsMode: zhs.mode, makeHandler: () => null };
    }
  }

  // 超星 AI助教页(robot-lc.chaoxing.com/courseCozeV3): Vue SPA, 一题一会话 + 自动评价
  // 先于其它超星路径判断: 它是独立子域 + 独立路径, 不会和 zj/zy/ks/chapter 撞
  if (u.includes("robot-lc.chaoxing.com") && u.includes("courseCozeV3")) {
    return { platform: "cx", workType: "ai-tutor", makeHandler: () => null };
  }

  // 超星讨论区(groupweb): 话题列表页与话题详情页共用一套“讨论区自动回复”
  // 也要先于下面的 chaoxing.com 分支 —— groupweb.chaoxing.com 同样包含 “chaoxing.com”
  const discuss = parseDiscussContext(u);
  if (discuss) {
    return { platform: "cx", workType: "discuss", discuss, makeHandler: () => null };
  }

  // 超星 AI陪练页(mooc2-ans /qbank-ai/aiPracticeAssistant): 独立 SPA, 只挂陪练逻辑
  if (u.includes("/qbank-ai/aiPracticeAssistant")) {
    return { platform: "cx", workType: "practice", makeHandler: () => null };
  }

  // 超星:章节 / 作业 / 考试
  if (u.includes("chaoxing.com")) {
    const workType = cxWorkTypeForUrl(u);
    if (workType === "zj") return { platform: "cx", workType: "zj", makeHandler: () => new CxAdapter("zj") };
    if (workType === "zy") return { platform: "cx", workType: "zy", makeHandler: () => new CxAdapter("zy") };
    if (workType === "ks") return { platform: "cx", workType: "ks", makeHandler: () => new CxAdapter("ks") };
    if (u.includes("/mooc2-ans-vue/fanyav3") || u.includes("/mycourse/studentcourse")) {
      // 新版泛雅3 课程页(章节列表在 studentcourse iframe 里, 条目 onclick=toOld)
      return { platform: "cx", workType: "chapter", makeHandler: () => null };
    }
    if (u.includes("/mycourse/studentstudy")) {
      // 章节学习页: 作业/测验在嵌套 iframe 内 → 刷课照跑, 内嵌答题帧由 adapters/work-frame.js 找(找到就接管)
      return { platform: "cx", workType: "chapter", makeHandler: () => null };
    }
  }
  return null;
}

export { CxAdapter, ZhsAdapter, ZhsReviewAdapter };
