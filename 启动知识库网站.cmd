@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"
title 知序 - 本地知识库服务

set "APP_URL=http://localhost:3000/"
set "API_URL=http://127.0.0.1:4312/health"
set "NPM_CMD="

for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
if defined NPM_CMD goto npm_ready
if exist "D:\node\npm.cmd" set "NPM_CMD=D:\node\npm.cmd"
if defined NPM_CMD goto npm_ready

echo.
echo [错误] 没有找到 npm.cmd，请先安装 Node.js 22 或更高版本。
echo.
pause
exit /b 1

:npm_ready
powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -Uri '%APP_URL%' -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 } } catch {}; exit 1" >nul 2>&1
set "SITE_RUNNING=%ERRORLEVEL%"
powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -Uri '%API_URL%' -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
set "API_RUNNING=%ERRORLEVEL%"

if not "%SITE_RUNNING%"=="0" goto prepare_start
if not "%API_RUNNING%"=="0" goto start_api_only

echo 知序已经在运行。
if not defined ZHIXU_NO_BROWSER echo 正在打开浏览器……
if not defined ZHIXU_NO_BROWSER start "" "%APP_URL%"
exit /b 0

:prepare_start
if exist "node_modules\.bin\vinext.cmd" goto start_all
echo 首次启动需要安装项目依赖，请稍候……
call "%NPM_CMD%" install
if errorlevel 1 goto install_failed

:start_all
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
if "%APP_EXIT%"=="0" exit /b 0
echo.
echo [错误] 本地服务异常退出，错误码：%APP_EXIT%
pause
exit /b %APP_EXIT%

:start_api_only
echo 网站已经运行，正在补充启动本地编辑服务……
if not defined ZHIXU_NO_BROWSER start "" "%APP_URL%"
call "%NPM_CMD%" run notes:watch
exit /b

:install_failed
echo.
echo [错误] 依赖安装失败，请检查网络或 Node.js 环境。
echo.
pause
exit /b 1
