@echo off
echo === SPM Scorecard Dev ===
echo.
echo Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo.
echo [1/2] Starting backend API (FastAPI on port 8000)...
cd /d "%~dp0"
start "SPM-Backend" cmd /k "cd /d %~dp0apps\backend && python -m uvicorn server:app --host 127.0.0.1 --port 8000"
timeout /t 5 /nobreak >nul
echo Backend started at http://127.0.0.1:8000
echo.
echo [2/2] Starting frontend (Vite on port 5173)...
cd /d "%~dp0apps\frontend"
npm run dev
