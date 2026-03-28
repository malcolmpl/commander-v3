@echo off
title SpaceMolt Commander v3
cd /d "%~dp0"

echo ════════════════════════════════════════
echo   SpaceMolt Commander v3
echo ════════════════════════════════════════
echo.

:: Start backend
echo Starting backend on port 3000...
start "Commander Backend" cmd /c "cd /d %~dp0 && bun run --watch src/app.ts"

:: Wait a moment for backend to start
ping -n 3 127.0.0.1 >nul

:: Start Vite dev server
echo Starting dashboard on port 5173...
start "Commander Dashboard" cmd /c "cd /d %~dp0web && bun run dev"

:: Wait and open browser
ping -n 4 127.0.0.1 >nul
start http://localhost:5173

echo.
echo  Backend:   http://localhost:3000
echo  Dashboard: http://localhost:5173
echo.
echo Close both terminal windows to stop.
pause
