$ErrorActionPreference = 'Stop'

# 本脚本放在 <项目根>\脚本\ 下, 路径全部相对推导 —— 整个项目文件夹搬到哪都能用
$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root 'answer-bridge'
$entry = Join-Path $dir 'server.mjs'
if (-not (Test-Path $entry)) { Write-Host ('[x] 找不到桥: ' + $entry); exit 1 }

if (-not $env:USERPROFILE) { $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile') }
if (-not $env:APPDATA)     { $env:APPDATA     = [Environment]::GetFolderPath('ApplicationData') }

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Host '[x] 找不到 node.exe (装 Node 18+ 或改本脚本里的 $node)'; exit 1 }

if (Get-NetTCPConnection -LocalPort 30142 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host '[i] 桥已经在跑, 不重复启动'
  exit 0
}
Start-Process -FilePath $node -ArgumentList 'server.mjs','--port','30142' -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput "$dir\bridge.out.log" -RedirectStandardError "$dir\bridge.err.log"
Start-Sleep -Seconds 2
$h = try { Invoke-RestMethod -Uri 'http://127.0.0.1:30142/health' -TimeoutSec 5 } catch { $null }
if ($h) { Write-Host ('[ok] 答题桥已启动: ' + $h.service + ' 端口 ' + $h.port) } else { Write-Host '[!] 启动失败, 看 answer-bridge\bridge.err.log'; exit 1 }
