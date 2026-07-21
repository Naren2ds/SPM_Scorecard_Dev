@echo off
echo === SPM Scorecard Dev ===
echo.

cd /d "%~dp0"

echo Cleaning up old processes...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 /nobreak >nul

echo.
echo [1/2] Starting backend API using backend\.venv...

if not exist "%~dp0backend\.venv\Scripts\python.exe" (
    echo ERROR: Virtual environment Python was not found.
    echo Expected location:
    echo %~dp0backend\.venv\Scripts\python.exe
    pause
    exit /b 1
)

start "SPM-Backend" cmd /k ^
"cd /d "%~dp0backend" && ".venv\Scripts\python.exe" -m uvicorn server:app --host 127.0.0.1 --port 8000"

timeout /t 5 /nobreak >nul

echo Backend started at http://127.0.0.1:8000
echo.

echo [2/2] Starting frontend using Vite on port 5173...

cd /d "%~dp0frontend"
npm run dev

pause