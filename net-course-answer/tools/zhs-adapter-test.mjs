#!/usr/bin/env node
// 智慧树新形态课程(刷课中继 + 练习页解析)单元自测 —— node tools/zhs-adapter-test.mjs
// 纯 node: 假 DOM 只实现被用到的查询, 不引第三方依赖。
import {
  parseZhsCourseRoute,
  parseZhsVideoUnits,
  pickNextZhsUnit,
  newZhsCourseState,
  loadZhsState,
  saveZhsState,
  clearZhsState,
  isZhsRelayActive,
  makeZhsCatalogUrl,
  makeZhsLearnUrl,
  formatDuration,
  ZHS_COURSE_STATE_KEY,
} from "../src/adapters/zhs-course.js";
import { inferZhsReviewType, parseZhsReviewQuestions, isZhsWeakTestPage, isZhsReviewTestPage, zhsReviewTestSignature, ZhsReviewAdapter } from "../src/adapters/zhs-review.js";

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

/* ---------------- 假 DOM 片段 ---------------- */
const textNode = (text) => ({ textContent: text });
const unitEl = (id, title, progress) => ({
  id: `knowledgeId-${id}`,
  getAttribute: (n) => (n === "knowledgeid" ? id : null),
  querySelector: (sel) => {
    if (sel === ".item-title") return { textContent: title, getAttribute: (n) => (n === "title" ? title : null) };
    if (sel === ".progress-num") return textNode(progress);
    return null;
  },
});
const catalogDoc = (units, blockTitle = "知识模块课程视频") => {
  const block = {
    querySelector: (sel) => (sel === ".content-list-title" ? textNode(blockTitle) : null),
    querySelectorAll: (sel) => (sel === ".item-content" ? units : []),
  };
  return { querySelectorAll: (sel) => (sel === ".knowledge-content > div" ? [block] : []) };
};

/* ---------------- URL / 路由 ---------------- */
console.log("URL 路由");
const CAT = "https://ai-smart-course-student-pro.zhihuishu.com/singleCourse/knowledgeStudy/2000000000000000001/250001";
const LEARN = "https://ai-smart-course-student-pro.zhihuishu.com/learnPage/2000000000000000001/2000000000000000002/250001";
const R = parseZhsCourseRoute(CAT);
ok(R && R.mode === "catalog" && R.courseId === "2000000000000000001" && R.clazzId === "250001", "目录页解析出 courseId/clazzId");
const L = parseZhsCourseRoute(LEARN);
ok(L && L.mode === "learn" && L.knowledgeId === "2000000000000000002", "学习页解析出 knowledgeId");
ok(parseZhsCourseRoute("https://ai-smart-course-student-pro.zhihuishu.com/weakTest?courseId=1&classId=2").mode === "weakTest", "weakTest 页识别");
ok(parseZhsCourseRoute("https://www.zhihuishu.com/") === null, "非新形态课程页返回 null");
const RT = "https://studentexamcomh5.zhihuishu.com/studentReviewTestOrExam/3600001/1/1/2000000000000000001/abc/1/true/true/true/1?classId=250001&paperId=449326957&reviewQ=2";
const RT_R = parseZhsCourseRoute(RT);
ok(RT_R && RT_R.mode === "reviewTest" && RT_R.courseId === "2000000000000000001" && RT_R.clazzId === "250001" && RT_R.paperId === "449326957", "复习测试页解析出 courseId/clazzId/paperId");
ok(isZhsReviewTestPage(RT) === true, "识别复习测试页");
ok(isZhsReviewTestPage("https://studentexamcomh5.zhihuishu.com/other") === false, "同 host 其它页不算");
ok(parseZhsCourseRoute("https://evil.example.com/?u=zhihuishu.com/learnPage/1/2/3") === null, "只看 host，不被路径参数骗");
ok(parseZhsCourseRoute("not a url") === null, "坏 URL 不抛异常");

