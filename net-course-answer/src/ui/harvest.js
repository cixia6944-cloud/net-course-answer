// 抓取模块: 「抓本页课件」+「抓本页题目」。
// 设计边界(重要, 改之前先读):
//   · 只读当前页面(含嵌套 iframe)已经渲染出来的东西 —— 不翻页、不点任务点、不点提交、不发任何网络请求;
//   · 课件: 把页面自己的 fileinfo.download 地址交给浏览器下载, 原件由浏览器去取;
//   · 题目: 落两份同名文件(.md 给人看 / .json 供入库); 剪贴板只在前两者都失败时兜底。
// 为什么落文件而不是只复制: 用户明确要「复制而不是转成 JSON」的反面 —— 课件走下载、题目走剪贴板, 两种产出形态不一致, 统一成文件。
import { CX_STUDY_SEL } from "../contract/cx-study-contract.js";
import { gm, sleepMs } from "../vendor/gm.js";

const HV_SEL = CX_STUDY_SEL.harvest;

const HV_CSS = `
.nca-hv-bar{display:flex;gap:6px;padding:0 0 8px;flex:none}
.nca-hv-bar .nca-btn{flex:1;min-height:30px;font-size:12px}
.nca-hv-bar .nca-btn:disabled{opacity:.5;cursor:not-allowed}
.nca-hv-tip{font-size:11px;color:var(--nca-fg-3);padding:0 2px 7px;line-height:1.5}
`;

/* ------------------------------------------------------------------ *
 * 1. 遍历 iframe 层
 * ------------------------------------------------------------------ */

/**
 * 递归遍历 window.frames, 收集每一层的可读信息。
 * 跨域一律 try/catch 跳过(超星课件/视频都是同源, 但别赌)。
 * @returns {Array<{path:string,depth:number,url:string,title:string,hasFileinfo:boolean,download:string,fn:Window}>}
 */
