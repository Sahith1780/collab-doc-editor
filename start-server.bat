@echo off
echo ==============================================================
echo   SyncDoc - Starting Real-Time Collaborative Server
echo ==============================================================
echo.

node -v >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [INFO] Using Antigravity bundled Node runtime...
    set ELECTRON_RUN_AS_NODE=1
    "C:\Users\sahit\AppData\Local\Programs\antigravity\Antigravity.exe" server/index.js
) else (
    node server/index.js
)

pause
