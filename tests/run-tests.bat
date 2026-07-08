@echo off
REM 医疗 Agentic RAG 测试运行器
REM 运行所有自动化测试

setlocal enabledelayedexpansion

cd /d %~dp0\..

if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set _line=%%a
        if not "!_line:~0,1!"=="#" set "%%a=%%b"
    )
)

echo ╔══════════════════════════════════════╗
echo ║   医疗 Agentic RAG 测试运行器        ║
echo ╚══════════════════════════════════════╝
echo.

echo [1/2] 运行自动化数据完整性测试...
echo.
"C:\Users\JaNiy\.workbuddy\binaries\node\versions\22.22.2\node.exe" tests\run-all-tests.mjs
if %ERRORLEVEL% neq 0 (
    echo.
    echo ⚠️ 部分测试失败，请查看上方详情。
) else (
    echo.
    echo ✅ 所有测试通过！
)

echo.
echo [2/2] 测试报告已生成: tests\test-report.json
echo.
echo 手动测试用例请查看: tests\test-cases.md
echo.
pause
