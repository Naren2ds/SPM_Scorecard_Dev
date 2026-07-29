# Sandbox Deployment Guide

Branch: `deploy/sandbox`

This branch runs entirely from pre-built CSV files — no Databricks connection required.

---

## What Changed vs `master`

| File | Change |
|---|---|
| `backend/server.py` | Removed all Databricks fetch imports → direct `Path` definitions; CORS opened to `*`; serves built frontend via `StaticFiles` |
| All 9 KPI page `.tsx` files | **Refresh Data** button removed from UI |
| `.gitignore` | `backend/data/` and `frontend/dist/` now tracked on this branch |

---

## One-Time Setup Steps (run in order)

### 1. Build the Frontend
```bash
cd frontend
npm run build
```
Output goes to `frontend/dist/` — this is served by the backend.

### 2. Install Backend Dependencies
```bash
pip install fastapi uvicorn pandas openpyxl
```
> `databricks-sql-connector` is no longer needed on this branch.

### 3. Test Locally
```bash
cd backend
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```
- App UI: `http://localhost:8000`
- API check: `http://localhost:8000/api/dot-kpi`

---

## Commit & Push to Git

```bash
git add .
git commit -m "deploy(sandbox): CSV-only mode, no Databricks, static frontend serving"
git push origin deploy/sandbox
```

---

## What Gets Pushed vs Gitignored

| Pushed ✓ | Gitignored ✗ |
|---|---|
| `backend/data/*.csv` (10 CSV files) | `backend/.env` (credentials never in git) |
| `frontend/dist/` (built app) | `node_modules/`, `__pycache__/`, `.venv/` |
| `backend/server.py` (sandbox version) | `*.pyc`, `*.local` |
| All 9 KPI pages (no refresh buttons) | |

---

## Updating CSV Data Later

To refresh the sandbox with new data:
1. Copy updated CSV files into `backend/data/`
2. Rebuild frontend if UI changed: `cd frontend && npm run build`
3. Commit and push:
```bash
git add backend/data/ frontend/dist/
git commit -m "deploy(sandbox): refresh CSV data"
git push origin deploy/sandbox
```

---

## Switching Back to Master

```bash
git checkout master
```
