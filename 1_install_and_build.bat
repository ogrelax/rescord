@echo off
title Rescord Builder
cd /d "%~dp0"
echo.
echo ========================================
echo   Rescord - Installing and Building
echo ========================================
echo.

echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 ( echo ERROR: npm install failed & pause & exit /b 1 )

echo.
echo [2/3] Building Electron app...
call npm run build
if errorlevel 1 ( echo ERROR: build failed & pause & exit /b 1 )

echo.
echo [3/3] Done!
echo.
echo Your app is in the dist\ folder.
echo Look for Rescord.exe
echo.
explorer dist
pause
