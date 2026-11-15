// 油猴脚本头部(构建时拼到产物顶部)。
// 版本号单源: src/version.js(面板状态栏显示的是同一个值)。
// 0.5.x 线: 0.5.2 是历史上游离在仓库外的构建(带「抓本页」), 本次收编回仓库并修掉
//   runtime→panel.setAnswerRunning 的接口错位, 故版本号接着往上走。
import { VERSION } from "./version.js";

export const USERSCRIPT_HEADER = `// ==UserScript==
// @name         网课答题助手
// @namespace    local.net-course-answer
// @version      ${VERSION}
// @downloadURL  http://127.0.0.1:30146/%E7%BD%91%E8%AF%BE%E7%AD%94%E9%A2%98%E5%8A%A9%E6%89%8B.user.js
// @updateURL    http://127.0.0.1:30146/%E7%BD%91%E8%AF%BE%E7%AD%94%E9%A2%98%E5%8A%A9%E6%89%8B.user.js
// @author       local
// @description  识别网课题目→交给自建答题桥(OpenAI 兼容接口)作答→自动填选; 超星章节页与智慧树新形态课程页可自动刷视频任务点(自然播放, 不伪造心跳; 支持一章多任务点/新版泛雅3入口); 超星「AI助教」页可一题一会话提问并按字数自动赞/踩。面板内可一键抓取当前页的课件原件与题目/答案。仅供学习研究。
// @note         超星题面字体加密(font-cxsecret)已内置解密; 字形表走 @resource, 缺失时网络兜底。
// @license      MIT
// @match        *://*.chaoxing.com/*
// @match        *://*.zhihuishu.com/*
// @connect      127.0.0.1
// @connect      forestpolice.org
// @resource     ttf https://www.forestpolice.org/ttf/2.0/table.json
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getResourceText
// @grant        GM_getValue
// @grant        GM_info
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==
`;
