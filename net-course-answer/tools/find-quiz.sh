#!/usr/bin/env bash
# 遍历课程章节, 找"测验类"任务点(读 li#dct 标签)。只读: 只点章节, 不点任务点。
set -uo pipefail
AB="/mnt/c/Users/<user>/AppData/Roaming/npm/node_modules/agent-browser"
N="/mnt/c/Program Files/nodejs/node.exe"
CID="${1:?courseid}"; CLZ="${2:?clazzid}"; MAX="${3:-12}"
ab() { (cd "$AB" && "$N" bin/agent-browser.js --cdp 9222 "$@"); }

ab open "https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=$CID&clazzid=$CLZ&cpi=<cpi>&ismooc2=1&v=2" >/dev/null 2>&1
sleep 9
# 取前 N 个未完成章节
ab eval "(()=>{let d=null;for(const f of document.querySelectorAll('iframe')){try{const dd=f.contentWindow.document;if(dd&&dd.querySelectorAll('.chapter_item').length){d=dd;break}}catch(e){}}if(!d)return '[]';const rows=[...d.querySelectorAll('.chapter_item')].map(e=>({t:(e.textContent||'').trim().replace(/\s+/g,' ').slice(0,34),oc:e.getAttribute('onclick')||''})).filter(x=>x.oc&&/待完成任务点/.test(x.t));return JSON.stringify(rows.slice(0,$MAX))})()" > /mnt/c/Users/<user>/AppData/Local/Temp/pend.json 2>/dev/null
LIST=$(cat /mnt/c/Users/<user>/AppData/Local/Temp/pend.json)
COUNT=$("$N" -e "let s=process.argv[1];try{const o=JSON.parse(s);if(typeof o==='string'){const p=JSON.parse(o);console.log(p.length)}else console.log(o.length)}catch(e){console.log(0)}" "$LIST")
echo "未完成章节(取前 $COUNT 个)逐个查任务点类型:"
for i in $(seq 0 $((COUNT-1))); do
  OC=$("$N" -e "let s=process.argv[1];try{let o=JSON.parse(s);if(typeof o==='string')o=JSON.parse(o);console.log(o[process.argv[2]].oc)}catch(e){console.log('')}" "$LIST" "$i")
  TITLE=$("$N" -e "let s=process.argv[1];try{let o=JSON.parse(s);if(typeof o==='string')o=JSON.parse(o);console.log(o[process.argv[2]].t)}catch(e){console.log('')}" "$LIST" "$i")
  [ -z "$OC" ] && continue
  KID=$(echo "$OC" | sed "s/.*'\([0-9]\{6,\}\)'.*/\1/")
  ab open "https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=$CID&clazzid=$CLZ&cpi=<cpi>&ismooc2=1&v=2" >/dev/null 2>&1
  sleep 7
  ab eval "(()=>{let d=null;for(const f of document.querySelectorAll('iframe')){try{const dd=f.contentWindow.document;if(dd&&dd.querySelectorAll('.chapter_item').length){d=dd;break}}catch(e){}}if(!d)return 'nf';const el=[...d.querySelectorAll('.chapter_item')].find(e=>/toOld\([^)]*$KID/.test(e.getAttribute('onclick')||''));if(!el)return 'nf';el.click();return 'ok'})()" >/dev/null 2>&1
  sleep 11
  TABS=$(ab eval "(()=>{const t=[...document.querySelectorAll('li[id^=dct]')].map(e=>e.id+':'+(e.textContent||'').trim().slice(0,18));return JSON.stringify(t)})()" 2>/dev/null | tr -d '\n')
  echo "  [$((i+1))] $TITLE"
  echo "       tabs=$TABS"
done
