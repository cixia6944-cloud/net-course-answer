@echo off
chcp 65001 >nul
echo ============================================
echo   网课答题助手 - 启动答题桥 (127.0.0.1:30142)
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0脚本\start.ps1"
echo.
echo      要停掉: 双击 脚本\停掉答题桥.cmd
echo      开机自启: 双击 脚本\开机自启-安装.cmd
echo      页面没反应: 双击 脚本\自检.cmd
echo.
pause
