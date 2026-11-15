#!/usr/bin/env bash
# 进入指定课程的旧版 studentstudy(刷课/扫描用): 新课程页 → 点第一个有 toOld 的章节点
set -uo pipefail
CID="${1:?courseid}"; CLZ="${2:?clazzid}"; CPI="${3:-100000001}"
AB="/mnt/c/Users/<user>/AppData/Roaming/npm/node_modules/agent-browser"
N="/mnt/c/Program Files/nodejs/node.exe"
ab() { (cd "$AB" && "$N" bin/agent-browser.js --cdp 9222 "$@"); }
ab open "https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=$CID&clazzid=$CLZ&cpi=$CPI&ismooc2=1&v=2" >/dev/null 2>&1
sleep 9
ab eval "(()=>{let d=null;for(const f of document.querySelectorAll('iframe')){try{const dd=f.contentWindow.document;if(dd&&dd.querySelectorAll('.chapter_item').length){d=dd;break}}catch(e){}}if(!d)return 'no-frame';const el=[...d.querySelectorAll('.chapter_item')].find(e=>/toOld/.test(e.getAttribute('onclick')||''));if(!el)return 'no-toOld';el.click();return 'entered:'+el.getAttribute('onclick')})()" 2>&1 | tail -1
sleep 11
ab eval "JSON.stringify({url:location.href.slice(30,92),points:document.querySelectorAll('.posCatalog_name').length,title:document.title})" 2>&1 | tail -1