export function hvWalkFrames(win) {
  const out = [];
  const seen = new Set();
  const walk = (w, path, depth) => {
    if (!w || depth > HV_SEL.maxFrameDepth || seen.has(w)) return;
    seen.add(w);
    let url = "";
    let title = "";
    let hasFileinfo = false;
    let download = "";
    let tiMu = 0;
    try {
      url = String((w.location && w.location.href) || "");
    } catch (e) {}
    try {
      const d = w.document;
      title = String((d && d.title) || "");
      tiMu = hvQuestionEls(d).length;
    } catch (e) {}
    // 课件层的判据: 页面自己挂了 fileinfo(对象里带 download 地址)
    try {
      const fi = w.fileinfo;
      if (fi && typeof fi === "object") {
        hasFileinfo = true;
        download = String(fi.download || fi.downPath || fi.url || "");
      }
    } catch (e) {}
    out.push({ path, depth, url, title, hasFileinfo, download, tiMu, fn: w });
    let frames = null;
    try {
      frames = w.frames;
    } catch (e) {}
    if (!frames) return;
    let n = 0;
    try {
      n = frames.length;
    } catch (e) {
      return;
    }
    for (let i = 0; i < n; i++) {
      let child = null;
      try {
        child = frames[i];
      } catch (e) {}
      if (child) walk(child, `${path}/${i}`, depth + 1);
    }
  };
  walk(win, "top", 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. 读题目
 * ------------------------------------------------------------------ */

const hvText = (el) => (el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "");

/** 在 box 里按候选选择器顺序找第一个有文字的元素, 返回文字(找不到返回 "") */
function hvFirstText(box, sels) {
  if (!box || !box.querySelector) return "";
  for (const sel of sels) {
    let el = null;
    try {
      el = box.querySelector(sel);
    } catch (e) {}
    if (!el) continue;
    const t = hvText(el);
    if (t) return t;
  }
  return "";
}

/**
 * 选出"每道题"的容器。
 *
 * 为什么不能直接用 querySelectorAll(第一个选择器):
 *   作业详情页里 .TiMu 是**整页容器**(#fanyaMarking), 全页只有一个 ——
 *   直接拿来当每题容器会把 37 道题当成 1 道题, 只读到第一个 .qtContent,
 *   答案还会靠全页 querySelector 从别的题上乱捞(实测踩过, 见 v0.5.4 报障)。
 * 所以命中后再剔除"外层壳": 内部还套着同选择器的, 或装了不止一个题干的。
 */
function hvQuestionEls(doc) {
  if (!doc || !doc.querySelectorAll) return [];
  for (const sel of HV_SEL.question) {
    let els = [];
    try {
      els = Array.from(doc.querySelectorAll(sel));
    } catch (e) {
      continue;
    }
    if (!els.length) continue;
    const kept = els.filter((el) => {
      let nested = 0;
      try {
        nested = el.querySelectorAll(sel).length;
      } catch (e) {}
      if (nested > 0) return false; // 里面还套着同名的 → 它是壳
      let stems = 0;
      for (const stemSel of HV_SEL.stem) {
        try {
          stems = el.querySelectorAll(stemSel).length;
        } catch (e) {}
        if (stems) break;
      }
      return stems <= 1; // 装了好几个题干 → 它是壳
    });
    // 全被剔掉说明这个形态就是"一页一个容器", 原样返回(上层会记警告)而不是返回空
    return kept.length ? kept : els;
  }
  return [];
}

/** 题型徽标文字(去掉括号): "(单选题)" → "单选题" */
function hvTypeText(box) {
  if (!box || !box.querySelector) return "";
  for (const sel of HV_SEL.typeBadge) {
    let el = null;
    try {
      el = box.querySelector(sel);
    } catch (e) {}
    if (!el) continue;
    const t = hvText(el);
    if (t) return t.replace(/[()（）[\]]/g, "").trim();
  }
  return "";
}

/** 题干正文: 取第一个有内容的 stem 容器, 落在里面的题型徽标要扣掉 */
function hvStem(box) {
  if (!box || !box.querySelector) return "";
  let el = null;
  for (const sel of HV_SEL.stem) {
    let hit = null;
    try {
      hit = box.querySelector(sel);
    } catch (e) {}
    if (hit && hvText(hit)) {
      el = hit;
      break;
    }
  }
  if (!el) return "";
  let full = hvText(el);
  for (const bsel of HV_SEL.typeBadge) {
    let b = null;
    try {
      b = el.querySelector(bsel);
    } catch (e) {}
    if (!b) continue;
    const t = hvText(b);
    if (!t) continue;
    if (full.startsWith(t)) full = full.slice(t.length).trim();
    else if (full.includes(t)) full = full.split(t).join("").trim();
    break;
  }
  return full.trim();
}

/**
 * 剥掉选项文本开头的「字母+分隔符」前缀。
 * 为什么要循环: 作业详情页是 `<li>A. <p><span>A</span>．文本</p></li>` —— 字母出现**两次**,
 * 剥一次会留下 "A．文本"(实测 v0.5.5 输出就是这个样子)。上限 2 层, 不无限剥。
 */
function hvStripLetter(text, max = 2) {
  let out = String(text || "");
  for (let i = 0; i < max; i++) {
    const m = /^\s*[A-Za-z]\s*[、.．:：)）]\s*/.exec(out);
    if (!m) break;
    out = out.slice(m[0].length);
  }
  return out.trim();
}

/**
 * 选项: 用第一个命中的选择器(不混用不同页面形态的 li)。
 * 两种写法都支持: ① <li><i>A</i><a>文本</a></li>  ② <li>A. 文本</li>
 */
function hvOptions(box) {
  const out = [];
  if (!box || !box.querySelectorAll) return out;
  for (const sel of HV_SEL.options) {
    let items = [];
    try {
      items = Array.from(box.querySelectorAll(sel));
    } catch (e) {
      continue;
    }
    if (!items.length) continue;
    items.forEach((li, idx) => {
      const raw = hvText(li);
      // ① 做题页: 字母在 <i> 里
      let domLetter = "";
      try {
        const i = li.querySelector("i");
        if (i) domLetter = hvText(i).replace(/[^A-Za-z]/g, "");
      } catch (e) {}
      // ② 作业详情页: 字母和分隔符都混在文本里
      const lead = /^\s*([A-Za-z])\s*[、.．:：)）]\s*/.exec(raw);
      const letter = domLetter || (lead ? lead[1] : "") || String.fromCharCode(65 + idx);
      let text = hvStripLetter(raw);
      if (domLetter && text.startsWith(domLetter) && !/^[A-Za-z]\s*[、.．:：)）]/.test(text)) {
        text = text.slice(domLetter.length).trim();
      }
      if (!text) {
        try {
          const a = li.querySelector("a");
          if (a) text = hvText(a);
        } catch (e) {}
      }
      out.push({ letter: letter.toUpperCase(), text });
    });
    return out;
  }
  return out;
}

