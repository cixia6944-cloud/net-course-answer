#!/usr/bin/env bash
# 用 cua-driver daemon 在"已登录 Edge"里做只读侦查(页面导航/取状态/截图)
# 用法: bash tools/cua-recon.sh <子命令> [参数...]
#   tabs                          列标签
#   nav <url>                     在"新建标签页"里打开 URL(不动用户其它标签)
#   dump <out.json>               把当前标签的语义树+截图存盘
set -uo pipefail
BINDIR="/mnt/c/Users/<user>/AppData/Local/Programs/Cua/cua-driver/bin"
BIN="./cua-driver.exe"
SOCK='\\.\pipe\cua-driver'
PID="${CUA_PID:-20932}"
WIN="${CUA_WIN:-6293998}"
SS="${CUA_SESSION:-collect1}"
TMPW="C:/Users/<user>/AppData/Local/Temp"      # 给 Windows 程序
TMPL="/mnt/c/Users/<user>/AppData/Local/Temp"  # 给 bash/重定向

cd "$BINDIR" || exit 1
call() { timeout 180 ./cua-driver.exe call "$1" "$2" --socket "$SOCK"; }

# 取 target_id + 全部 tab(每次调用都重取, tab_id 是短期的)
state() { call get_browser_state "{\"pid\":$PID,\"window_id\":$WIN,\"session\":\"$SS\"}"; }

parse_head() { # 从 stdin 提取 target_id / tab_id
  "/mnt/c/Program Files/nodejs/node.exe" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let o;try{o=JSON.parse(s)}catch(e){console.log("");return}
  if(o.status!=="ok"){console.log("");return}
  const tabs=o.tabs||[];
  const want=process.argv[1]||"";
  const t=tabs.find(x=>(x.title||"").includes(want))||tabs.find(x=>!x.active)||tabs[0];
  console.log([o.target_id,t&&t.tab_id].filter(Boolean).join(" "));
})' "$1"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  tabs)
    state > "$TMPL/cua-tabs.json" 2>&1
    (cd /mnt/c/Users/<user>/AppData/Local/Temp && "/mnt/c/Program Files/nodejs/node.exe" -e '
      const fs=require("fs");const o=JSON.parse(fs.readFileSync("cua-tabs.json","utf8"));
      console.log("status:",o.status,"target:",o.target_id);
      (o.tabs||[]).forEach(t=>console.log("  "+(t.active?"*":" ")+String(t.title).slice(0,34)+"  ::  "+String(t.url).slice(0,70)));')
    ;;
  nav)
    URL="${1:?url}"
    HEAD=$(state | parse_head "新建标签页")
    TID="${HEAD%% *}"; TAB="${HEAD##* }"
    [ -z "$TID" ] && { echo "✗ 取 target_id 失败"; exit 1; }
    echo "target=$TID tab=$TAB"
    call browser_navigate "{\"pid\":$PID,\"window_id\":$WIN,\"session\":\"$SS\",\"target_id\":\"$TID\",\"tab_id\":\"$TAB\",\"url\":\"$URL\"}" | head -12
    ;;
  dump)
    OUT="${1:?out}"; PICK="${2:-}"
    HEAD=$(state | parse_head "$PICK")
    TID="${HEAD%% *}"; TAB="${HEAD##* }"
    [ -z "$TID" ] && { echo "✗ 取 target_id 失败"; exit 1; }

    call get_browser_state "{\"pid\":$PID,\"window_id\":$WIN,\"session\":\"$SS\",\"target_id\":\"$TID\",\"tab_id\":\"$TAB\",\"snapshot_format\":\"semantic_v2\",\"include_screenshot\":true}" > "$TMPL/$(basename "$OUT")" 2>&1
    (cd /mnt/c/Users/<user>/AppData/Local/Temp && "/mnt/c/Program Files/nodejs/node.exe" -e '
      const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      console.log("status:",o.status," 元素:",(o.content_refs||[]).length," 页面:",o.page&&o.page.url);
      const png=process.argv[3];
      if(o.screenshot_png_b64&&png){fs.writeFileSync(png,Buffer.from(o.screenshot_png_b64,"base64"));console.log("截图 →",png)}
      if(o.outline)console.log("outline 行数:",String(o.outline).split("\n").length);' "$(basename "$OUT")" "$(basename "${OUT%.json}.png")")
    ;;
  *) sed -n '2,7p' "$0" ;;
esac