/* ---------------- 目录解析 ---------------- */
console.log("目录解析（课程视频模块）");
const units = [
  unitEl("a1", "一、已完成的单元", "100%"),
  unitEl("a2", "二、未开始的单元", "0%"),
  unitEl("a3", "三、看了一半的单元", "40%"),
];
const parsed = parseZhsVideoUnits(catalogDoc(units));
ok(parsed.length === 3, "解析出 3 个知识单元");
ok(parsed[0].progress === 100 && parsed[2].progress === 40, "进度按百分比读成数字");
ok(parsed[2].title === "三、看了一半的单元", "标题取 item-title");
ok(parseZhsVideoUnits(catalogDoc([unitEl("x", "空进度", "")])).length === 1, "缺进度时按 0% 处理");
ok(parseZhsVideoUnits({ querySelectorAll: () => [] }).length === 0, "没有目录时返回空数组");

/* ---------------- 选下一个 ---------------- */
console.log("选下一个未完成单元");
const st = newZhsCourseState("c", "k");
ok(pickNextZhsUnit(parsed, st).id === "a2", "跳过 100% 的，选第一个未完成");
st.done.push("a2");
ok(pickNextZhsUnit(parsed, st).id === "a3", "done 里的跳过");
st.skipped.push("a3");
ok(pickNextZhsUnit(parsed, st) === null, "全部处理完返回 null");
st.skipped = [];
st.attempts = { a3: 2 };
ok(pickNextZhsUnit(parsed, st) === null, "重试次数用尽也跳过");
st.attempts = { a3: 1 };
ok(pickNextZhsUnit(parsed, st).id === "a3", "只试过 1 次仍可再进");

/* ---------------- 状态存取 / 过期 ---------------- */
console.log("中继状态");
const mem = new Map();
const storage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, v),
  removeItem: (k) => mem.delete(k),
};
const s2 = newZhsCourseState("c1", "k1");
saveZhsState(storage, s2);
ok(!!mem.get(ZHS_COURSE_STATE_KEY), "写入 localStorage 键");
ok(loadZhsState(storage).courseId === "c1", "读回 courseId");
ok(isZhsRelayActive(storage), "auto=true 时可自动接力");
const later = loadZhsState(storage, Date.now() + 7 * 60 * 60 * 1000);
ok(later === null, "超过 6 小时视为过期");
ok(!isZhsRelayActive(storage, Date.now() + 7 * 60 * 60 * 1000), "过期后不再自动接力");
clearZhsState(storage);
ok(loadZhsState(storage) === null, "clear 后读不到");
saveZhsState(storage, Object.assign(newZhsCourseState("c", "k"), { auto: false }));
ok(!isZhsRelayActive(storage), "auto=false 不自动接力");
ok(loadZhsState({ getItem: () => "not-json" }) === null, "坏 JSON 不抛异常");

/* ---------------- URL 构造 ---------------- */
console.log("URL 构造");
const us = newZhsCourseState("2000000000000000001", "250001");
ok(
  makeZhsLearnUrl(us, "2000000000000000002", "https://ai-smart-course-student-pro.zhihuishu.com") === LEARN,
  "学习页 URL 与真机一致"
);
ok(
  makeZhsCatalogUrl(us, "https://ai-smart-course-student-pro.zhihuishu.com") === CAT,
  "目录页 URL 与真机一致"
);
ok(formatDuration(558.255) === "9:18", "时长格式化 9:18");
ok(formatDuration(null) === "时长未知", "缺时长有兜底");

/* ---------------- 练习页解析 ---------------- */
console.log("练习页（weakTest）");
ok(isZhsWeakTestPage("https://ai-smart-course-student-pro.zhihuishu.com/weakTest?courseId=1") === true, "识别 weakTest");
ok(isZhsWeakTestPage("https://ai-smart-course-student-pro.zhihuishu.com/learnPage/1/2/3") === false, "其它页不算");
ok(inferZhsReviewType("【多选题】") === "多选题", "题型：多选");
ok(inferZhsReviewType("【判断题】") === "判断题", "题型：判断");
ok(inferZhsReviewType("") === "单选题", "题型缺省单选");

