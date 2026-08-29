@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"
title 知序 - 本地知识库服务

set "APP_URL=http://localhost:3000/"
set "NPM_CMD="

for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
if not defined NPM_CMD if exist "D:\node\npm.cmd" set "NPM_CMD=D:\node\npm.cmd"

if not defined NPM_CMD (
  echo.
  echo [错误] 没有找到 npm.cmd，请先安装 Node.js 22 或更高版本。
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -Uri '%APP_URL%' -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 (
  echo 知序已经在运行。
  if not defined ZHIXU_NO_BROWSER (
    echo 正在打开浏览器……
    start "" "%APP_URL%"
  )
  exit /b 0
)

if not exist "node_modules\.bin\vinext.cmd" (
  echo 首次启动需要安装项目依赖，请稍候……
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请检查网络或 Node.js 环境。
    echo.
    pause
    exit /b 1
  )
)

echo ==================================================
echo   知序正在启动
echo   笔记目录：E:\Note
echo   本地地址：%APP_URL%
echo ==================================================
echo.
echo 浏览器将在服务就绪后自动打开。
echo 请保留此窗口；关闭窗口即可停止网站和笔记监视。
echo.

if not defined ZHIXU_NO_BROWSER start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process '%APP_URL%'" >nul 2>&1
call "%NPM_CMD%" run dev

set "APP_EXIT=%ERRORLEVEL%"
echo.
if not "%APP_EXIT%"=="0" (
  echo [错误] 本地服务异常退出，错误码：%APP_EXIT%
  pause
)
exit /b %APP_EXIT%
