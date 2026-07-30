# SPM Scorecard Dev

This repository is organized for Databricks Apps-style deployment.

## Project Layout

- `apps/backend/`: FastAPI backend and cached KPI data
- `apps/frontend/`: Vite + React frontend
- `data/raw/`: optional source inputs
- `data/reference/`: optional reference/mapping files
- `data/processed/`: optional processed outputs
- `data/archive/`: optional archive snapshots
- `pipelines/`: optional orchestration/ETL scripts
- `docs/`: functional, architecture, and runbook documentation
- `testing_scripts/`: optional ad-hoc validation scripts

## Databricks Apps Entrypoint

The app entrypoint is defined in `app.yaml` and runs:

- `uvicorn server:app --app-dir apps/backend --host 0.0.0.0 --port $DATABRICKS_APP_PORT`

## Local Development

Backend:

```powershell
cd apps/backend
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Frontend:

```powershell
cd apps/frontend
npm install
npm run dev
```

Or use the root convenience launcher:

```powershell
.\run.bat
```

## Deploy to Databricks Apps

The production frontend uses same-origin `/api` requests, and FastAPI serves
the generated frontend from `apps/frontend/dist`. Databricks installs the root
dependencies, runs `npm run build`, and starts the command in `app.yaml`.

See [docs/DATABRICKS_APPS_DEPLOYMENT.md](docs/DATABRICKS_APPS_DEPLOYMENT.md)
for the validated Git deployment settings and verification steps.
