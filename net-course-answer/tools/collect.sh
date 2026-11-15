#!/usr/bin/env bash
# 只读采集器: 到达目标状态由人来点(或已有脚本), 采集合围交给本脚本。
# 全程只读: 只用 open / network har / snapshot / eval / console / screenshot —— 不点提交、不点开始考试。
#
# 前置: 专用采集 Edge 已带 CDP 起好(见 一手侦察记录(未随仓库分发) 第 0 步)
#
# 用法:
#   bash tools/collect.sh begin <名字> [URL]    # 清 console + 开 HAR + (可选)打开 URL
#   ...你手动把页面点到目标状态(弹题弹出/课件翻页/交卷确认层出现)...
#   bash tools/collect.sh end   <名字>          # 停 HAR + 存 a11y树/DOM契约/console/截图 → <项目根>\情报\
#   bash tools/collect.sh peek [名字]           # 不看 HAR, 直接看当前已发出的请求(排查用)
set -uo pipefail

AB_DIR="/mnt/c/Users/<user>/AppData/Roaming/npm/node_modules/agent-browser"
NODE="/mnt/c/Program Files/nodejs/node.exe"
# 路径全部按脚本位置推导 —— 整个项目文件夹搬到哪都能用
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # …/net-course-answer/tools
REPO="$(dirname "$HERE")"                                # WSL 侧(bash 读文件用)
PROJ="$(dirname "$REPO")"                                # …/网课答题助手
OUT="$PROJ/情报"                                         # WSL 侧(bash 用)
win() { wslpath -w "$1" | sed 's|\\|/|g'; }               # Windows 程序只认 C:/… (别传 /mnt/c!)
REPO_WIN="$(win "$REPO")"                                # Windows 侧(node 用)
OUT_WIN="$(win "$OUT")"                                  # Windows 侧(agent-browser / node 用)
PORT="${CDP_PORT:-9222}"

ab() { (cd "$AB_DIR" && "$NODE" bin/agent-browser.js --cdp "$PORT" "$@"); }
say() { printf "\033[36m[采集]\033[0m %s\n" "$*"; }
warn() { printf "\033[33m[注意]\033[0m %s\n" "$*"; }

cmd="${1:-}"; name="${2:-}"; arg3="${3:-}"

case "$cmd" in
  begin)
    [ -n "$name" ] || { echo "用法: bash tools/collect.sh begin <名字> [URL]"; exit 1; }
    mkdir -p "$OUT"
    say "启动采集: $name"
    ab console --clear >/dev/null 2>&1
    ab network har stop "$OUT_WIN/_prev.har" >/dev/null 2>&1   # 先停掉可能残留的录制
    ab network har start >/dev/null 2>&1 || warn "har start 失败"
    say "HAR 录制已开始(每次 begin 都是全新一段)"
    if [ -n "$arg3" ]; then
      say "打开 $arg3"
      ab open "$arg3" >/dev/null 2>&1
    fi
    sleep 2
    ab eval "document.title + ' | ' + location.href" 2>/dev/null | tail -1
    echo
    say "HAR 已在录。请手动把页面点到目标状态(只读操作), 完成后运行:"
    echo "      bash tools/collect.sh end $name"
    ;;

  end)
    [ -n "$name" ] || { echo "用法: bash tools/collect.sh end <名字>"; exit 1; }
    mkdir -p "$OUT"
    say "收口: $name"
    ab network har stop "$OUT_WIN/$name.har" >/dev/null 2>&1 && say "HAR → $OUT/$name.har"
    ab snapshot > "$OUT/$name.a11y.txt" 2>/dev/null && say "无障碍树 → $name.a11y.txt ($(wc -c < "$OUT/$name.a11y.txt") B)"
    ab eval --stdin < "$REPO/tools/dom-contract.js" > "$OUT/$name.dom.json" 2>/dev/null && say "DOM 契约 → $name.dom.json ($(wc -c < "$OUT/$name.dom.json") B)"
    ab eval "JSON.stringify({url:location.href,title:document.title})" > "$OUT/$name.meta.json" 2>/dev/null
    # eval 回来的是带转义的 JSON 字符串 → 归一化
    "$NODE" "$REPO_WIN/tools/collect-normalize.mjs" "$OUT_WIN/$name.dom.json" >/dev/null 2>&1
    "$NODE" "$REPO_WIN/tools/collect-normalize.mjs" "$OUT_WIN/$name.meta.json" >/dev/null 2>&1
    ab console > "$OUT/$name.console.txt" 2>/dev/null && say "console → $name.console.txt ($(wc -c < "$OUT/$name.console.txt") B)"
    ab screenshot "$OUT_WIN/$name.png" >/dev/null 2>&1 && say "截图 → $name.png"
    echo
    say "契约摘要:"
    "$NODE" -e '
      const fs=require("fs");const p=process.argv[1];
      try{
        const j=JSON.parse(fs.readFileSync(p,"utf8"));
        const c=j.counts||{};
        const top=Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,14).map(([k,v])=>k+"="+v).join("  ");
        console.log("  URL : "+j.url);
        console.log("  标题: "+j.title);
        console.log("  计数: "+top);
        console.log("  可点: "+(j.clickable||[]).map(x=>x.text).join(" / ").slice(0,160));
        console.log("  页面函数: "+Object.entries(j.pageFns||{}).map(([k,v])=>k+":"+v).join(" "));
        console.log("  iframe: "+(j.iframes||[]).length+" 个  "+(j.iframes||[]).map(f=>f.src.slice(0,60)).join(" | ").slice(0,200));
      }catch(e){console.log("  (摘要失败: "+e.message+")");}
    ' "$OUT_WIN/$name.dom.json"
    echo
    say "搞定。要我把这批拿来定契约就说一声(文件都在 $OUT)"
    ;;

  snap)
    [ -n "$name" ] || { echo "用法: bash tools/collect.sh snap <名字>"; exit 1; }
    mkdir -p "$OUT"
    say "只重采快照: $name(不碰 HAR)"
    ab snapshot > "$OUT/$name.a11y.txt" 2>/dev/null && say "无障碍树 → $name.a11y.txt"
    ab eval --stdin < "$REPO/tools/dom-contract.js" > "$OUT/$name.dom.json" 2>/dev/null
    "$NODE" "$REPO_WIN/tools/collect-normalize.mjs" "$OUT_WIN/$name.dom.json" >/dev/null 2>&1 && say "DOM 契约 → $name.dom.json ($(wc -c < "$OUT/$name.dom.json") B)"
    ab screenshot "$OUT_WIN/$name.png" >/dev/null 2>&1 && say "截图 → $name.png"
    ;;

  peek)
    say "当前请求(最近 25 条):"
    ab network requests 2>/dev/null | head -30
    ;;

  *)
    sed -n '2,14p' "$0"
    ;;
esac
