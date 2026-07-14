@echo off
echo === SPM Scorecard Dev ===
echo.
echo [1/2] Starting backend API (FastAPI on port 8000)...
cd /d "%~dp0"
start "SPM-Backend" cmd /c "cd backend && python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload"
timeout /t 3 /nobreak >nul
echo Backend started at http://127.0.0.1:8000
echo.
echo [2/2] Starting frontend (Vite on port 5173)...
cd frontend
npm run dev
