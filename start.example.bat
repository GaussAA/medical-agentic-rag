@echo off
REM 医疗 Agentic RAG 启动脚本（模板）
REM 
REM 使用方式：
REM   1. 复制 .env.example 为 .env 并填入你的 API Key
REM   2. 复制本文件为 start.bat
REM   3. 双击 start.bat 启动
REM
REM 若不需要修改任何默认模型，直接 cp .env.example .env && cp start.example.bat start.bat 即可

cd /d %~dp0

REM ========== 从 .env 加载配置 ==========
REM start.bat 会自动读取 .env，此处只需要确保 .env 已存在
if not exist ".env" (
    echo [错误] 请先复制 .env.example 为 .env 并填入 API Key
    echo copy .env.example .env
    pause
    exit /b 1
)

REM ========== LLM 模型选择 ==========
REM 如需切换模型，取消下方对应的注释行：
REM set LLM_PROVIDER=agnes
REM set LLM_MODEL=agnes-2.0-flash
REM set LLM_PROVIDER=sensenova
REM set LLM_MODEL=sensenova-6.7-flash-lite
REM set LLM_PROVIDER=sensenova
REM set LLM_MODEL=deepseek-v4-flash

if "%LLM_PROVIDER%"=="" set LLM_PROVIDER=deepseek
if "%LLM_MODEL%"=="" set LLM_MODEL=deepseek-v4-flash

set NODE_PATH=%~dp0pi\node_modules
set NODE_OPTIONS=%NODE_OPTIONS% --use-env-proxy

echo [医疗 Agentic RAG]  LLM: %LLM_PROVIDER%/%LLM_MODEL%

"C:\Users\JaNiy\.workbuddy\binaries\node\versions\22.22.2\node.exe" ^
  "%~dp0pi\packages\coding-agent\dist\cli.js" ^
  --model %LLM_PROVIDER%/%LLM_MODEL% ^
  --system-prompt "%~dp0prompts\medical-agent.md"
