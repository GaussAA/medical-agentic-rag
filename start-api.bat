@echo off
REM ============================================================
REM start-api.bat — Windows 拉起医疗 Agentic RAG HTTP API 服务
REM 用法：
REM   start-api.bat
REM   set API_PORT=9090 && start-api.bat
REM   set API_TOKEN=xxxx && start-api.bat
REM   start-api.bat -d         （后台：start /b，日志 .pi\logs\api.log）
REM ============================================================
setlocal
set ROOT=%~dp0
cd /d %ROOT%

set NODE_BIN=%NODE_BIN%
if not exist "%NODE_BIN%" set NODE_BIN=C:\Users\JaNiy\.workbuddy\binaries\node\versions\22.22.2\node
if not exist "%NODE_BIN%" set NODE_BIN=node

if exist .env (
  for /f "usebackq tokens=*" %%l in (`findstr /v /b /c:"#" .env`) do (
    set "%%l" >nul 2>&1
  )
)

set BACKGROUND=0
if "%1"=="-d" set BACKGROUND=1
if "%1"=="--background" set BACKGROUND=1

if not defined API_PORT set API_PORT=8080
if not defined API_HOST set API_HOST=127.0.0.1

echo [api] 探测 Provider 健康态…
"%NODE_BIN%" scripts/proxy/launch-with-failover.mjs >nul 2>&1

if "%BACKGROUND%"=="1" (
  set MEDICAL_API_RUN=1
  if not exist .pi\logs mkdir .pi\logs
  start /b "" "%NODE_BIN%" scripts/service/api-server.mjs > .pi\logs/api.log 2>&1
  echo [api] 后台启动 → http://%API_HOST%:%API_PORT%/
  echo [api] 日志: .pi\logs\api.log   停止: stop-api.sh / Taskkill
  goto :eof
)

set MEDICAL_API_RUN=1
"%NODE_BIN%" scripts/service/api-server.mjs
endlocal
