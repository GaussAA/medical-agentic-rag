@echo off
REM ============================================
REM  pi-knowledge 嵌入模型预下载脚本
REM  直接在 cmd 中双击运行即可
REM ============================================

echo ╔══════════════════════════════════════════╗
echo ║  pi-knowledge 嵌入模型预下载              ║
echo ║  multilingual-e5-small (32MB)            ║
echo ╚══════════════════════════════════════════╝
echo.
echo  镜像源: hf-mirror.com（HuggingFace 中国镜像）
echo  代理:   http://127.0.0.1:7897
echo  缓存目录: %USERPROFILE%\.pi\knowledge\models
echo.

REM ========== 关键配置 ==========
set https_proxy=http://127.0.0.1:7897
set http_proxy=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
set HF_ENDPOINT=https://hf-mirror.com
REM =============================

echo [步骤] 启动 Pi 触发模型自动下载...
echo   说明：Node.js 将使用 --use-env-proxy 参数通过代理连接 hf-mirror.com
echo   请等待约 30-60 秒...
echo.

cd /d "%~dp0.."

"%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" ^
  --use-env-proxy ^
  "%~dp0..\pi\packages\coding-agent\dist\cli.js" ^
  --model deepseek/deepseek-v4-flash ^
  --no-session ^
  --extension "%USERPROFILE%\.pi\agent\npm\node_modules\pi-knowledge\extension.js" ^
  --print "你好" 2>&1

echo.
echo ============================================
echo  执行完毕。
echo  若未出现"fetch failed"错误，则模型下载成功。
echo  此后可直接双击 start.bat 正常使用。
echo.
pause
