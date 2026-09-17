@echo off
echo ==============================================================
echo   SyncDoc - Git Repository Initialization Helper
echo ==============================================================
echo.

where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Git is not detected in your PATH.
    echo Please install Git for Windows from https://git-scm.com/download/win
    echo Then re-run this script.
    pause
    exit /b 1
)

echo [1/3] Initializing Git repository...
git init

echo [2/3] Staging all files...
git add .

echo [3/3] Creating initial commit...
git commit -m "feat: Complete Real-Time Collaborative Document Editor (CRDT, Awareness, IndexedDB, Chaos Suite)"
git branch -M main

echo.
echo ==============================================================
echo [SUCCESS] Git repository successfully created on branch 'main'!
echo.
echo To push this project to your GitHub repository:
echo   1. Create a new empty repository on https://github.com/new
echo   2. Run:
echo      git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
echo      git push -u origin main
echo ==============================================================
echo.
pause
