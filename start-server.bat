@echo off
title 赔率分析查询服务
cd /d C:\Users\lenovo\WorkBuddy\Claw\web-query
echo [%date% %time%] 服务启动中...
echo.

:loop
C:\Users\lenovo\.workbuddy\binaries\node\versions\22.22.2\node.exe server.js
echo.
echo [%date% %time%] 服务意外退出，5秒后自动重启...
timeout /t 5 /nobreak >nul
goto loop
