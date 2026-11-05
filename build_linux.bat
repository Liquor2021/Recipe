@echo off
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion

echo ============================================
echo   NiniMenu Build Script (Linux amd64)
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

REM Step 3: Build Go backend for Linux
echo [3/4] Building Go backend (linux/amd64)...
cd backend

set CGO_ENABLED=0
set GOOS=linux
set GOARCH=amd64

go build -ldflags="-s -w" -o ../dist/ninimenu ./cmd/server
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

if not exist dist mkdir dist

REM Copy static directory
if exist backend\static (
    if not exist dist\static mkdir dist\static
    robocopy backend\static dist\static /E /NFL /NDL /NJH /NJS /NC /NS >nul 2>nul
)

REM Create data directory
if not exist dist\data mkdir dist\data

REM Copy env.bak
if exist .env copy /Y .env dist\env.bak >nul

REM Copy uploads directory (skip _thumbs: list thumbnails are generated at runtime)
if exist backend\uploads (
    robocopy backend\uploads dist\uploads /E /XD _thumbs /NFL /NDL /NJH /NJS /NC /NS >nul 2>nul
) else (
    if not exist dist\uploads mkdir dist\uploads
)

REM Create tar.gz archive
echo Creating archive...
tar -czf ninimenu-linux-amd64.tar.gz -C dist .

echo.
echo ============================================
echo   Build complete!
echo   Output: ninimenu-linux-amd64.tar.gz
echo ============================================
echo.
echo   Deploy instructions:
echo   1. Upload ninimenu-linux-amd64.tar.gz to your Linux server
echo   2. Extract: tar -xzf ninimenu-linux-amd64.tar.gz -C /opt/ninimenu
echo   3. chmod +x ninimenu
echo   4. Run: ./ninimenu
echo   5. Open browser: http://SERVER_IP:8080
echo.
pause
