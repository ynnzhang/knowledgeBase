@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

pushd "%~dp0"
if errorlevel 1 goto directory_failed
title 知序 - 本地知识库服务

where node.exe >nul 2>&1
if errorlevel 1 goto node_missing
where npm.cmd >nul 2>&1
if errorlevel 1 goto node_missing

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)"
if errorlevel 1 goto node_old

if not exist "scripts\start-local.mjs" goto project_incomplete
node scripts/start-local.mjs
set "APP_EXIT=%ERRORLEVEL%"
popd
if "%APP_EXIT%"=="0" exit /b 0
echo.
echo [错误] 启动失败，请查看上方提示。
pause
exit /b %APP_EXIT%

:project_incomplete
echo [错误] 项目文件不完整，缺少 scripts\start-local.mjs。
echo 请完整解压最新版项目包后重试，不要只复制启动文件或部分 scripts 文件。
goto failed

:node_missing
echo [错误] 请先安装 Node.js 22.13 或更高版本，并将 Node.js 和 npm 加入 PATH，然后重新打开此文件。
goto failed

:node_old
echo [错误] Node.js 版本过低，需要 22.13 或更高版本。
goto failed

:directory_failed
echo [错误] 无法进入项目目录，请检查文件夹是否可访问。
pause
exit /b 1

:failed
popd
pause
exit /b 1