const optionEl = (text, checked = false) => ({
  textContent: text,
  querySelector: (sel) => {
    if (sel === "pre.preStyle") return textNode(text);
    if (sel === "input") return { checked };
    return null;
  },
});
const reviewRoot = {
  querySelector: (sel) => {
    if (sel === ".question-type") return textNode("【多选题】");
    if (sel === ".stem") return textNode("习近平新时代中国特色社会主义思想的主要内容包括（ ）。");
    return null;
  },
  querySelectorAll: (sel) => (sel.includes("checkbox-view") ? [optionEl("“六个必须坚持”"), optionEl("“十个明确”"), optionEl("“十四个坚持”"), optionEl("“十三个方面成就”")] : []),
};
const reviewDoc = { querySelectorAll: (sel) => (sel === ".question-preview" ? [reviewRoot] : []) };
const qs = parseZhsReviewQuestions(reviewDoc, "refer");
ok(qs.length === 1, "解析出 1 道题");
ok(qs[0].type === "多选题" && qs[0].optionsText.length === 4, "题型与 4 个选项");
ok(qs[0].title.includes("主要内容"), "题干正确");
ok(qs[0].options["“六个必须坚持”"] === qs[0].options[Object.keys(qs[0].options)[0]], "选项文本→DOM 映射");

/* ---------------- 复习测试/考试页解析 ---------------- */
console.log("复习测试页（studentReviewTestOrExam）");
const rtOption = (text, value) => ({
  tagName: "LABEL",
  matches: (sel) => String(sel).includes("label.el-checkbox"),
  querySelector: (sel) => {
    if (sel === "pre.preStyle") return textNode(text);
    if (sel === ".el-checkbox__label") return textNode(text);
    if (sel === "input") return { checked: false, value };
    return null;
  },
});
const rtRoot = {
  querySelector: (sel) => {
    if (sel === ".questionTitle .letterSortNum") return textNode(" 1. 多选题 ");
    if (sel === ".questionName .centent-pre pre.preStyle") return textNode("“两个确立”形成的依据是（ ）。");
    if (sel === ".questionName pre.preStyle") return null;
    if (sel === ".questionName") return textNode("1. 多选题 “两个确立”形成的依据是（ ）。");
    return null;
  },
  querySelectorAll: (sel) =>
    String(sel).includes("checkbox-view")
      ? [rtOption("依据一", "683219100"), rtOption("依据二", "683219101"), rtOption("依据三", "683219102")]
      : [],
};
const rtDoc = { querySelectorAll: (sel) => (sel === ".question-preview" ? [] : sel === ".questionContent" ? [rtRoot] : []) };
const rtQs = parseZhsReviewQuestions(rtDoc, "refer");
ok(rtQs.length === 1, "复习测试页解析出 1 道题");
ok(rtQs[0].type === "多选题" && rtQs[0].optionsText.length === 3, "题型与 3 个选项");
ok(rtQs[0].title === "“两个确立”形成的依据是（ ）。", "题干正确（不含题号/题型）");
ok(rtQs[0].options["依据二"] === rtQs[0].options[Object.keys(rtQs[0].options)[1]], "选项文本→label 映射");

// 选项元素本身就是 label 时，clickOption 直接点它，不再往里找
let rtClicks = 0;
const rtLabelSelf = { matches: (sel) => String(sel).includes("label.el-checkbox"), click: () => { rtClicks += 1; } };
new ZhsReviewAdapter().clickOption(rtLabelSelf);
ok(rtClicks === 1, "label 自身作为选项时直接点击一次");

