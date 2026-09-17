@echo off
echo ==============================================================
echo   SyncDoc - Running Convergence Tests & Benchmarks
echo ==============================================================
echo.

node test/convergence.test.js
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Convergence tests failed!
    pause
    exit /b 1
)

echo.
node test/memory-benchmark.js

echo.
echo ==============================================================
echo   All tests and benchmarks executed successfully!
echo ==============================================================
pause
