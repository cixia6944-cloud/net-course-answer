Write-Host '=== 答题桥状态 ==='
$h = try { Invoke-RestMethod -Uri 'http://127.0.0.1:30142/health' -TimeoutSec 3 } catch { $null }
if ($h) { Write-Host ('[ok] 桥在跑: ' + $h.service + ' 端口 ' + $h.port) }
else { Write-Host '[x] 桥没跑 (127.0.0.1:30142 无响应)'; Write-Host '    -> 双击 网课答题助手\启动答题桥.cmd' }