// 换题指纹：题号/题干/选项数任一变化都要能看出来（面板据此自动重新解析）
const sigDoc = (num, stem, count) => ({
  querySelector: (sel) =>
    sel === ".questionContent"
      ? {
          querySelector: (inner) => {
            if (inner === ".questionTitle .letterSortNum") return textNode(num);
            if (inner === ".questionName .centent-pre pre.preStyle") return textNode(stem);
            return null;
          },
          querySelectorAll: () => new Array(count).fill({}),
        }
      : null,
});
ok(zhsReviewTestSignature(sigDoc(" 1. 单选题 ", "甲", 3)) === "1. 单选题|甲|3", "换题指纹: 题号/题干/选项数");
ok(zhsReviewTestSignature(sigDoc(" 2. 单选题 ", "甲", 3)) !== zhsReviewTestSignature(sigDoc(" 1. 单选题 ", "甲", 3)), "换题指纹随题号变化");
ok(zhsReviewTestSignature(sigDoc(" 1. 单选题 ", "甲\n  乙", 3)) === "1. 单选题|甲 乙|3", "换题指纹里题干空白归一");
ok(zhsReviewTestSignature({ querySelector: () => null }) === "", "页面上没有题目时指纹为空");

// 单选题在这页是自定义 ul.radio-view > li（没有 input，选中态是 i.checkedIcon）
const radioLi = (text, checked = false) => ({
  tagName: "LI",
  matches: () => false,
  querySelector: (sel) => {
    if (sel === "pre.preStyle") return null;
    if (sel === "div.preStyle") return textNode(text);
    if (sel === "input") return null;
    if (sel === "i.checkedIcon") return checked ? {} : null;
    return null;
  },
  click: () => {},
});
const radioRoot = {
  querySelector: (sel) => {
    if (sel === ".questionTitle .letterSortNum") return textNode(" 1. 单选题 ");
    if (sel === ".questionName .centent-pre pre.preStyle") return textNode("中国特色社会主义道路是（ ）");
    if (sel === ".questionName pre.preStyle") return null;
    if (sel === ".questionName") return textNode("1. 单选题 中国特色社会主义道路是（ ）");
    return null;
  },
  querySelectorAll: (sel) => {
    if (String(sel).includes("label.el-checkbox")) return [];
    if (String(sel).includes("ul.radio-view > li")) return [radioLi("实现途径"), radioLi("行动指南"), radioLi("根本保障")];
    return [];
  },
};
const radioDoc = { querySelectorAll: (sel) => (sel === ".question-preview" ? [] : sel === ".questionContent" ? [radioRoot] : []) };
const radioQs = parseZhsReviewQuestions(radioDoc, "refer");
ok(radioQs.length === 1 && radioQs[0].type === "单选题" && radioQs[0].optionsText.length === 3, "单选题解析出 3 个选项");
ok(radioQs[0].title === "中国特色社会主义道路是（ ）", "单选题题干正确");
let liClicks = 0;
const liChecked = radioLi("实现途径", true);
liChecked.click = () => { liClicks += 1; };
const liUnchecked = radioLi("行动指南", false);
liUnchecked.click = () => { liClicks += 1; };
const liAdapter = new ZhsReviewAdapter();
liAdapter.clickOptionIfNeeded(liChecked);
ok(liClicks === 0, "已选中的 li 不再点击");
liAdapter.clickOptionIfNeeded(liUnchecked);
ok(liClicks === 1, "未选中的 li 点一次");

/* ---------------- 选项点击: 只点 label 一次 ---------------- */
let labelClicks = 0;
let inputClicks = 0;
const fakeInput = { checked: false, click: () => { inputClicks += 1; } };
const fakeLabel = { click: () => { labelClicks += 1; fakeInput.checked = true; } };
const fakeOption = {
  querySelector: (sel) => (sel === "input" ? fakeInput : sel.includes("label") ? fakeLabel : null),
  click: () => {},
};
const clickAdapter = new ZhsReviewAdapter();
clickAdapter.clickOptionIfNeeded(fakeOption);
ok(labelClicks === 1 && inputClicks === 0, "只点 label 一次, 不补点 input(否则会取消刚勾上的)");
clickAdapter.clickOptionIfNeeded(fakeOption);
ok(labelClicks === 1 && inputClicks === 0, "已勾选的选项不再点");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
