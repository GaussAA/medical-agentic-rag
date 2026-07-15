@echo off
chcp 65001 >nul
REM ============================================================
REM start-webui.bat — Windows 无人值守拉起医疗 Agentic RAG Web 界面
REM 机制同 start-webui.sh：复用 Pi WebUI 独立 CLI（pi-webui），
REM       自动 spawn Pi RPC 会话，无需 TUI。
REM
REM 用法：双击 start-webui.bat  或  start-webui.bat
REM 前置：.env 配好 LLM Key；已 pi install npm:@firstpick/pi-package-webui；KB 已建
REM ============================================================
cd /d %~dp0

if "%WEBUI_PORT%"=="" set "WEBUI_PORT=31415"
if "%WEBUI_HOST%"=="" set "WEBUI_HOST=0.0.0.0"
if "%LLM_PROVIDER%"=="" set "LLM_PROVIDER=sensenova"
if "%LLM_MODEL%"=="" set "LLM_MODEL=sensenova-6.7-flash-lite"

set "WUI=%USERPROFILE%\.pi\agent\npm\node_modules\@firstpick\pi-package-webui\bin\pi-webui.mjs"
if not exist "%WUI%" (
  echo ✗ 未找到 pi-webui，请先执行: pi install npm:@firstpick/pi-package-webui
  pause
  exit /b 1
)

set "PROMPT=%CD%\.pi\prompts\medical-agent.md"
if not exist "%PROMPT%" (
  echo ✗ 找不到 system prompt: .pi\prompts\medical-agent.md
  pause
  exit /b 1
)

echo.
echo [Medical Agentic RAG - WebUI]
echo   模型 : %LLM_PROVIDER%/%LLM_MODEL%
echo   界面 : http://%WEBUI_HOST%:%WEBUI_PORT%/
echo.

node "%WUI%" --cwd "%CD%" --host %WEBUI_HOST% --port %WEBUI_PORT% --no-remote-auth -- --model %LLM_PROVIDER%/%LLM_MODEL% --system-prompt "%PROMPT%"
