$ErrorActionPreference = 'SilentlyContinue'
$c = Get-NetTCPConnection -LocalPort 30142 -State Listen
if (-not $c) { Write-Host '[i] 端口 30142 没人监听: 桥本来就没跑'; exit 0 }
foreach ($x in $c) {
  $p = Get-Process -Id $x.OwningProcess
  if ($p) { Write-Host ('[停] PID {0} ({1})' -f $p.Id, $p.ProcessName); Stop-Process -Id $p.Id -Force }
}
Start-Sleep -Milliseconds 700
if (Get-NetTCPConnection -LocalPort 30142 -State Listen) { Write-Host '[!] 还在监听, 可能被别的程序占用'; exit 1 }
Write-Host '[ok] 答题桥已停止'
