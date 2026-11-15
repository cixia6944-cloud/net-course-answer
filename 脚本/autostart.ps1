param([string]$Action = 'status')
# 开机自启: 在「启动」文件夹放一个指向本目录 start.ps1 的快捷方式(无窗口)
$lnk   = Join-Path ([Environment]::GetFolderPath('Startup')) 'answer-bridge.lnk'
$root  = Split-Path -Parent $PSScriptRoot
$start = Join-Path $PSScriptRoot 'start.ps1'
$wd    = Join-Path $root 'answer-bridge'
switch ($Action) {
  'install' {
    $sh = New-Object -ComObject WScript.Shell
    $l = $sh.CreateShortcut($lnk)
    $l.TargetPath = 'powershell.exe'
    $l.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $start + '"'
    $l.WorkingDirectory = $wd
    $l.Description = '答题桥(开机自启, 无窗口)'
    $l.Save()
    Write-Host ('[ok] 已装开机自启: ' + $lnk)
    Write-Host ('     指向: ' + $start)
  }
  'uninstall' {
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host '[ok] 已卸载开机自启' } else { Write-Host '[i] 本来就没装' }
  }
  default { if (Test-Path $lnk) { Write-Host ('[已装] ' + $lnk) } else { Write-Host '[未装] 开机自启' } }
}