/**
 * 读一层 document 里的所有题目。
 * @returns {Array<Object>} 每题: {qid,typeText,type,stem,options,myAnswer,rightAnswer,score,marked,encrypted}
 */
export function hvReadQuestions(w) {
  let doc = null;
  try {
    doc = w && w.document;
  } catch (e) {
    return [];
  }
  if (!doc || !doc.querySelectorAll) return [];
  const boxes = hvQuestionEls(doc);
  return boxes.map((box) => {
    const typeText = hvTypeText(box);
    const myAnswer = hvFirstText(box, HV_SEL.myAnswer);
    const rightAnswer = hvFirstText(box, HV_SEL.rightAnswer);
    // 分值可能带「分」字(作业详情页是 "0分")
    const score = hvFirstText(box, HV_SEL.score).replace(/分/g, "").trim();
    let marked = "";
    try {
      if (box.querySelector(HV_SEL.markDui)) marked = "对";
      else if (box.querySelector(HV_SEL.markCuo)) marked = "错";
    } catch (e) {}
    // qid: 超星把题号挂在 data 属性上(作业详情页 id=question402285040 / data=402285040)
    let qid = "";
    try {
      qid = String(box.getAttribute("data") || box.getAttribute("data-qid") || box.id || "");
    } catch (e) {}
    const stemEl = (() => {
      for (const sel of HV_SEL.stem) {
        let hit = null;
        try {
          hit = box.querySelector(sel);
        } catch (e) {}
        if (hit) return hit;
      }
      return null;
    })();
    const stem = hvStem(box);
    const options = hvOptions(box);
    // 题干/选项是图片题时 textContent 本来就是空的 —— 要能分辨"图片题"和"选择器失效"
    let stemImage = false;
    let optionImage = false;
    try {
      stemImage = !!(stemEl && stemEl.querySelector && stemEl.querySelector("img"));
      if (!optionImage) {
        for (const sel of HV_SEL.options) {
          const first = box.querySelector(sel);
          if (first) {
            optionImage = !!(first.querySelector && first.querySelector("img"));
            break;
          }
        }
      }
    } catch (e) {}
    // 本题缺什么, 逐题说清楚(而不是整份文件静默空着)
    const gaps = [];
    if (!stem && !stemImage) gaps.push("题干未读到");
    if (!stem && stemImage) gaps.push("题干是图片, 未提取文字");
    if (!options.length && optionImage) gaps.push("选项是图片");
    if (!options.length && !optionImage) gaps.push("选项未读到");
    return {
      qid,
      typeText,
      type: hvTypeOf(typeText),
      stem,
      options,
      myAnswer,
      rightAnswer,
      score,
      marked,
      stemImage,
      // 题面字体加密时题干会是乱码 —— 标记出来, 免得存进题库还以为是原文
      encrypted: !!(stemEl && stemEl.querySelector && stemEl.querySelector(`.${CX_STUDY_SEL.font.secretClass}`)),
      gaps,
    };
  });
}

/** 题型文字 → 稳定的英文键(给 json 入库用; 拿不到就 unknown) */
function hvTypeOf(text) {
  const t = String(text || "");
  if (/单选/.test(t)) return "single";
  if (/多选/.test(t)) return "multiple";
  if (/判断/.test(t)) return "judge";
  if (/填空/.test(t)) return "fill";
  if (/简答|问答|论述/.test(t)) return "essay";
  return "unknown";
}

/* ------------------------------------------------------------------ *
 * 3. 输出: 文件 / 剪贴板
 * ------------------------------------------------------------------ */

/** 文件名里不能出现的字符 */
export function hvName(s) {
  const t = String(s || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return t || "题目";
}

/** yyyyMMdd-HHmmss */
export function hvStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把文本交给浏览器下载。
 * @returns {boolean} true = 已交给浏览器; **落没落盘、落到哪个目录, 脚本看不到**
 */
export function hvSave(name, text, mime = "text/plain;charset=utf-8") {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }, 30000);
    return true;
  } catch (e) {
    return false;
  }
}

