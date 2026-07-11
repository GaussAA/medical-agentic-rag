@echo off
REM 知识库备份脚本
REM 导出 pi-knowledge 知识库为 JSONL 格式，保存到 backups/ 目录
REM 建议加入 Windows 任务计划程序定期执行

setlocal enabledelayedexpansion

REM 加载 .env
cd /d %~dp0..
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set _line=%%a
        if not "!_line:~0,1!"=="#" set "%%a=%%b"
    )
)

set BACKUP_DIR=%~dp0..\backups
set DATE=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%
mkdir "%BACKUP_DIR%" 2>nul

echo 备份知识库到 %BACKUP_DIR%\knowledge-%DATE%.jsonl
echo.

set NODE_OPTIONS=--use-env-proxy

"C:\Users\JaNiy\.workbuddy\binaries\node\versions\22.22.2\node.exe" ^
  "%~dp0..\pi\packages\coding-agent\dist\cli.js" ^
  --model deepseek/deepseek-v4-flash ^
  --no-session ^
  --print "请执行：knowledge_export { path: \"%BACKUP_DIR%\knowledge-%DATE%.jsonl\" }"

echo.
echo 备份完成。
pause
