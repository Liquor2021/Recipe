@echo off
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion

echo ============================================
echo   NiniMenu Build Script (Windows amd64)
echo ============================================
echo.

REM Step 1: Build frontend
echo [1/4] Building frontend...
cd frontend
call npm install
if !ERRORLEVEL! NEQ 0 (
    echo [ERROR] npm install failed!
    pause
    exit /b !ERRORLEVEL!
)

call npm run build
if !ERRORLEVEL! NEQ 0 (
    echo [ERROR] Frontend build failed!
    pause
    exit /b !ERRORLEVEL!
)
cd ..
echo [1/4] Frontend build done!
echo.

REM Step 2: Copy frontend dist to backend static
echo [2/4] Copying frontend dist to backend/static...
if exist backend\static rd /S /Q backend\static
robocopy frontend\dist backend\static /E /NFL /NDL /NJH /NJS /NC /NS >nul 2>nul
echo [2/4] Frontend dist copied!
echo.

REM Step 3: Build Go backend for Windows
echo [3/4] Building Go backend (windows/amd64)...
cd backend

set CGO_ENABLED=0
set GOOS=windows
set GOARCH=amd64

go build -ldflags="-s -w" -o ../dist-win/ninimenu.exe ./cmd/server
if !ERRORLEVEL! NEQ 0 (
    echo [ERROR] Go build failed!
    pause
    exit /b !ERRORLEVEL!
)
cd ..
echo [3/4] Go backend build done!
echo.

REM Step 4: Package distribution files
echo [4/4] Packaging distribution files...

if not exist dist-win mkdir dist-win

REM Copy static directory
if exist backend\static (
    if not exist dist-win\static mkdir dist-win\static
    robocopy backend\static dist-win\static /E /NFL /NDL /NJH /NJS /NC /NS >nul 2>nul
)

REM Create data directory
if not exist dist-win\data mkdir dist-win\data

REM Copy env.bak
if exist .env copy /Y .env dist-win\env.bak >nul

REM Copy uploads directory (skip _thumbs: list thumbnails are generated at runtime)
if exist backend\uploads (
    robocopy backend\uploads dist-win\uploads /E /XD _thumbs /NFL /NDL /NJH /NJS /NC /NS >nul 2>nul
) else (
    if not exist dist-win\uploads mkdir dist-win\uploads
)

echo.
echo ============================================
echo   Build complete!
echo   Output directory: dist-win\
echo ============================================
echo.
echo   Run: dist-win\ninimenu.exe
echo   Open browser: http://localhost:8080
echo.
pause
