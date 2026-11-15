Write-Host '=== 答题桥自检 ==='
$h = try { Invoke-RestMethod -Uri 'http://127.0.0.1:30142/health' -TimeoutSec 3 } catch { $null }
if (-not $h) { Write-Host '[x] 1/2 桥没跑 -> 双击 网课答题助手\启动答题桥.cmd'; exit 1 }
Write-Host ('[ok] 1/2 桥在跑: ' + $h.service)
Write-Host '[..] 2/2 拿一道真题问本机 pi(要等几十秒)...'
$body = '{"title":"马克思主义中国化时代化的第一次历史性飞跃的理论成果是什么？","options":["毛泽东思想","邓小平理论","三个代表重要思想","科学发展观"],"type":"0"}'
try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:30142/ask' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 180
  if ($r.ok) { Write-Host ('[ok] 2/2 pi 作答: ' + ($r.answer -join ' / ')) }
  else { Write-Host ('[x] 2/2 pi 返回错误: ' + $r.error) }
} catch { Write-Host ('[x] 2/2 请求失败: ' + $_.Exception.Message) }
