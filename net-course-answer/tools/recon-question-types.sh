#!/usr/bin/env bash
# 题型全集侦查: 在采集 profile(CDP 9222)里逐份打开作业/测验, 抽取"题型契约"
# 用法: bash tools/recon-question-types.sh <名字> <URL>
#   → 存 <项目根>\情报\题型-<名字>.{dom.json,a11y.txt,png,har}
set -uo pipefail
AB="/mnt/c/Users/<user>/AppData/Roaming/npm/node_modules/agent-browser"
N="/mnt/c/Program Files/nodejs/node.exe"
# 路径按脚本位置推导 —— 整个项目文件夹搬到哪都能用
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # …/net-course-answer/tools
REPO="$(dirname "$HERE")"
PROJ="$(dirname "$REPO")"                                # …/网课答题助手
OUT="$PROJ/情报"
win() { wslpath -w "$1" | sed 's|\\|/|g'; }               # Windows 程序只认 C:/… (别传 /mnt/c!)
OUT_WIN="$(win "$OUT")"
PORT="${CDP_PORT:-9222}"

ab() { (cd "$AB" && "$N" bin/agent-browser.js --cdp "$PORT" "$@"); }
say() { printf "\033[36m[题型]\033[0m %s\n" "$*"; }

name="${1:?名字}"; url="${2:-}"
mkdir -p "$OUT"

# 题型探针: 统计页面上每种题型的容器/选项/输入控件, 并给出样本
PROBE='(()=>{
  const clean=(s,n=90)=>String(s==null?"":s).replace(/\s+/g," ").trim().slice(0,n);
  // 递归找"含题目容器"的文档(超星题目常在多层 iframe 里)
  const QSEL=".TiMu,.questionLi,.examPaper_subject,[class*=TiMu],[class*=questionLi]";
  let found=null, foundPath="";
  const seen=new Set();
  const walk=(w,path,d)=>{
    if(d>4||found)return;
    let doc;try{doc=w.document}catch(e){return}
    if(!doc||seen.has(doc))return; seen.add(doc);
    try{ if(doc.querySelectorAll(QSEL).length){found=doc;foundPath=path;return} }catch(e){}
    let fs=[];try{fs=[...doc.querySelectorAll("iframe")]}catch(e){}
    for(const f of fs){
      let w2=null;try{w2=f.contentWindow}catch(e){}
      if(w2) walk(w2, path+">"+((f.getAttribute("src")||"?").split("?")[0].split("/").slice(-2).join("/")), d+1);
      if(found)return;
    }
  };
  walk(window,"top",0);
  if(!found){ // 退一步: 顶层任何题型字样
    const t=(document.body.innerText||"");
    return JSON.stringify({url:location.href,noQuestionContainer:true,typeWords:[...new Set((t.match(/【[^】]{2,8}】/g)||[]))].slice(0,12),bodyHead:clean(t,300)},null,1);
  }
  const rows=[...found.querySelectorAll(QSEL)];
  const out=rows.map((el,i)=>{
    const txt=clean(el.innerText,320);
    const typeWord=(txt.match(/【([^】]{2,10})】/)||[])[1]||null;
    const headWord=(txt.match(/^[一二三四五六七八九十]\.\s*(单选题|多选题|判断题|填空题|简答题|论述题|计算题|名词解释|连线题|排序题|其他)[（(]?/)||[])[1]||null;
    const radios=el.querySelectorAll("li[role=radio],input[type=radio],.before-after").length;
    const checks=el.querySelectorAll("li[role=checkbox],input[type=checkbox],.before-after-checkbox").length;
    const areas=el.querySelectorAll("textarea").length;
    const texts=el.querySelectorAll("input[type=text],input:not([type])").length;
    const editor=!!el.querySelector(".edui-editor,[class*=edui],[contenteditable=true]");
    const blanks=(txt.match(/(_{2,}|（\s*）|\(\s*\))/g)||[]).length;
    let guess="?";
    if(checks>0)guess="多选";
    else if(radios>0)guess="单选";
    else if(areas>0||editor)guess="填空/简答(富文本)";
    else if(texts>0)guess="填空(输入框)";
    return {i,typeWord,headWord,guess,radios,checks,areas,texts,editor,blanks,
      ansBox:(el.querySelector("input[id^=answer]")||{}).id||null,
      cls:clean(el.className,44), sample:txt.slice(0,120)};
  });
  const counts={};for(const r of out){const k=r.typeWord||r.headWord||r.guess;counts[k]=(counts[k]||0)+1}
  return JSON.stringify({
    url:location.href, title:found.title, docPath:foundPath, total:rows.length, counts, items:out,
    globals:{UE:typeof found.defaultView.UE!=="undefined",jQuery:typeof found.defaultView.jQuery!=="undefined"},
    inputs:{textarea:found.querySelectorAll("textarea").length,text:found.querySelectorAll("input[type=text]").length,
      hiddenAnswer:found.querySelectorAll("input[id^=answer]").length,radio:found.querySelectorAll("input[type=radio]").length,
      checkbox:found.querySelectorAll("input[type=checkbox]").length},
    typeHeadline:[...new Set((found.body.innerText||"").match(/[一二三四五六七八九十]\.\s*[^（(\n]{2,10}[（(]共\d+题[）)]/g)||[]))]
  },null,1);
})()'

say "采集: $name"
ab console --clear >/dev/null 2>&1
ab network har stop "$OUT_WIN/_prev.har" >/dev/null 2>&1
ab network har start >/dev/null 2>&1
if [ -n "$url" ]; then ab open "$url" >/dev/null 2>&1; fi
sleep 10
ab eval "$PROBE" > "$OUT/题型-$name.dom.json" 2>/dev/null
"$N" "$REPO/tools/collect-normalize.mjs" "$OUT_WIN/题型-$name.dom.json" >/dev/null 2>&1
ab snapshot > "$OUT/题型-$name.a11y.txt" 2>/dev/null
ab screenshot "$OUT_WIN/题型-$name.png" >/dev/null 2>&1
ab network har stop "$OUT_WIN/题型-$name.har" >/dev/null 2>&1
say "存盘: 题型-$name.{dom.json,a11y.txt,png,har}"
"$N" -e '
const fs=require("fs");const p=process.argv[1];
try{const j=JSON.parse(fs.readFileSync(p,"utf8"));
  console.log("  URL :",String(j.url||"").slice(0,100));
  console.log("  题数:",j.total,"  题型分布:",JSON.stringify(j.counts||{}));
  console.log("  控件:",JSON.stringify(j.inputs||{}),"  全局:",JSON.stringify(j.globals||{}));
  (j.items||[]).slice(0,12).forEach(it=>console.log("   #"+(it.i+1)+" ["+(it.typeWord||it.guess)+"] r="+it.radios+" c="+it.checks+" ta="+it.areas+" inp="+it.inputs+" ed="+(it.editor?1:0)+" → "+it.sample.slice(0,60)));
}catch(e){console.log("  (解析失败:",e.message,")")}' "$OUT_WIN/题型-$name.dom.json"
