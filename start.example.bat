# ========== 注意 ==========
# 使用前请复制为 start.bat，填入你自己的 API Key
@echo off
REM 医疗 Agentic RAG 启动脚本（模板）
REM 使用前请先设置 API Key

REM ========== LLM 模型选择 ==========
REM 默认使用 DeepSeek V4 Flash，取消下方对应注释可切换：
REM set LLM_PROVIDER=agnes
REM set LLM_MODEL=agnes-2.0-flash
REM set LLM_PROVIDER=sensenova
REM set LLM_MODEL=sensenova-6.7-flash-lite
REM set LLM_PROVIDER=sensenova
REM set LLM_MODEL=deepseek-v4-flash   &REM 经 SenseNova 的 DeepSeek 备用通道

REM ========== API Keys（请替换为你的真实 Key） ==========
set DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY_HERE
set AGNES_API_KEY=YOUR_AGNES_API_KEY_HERE
set SENSENOVA_API_KEY=YOUR_SENSENOVA_API_KEY_HERE
set TAVILY_API_KEY=YOUR_TAVILY_API_KEY_HERE

REM ========== 代理配置 ==========
set HTTPS_PROXY=http://127.0.0.1:7897
set https_proxy=http://127.0.0.1:7897
set HF_ENDPOINT=https://hf-mirror.com

cd /d %~dp0

set NODE_PATH=%~dp0pi\node_modules

if "%LLM_PROVIDER%"=="" set LLM_PROVIDER=deepseek
if "%LLM_MODEL%"=="" set LLM_MODEL=deepseek-v4-flash

echo ╔══════════════════════════════════════════╗
echo ║     医疗 Agentic RAG 系统                ║
echo ║     Pi Agent + pi-knowledge              ║
echo ╚══════════════════════════════════════════╝
echo LLM: %LLM_PROVIDER% / %LLM_MODEL%

set NODE_OPTIONS=%NODE_OPTIONS% --use-env-proxy

"C:\Users\JaNiy\.workbuddy\binaries\node\versions\22.22.2\node.exe" ^
  "%~dp0pi\packages\coding-agent\dist\cli.js" ^
  --model %LLM_PROVIDER%/%LLM_MODEL% ^
  --system-prompt "%~dp0prompts\medical-agent.md"