/** 剪贴板三级兜底: GM → navigator.clipboard → execCommand。返回用了哪级, 全失败返回 "" */
export async function hvCopy(text) {
  try {
    if (gm.setClipboard) {
      gm.setClipboard(text, "text");
      return "gm";
    }
  } catch (e) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return "navigator";
    }
  } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return "exec";
  } catch (e) {}
  return "";
}

/**
 * 题目 → Markdown(给人看)。
 * 两栏是页面各自文本, 本文件不做判断、不改写。
 */
export function hvToMd(qs, meta = {}) {
  const L = [];
  L.push(`# 题目 · ${meta.title || "(无标题)"}`);
  L.push("");
  L.push("## 来源");
  L.push("");
  L.push("| 项 | 值 |");
  L.push("| --- | --- |");
  L.push(`| 页面标题 | ${meta.title || ""} |`);
  L.push(`| 题目层 | ${meta.layer || ""} |`);
  L.push(`| 层地址 | ${meta.layerUrl || ""} |`);
  L.push(`| 抓取时间 | ${meta.time || ""} |`);
  L.push(`| 题数 | ${qs.length} |`);
  L.push("");
  if (Array.isArray(meta.warnings) && meta.warnings.length) {
    L.push("> ⚠️ 结构可能变了，以下字段整份读空：");
    meta.warnings.forEach((wn) => L.push(`> - ${wn}`));
    L.push("");
  }
  if (Array.isArray(meta.notes) && meta.notes.length) {
    L.push("> 说明（非故障：这几题页面上本来就没有对应文字）：");
    meta.notes.forEach((n) => L.push(`> - ${n}`));
    L.push("");
  }
  L.push("> 两栏是页面各自文本，本文件不做判断、不改写。");
  L.push("");
  qs.forEach((q, i) => {
    L.push(`## 第${i + 1}题【${q.typeText || "未知题型"}】`);
    L.push("");
    if (q.myAnswer) L.push(`- 我的答案：${q.myAnswer}`);
    if (q.rightAnswer) L.push(`- 正确答案：${q.rightAnswer}`);
    if (q.score) L.push(`- 分值：${q.score}`);
    if (q.marked) L.push(`- 对错标记：${q.marked}`);
    if (q.encrypted) L.push("- ⚠️ 题面字体加密未解密，题干可能是乱码");
    if (Array.isArray(q.gaps) && q.gaps.length) L.push(`- ⚠️ ${q.gaps.join("；")}`);
    L.push("");
    L.push(q.stem || "(题干为空)");
    L.push("");
    if (q.options.length) {
      q.options.forEach((o) => L.push(`- ${o.letter}、${o.text}`));
      L.push("");
    }
  });
  return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * 4. 两个动作
 * ------------------------------------------------------------------ */

/** 抓本页课件: 找第一个带 fileinfo.download 的层, 交给浏览器下载 */
export async function hvGrabCourseware(win, log = () => {}) {
  const layers = hvWalkFrames(win);
  const hit = layers.find((l) => l.hasFileinfo && l.download);
  if (!hit) {
    log("没找到课件: 当前页面没有 fileinfo.download(可能不是课件任务点)", "warning");
    return { ok: false, reason: "no-courseware" };
  }
  // 隐藏 iframe 让浏览器自己发这个下载请求 —— 不在脚本里 fetch, 免得撞 CORS/Referer 校验
  try {
    const ifr = document.createElement("iframe");
    ifr.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0";
    ifr.src = hit.download;
    document.body.appendChild(ifr);
    setTimeout(() => {
      try {
        ifr.remove();
      } catch (e) {}
    }, 60000);
  } catch (e) {
    log(`课件下载失败: ${e && e.message}`, "danger");
    return { ok: false, reason: "iframe-failed" };
  }
  const name = hit.download.split("/").pop().split("?")[0] || "(未知文件名)";
  log(`已把课件原件交给浏览器下载: ${decodeURIComponent(name)}`, "success");
  log("脚本看不到实际落盘, 请到浏览器下载列表确认", "primary");
  return { ok: true, url: hit.download, name };
}

/**
 * 结构漂移自曝: 某个字段在所有题上都读空, 基本就是页面结构变了。
 * 这时必须说出来 —— 半截成功比彻底失败更难查(v0.5.4 的坑: 37 道题只读到 1 道, 却没有一句提示)。
 * @returns {string[]} 人话警告
 */
/**
 * 结构漂移警告: 只有"**整份都读空**"才算故障 —— 那说明选择器对不上页面。
 * 少数题缺内容属于页面本身(空题/图片题/非常规结构), 归到 hvGapNotes 的温和说明里,
 * 不要混进这个警报 —— 否则用户会以为抓取坏了(实测反馈过这一点)。
 * @returns {string[]} 需要当故障处理的问题
 */
function hvDriftWarnings(qs) {
  const out = [];
  if (!qs.length) return out;
  if (qs.length === 1) {
    out.push("只读到 1 道题: 若页面上题目更多, 说明每题容器选择器不对");
  }
  const fields = [
    ["typeText", "题型"],
    ["myAnswer", "我的答案"],
    ["rightAnswer", "正确答案"],
    ["score", "分值"],
  ];
  for (const [key, label] of fields) {
    if (qs.every((q) => !q[key])) out.push(`${label}全空: 选择器可能与页面结构不符`);
  }
  if (qs.every((q) => !q.stem)) {
    out.push(qs.every((q) => q.stemImage) ? "题干全是图片, 没有可提取的文字" : "题干全空: 选择器可能与页面结构不符");
  }
  if (qs.every((q) => !q.options.length)) {
    out.push("选项全空: 选择器可能与页面结构不符");
  }
  return out;
}

/**
 * 逐题缺内容的温和说明(不是故障)。
 * 按「缺什么」聚合题号, 一行说完。
 * @returns {string[]} 例如 ["第 31、32 题: 页面上没有可提取的题干文字"]
 */
function hvGapNotes(qs) {
  const byGap = new Map();
  qs.forEach((q, i) => {
    (q.gaps || []).forEach((g) => {
      if (!byGap.has(g)) byGap.set(g, []);
      byGap.get(g).push(i + 1);
    });
  });
  const out = [];
  for (const [gap, idxs] of byGap) {
    if (idxs.length >= qs.length) continue; // 全部都有 → 已由 hvDriftWarnings 报警
    const list = idxs.length > 8 ? `${idxs.slice(0, 8).join("、")} 等 ${idxs.length}` : idxs.join("、");
    out.push(`第 ${list} 题: ${gap}`);
  }
  return out;
}

/** 抓本页题目: 落 .md + .json; 两份都发不出去才用剪贴板兜底 */
export async function hvGrabQuestions(win, log = () => {}) {
  const layers = hvWalkFrames(win);
  // 优先取题目最多的那层(顶层常常只有一个 iframe 壳)
  let best = null;
  let bestQs = [];
  for (const l of layers) {
    if (!l.tiMu) continue;
    const qs = hvReadQuestions(l.fn);
    if (qs.length > bestQs.length) {
      best = l;
      bestQs = qs;
    }
  }
  if (!best || !bestQs.length) {
    log(`没读到题目: 页面上找不到 ${HV_SEL.question.join(" / ")} 容器(可能不是作业/测验页)`, "warning");
    return { ok: false, reason: "no-questions" };
  }

  const warnings = hvDriftWarnings(bestQs);
  const notes = hvGapNotes(bestQs);
  const time = new Date().toLocaleString();
  const payload = {
    _capture: {
      source: "nca-harvest",
      time,
      startUrl: String((win.location && win.location.href) || ""),
      layer: best.path,
      layerUrl: best.url,
      selectorHits: { question: HV_SEL.question, questions: bestQs.length, layers: layers.length },
      kept: bestQs.length,
      warnings,
      notes,
    },
    questions: bestQs,
  };
  const meta = {
    title: String((win.document && win.document.title) || ""),
    layer: best.path,
    layerUrl: best.url,
    time,
    warnings,
    notes,
  };
  const stem = `${hvName(meta.title)}-${hvStamp()}`;
  const md = hvToMd(bestQs, meta);
  const json = JSON.stringify(payload, null, 2);

  const okMd = hvSave(`${stem}.md`, md, "text/markdown;charset=utf-8");
  await sleepMs(200); // 连发两个文件时给浏览器一点间隔, 否则第二个容易被拦
  const okJson = hvSave(`${stem}.json`, json, "application/json;charset=utf-8");

  if (okMd || okJson) {
    log(`已把 ${stem}.md 与 ${stem}.json 交给浏览器保存到下载文件夹`, "success");
    log("浏览器可能弹一次「允许多个文件下载」; 脚本看不到实际落盘, 请到下载列表确认", "primary");
  } else {
    const how = await hvCopy(md);
    if (how) log(`文件下载不可用, 已把 Markdown 复制到剪贴板(经 ${how})`, "warning");
    else log("文件下载与剪贴板都失败, 请用「复制日志」把逐题日志手工粘出来", "danger");
  }

  // 结构漂移才是故障, 红字喊出来
  if (warnings.length) {
    log(`⚠ 抓到 ${bestQs.length} 题, 但有几项整份读空(把面板日志贴给 agent 即可定位): ${warnings.join("; ")}`, "danger");
  }
  // 少数题本身没内容 → 温和说明, 不当故障
  if (notes.length) {
    log(`说明(非故障): ${notes.join("; ")}`, "primary");
  }

  // 逐题打一行, 无论文件成没成功都打 —— 这是用户核对答案最快的路径
  bestQs.forEach((q, i) => {
    const parts = [`第${i + 1}题【${q.typeText || "?"}】`];
    if (q.myAnswer) parts.push(`我的答案: ${q.myAnswer}`);
    if (q.rightAnswer) parts.push(`正确答案: ${q.rightAnswer}`);
    if (q.score) parts.push(`(${q.score}分)`);
    log(parts.join("  "), q.marked === "错" ? "warning" : "primary");
  });

  return { ok: true, count: bestQs.length, stem, layers: layers.length, warnings, notes };
}

/* ------------------------------------------------------------------ *
 * 5. 挂到面板
 * ------------------------------------------------------------------ */

/**
 * 往面板里插一条抓取按钮栏(幂等: 已有 .nca-hv-bar 就直接返回)。
 * 插在 .nca-tabs 之前 —— 这样面板折叠时它跟着一起隐藏。
 */
export function mountHarvestBar(panel, deps = {}) {
  if (!panel || !panel.root) return false;
  if (panel.root.querySelector(".nca-hv-bar")) return true;
  const body = panel.root.querySelector(".nca-body");
  const tabs = panel.root.querySelector(".nca-tabs");
  if (!body || !tabs) return false;

  const win = deps.win || window;
  const log = deps.log || ((m, t) => panel.log(m, t));

  if (gm.addStyle) gm.addStyle(HV_CSS);
  else {
    const st = document.createElement("style");
    st.textContent = HV_CSS;
    // head 不一定在(document-end 之前被换掉过), 退回 documentElement 兜底
    const host = document.head || document.documentElement;
    if (host) host.appendChild(st);
  }

  const bar = document.createElement("div");
  bar.className = "nca-hv-bar";
  const mkBtn = (cls, text, title) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.title = title;
    bar.appendChild(b);
    return b;
  };
  const btnCw = mkBtn("nca-btn nca-hv-cw", "抓本页课件", "把当前页面这个任务点的课件原件交给浏览器下载");
  const btnQ = mkBtn("nca-btn nca-hv-q", "抓本页题目", "把当前页已批阅的题目与答案落成 .md + .json");
  const tip = document.createElement("div");
  tip.className = "nca-hv-tip";
  tip.textContent = "停在哪页抓哪页；课件抓本页全部";

  body.insertBefore(tip, tabs);
  body.insertBefore(bar, tip);

  // 防连点: 各自冷却, 避免一抖手发一串下载
  let cwBusy = 0;
  let qBusy = 0;

  btnCw.addEventListener("click", async () => {
    const now = Date.now();
    if (now - cwBusy < 1500) return;
    cwBusy = now;
    btnCw.disabled = true;
    try {
      await hvGrabCourseware(win, log);
    } catch (e) {
      log(`抓课件异常: ${e && e.message}`, "danger");
    } finally {
      setTimeout(() => {
        btnCw.disabled = false;
      }, 1500);
    }
  });

  btnQ.addEventListener("click", async () => {
    const now = Date.now();
    if (now - qBusy < 800) return;
    qBusy = now;
    btnQ.disabled = true;
    try {
      await hvGrabQuestions(win, log);
    } catch (e) {
      log(`抓题目异常: ${e && e.message}`, "danger");
    } finally {
      setTimeout(() => {
        btnQ.disabled = false;
      }, 800);
    }
  });

  return true;
}
