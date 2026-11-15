@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" install
echo     卸载: 双击同目录 开机自启-卸载.cmd
echo.
pause
