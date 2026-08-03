# Internal Databricks Refresh (POC)

This workflow refreshes all nine scorecard CSV datasets without exposing a
refresh action in FastAPI or the frontend. New files are staged and validated
before any current CSV is replaced.

## One-Time Setup

Install backend and test dependencies from the repository root:

```bat
python -m pip install -r apps/backend/requirements-dev.txt
```

Create `apps/backend/.env` from `apps/backend/.env.example` and provide the
three local Databricks values:

```env
DATABRICKS_SERVER_HOSTNAME=...
DATABRICKS_HTTP_PATH=...
DATABRICKS_TOKEN=...
```

Confirm that credentials are ignored by Git:

```bat
git check-ignore -v apps/backend/.env
```

Never force-add this file.

## Check Connectivity

Run a minimal `SELECT 1` without changing any data:

```bat
python apps/backend/refresh_scorecard_data.py --check-connection
```

Expected output:

```text
Databricks connection check: PASS
```

## Refresh All Data

Run all nine fetch and transformation modules:

```bat
python apps/backend/refresh_scorecard_data.py
```

The command performs these steps:

1. Fetch all Databricks source datasets.
2. Transform each dataset into the current CSV schema.
3. Stage every output under `apps/backend/data`.
4. Reject empty data, schema changes, duplicate IDs, and row-count drops over 50%.
5. Publish all nine CSVs and `refresh_manifest.json` only after every check passes.
6. Restore previous files if publication fails partway through.

If a verified source change legitimately reduces a dataset by more than 50%,
rerun with the explicit override:

```bat
python apps/backend/refresh_scorecard_data.py --allow-large-row-count-change
```

Do not use this override until the source query and expected row count have
been reviewed.

## Validate The Scorecard

Run the complete backend suite after publication:

```bat
python -m pytest apps/backend/tests -q
```

Review the resulting repository changes:

```bat
git status
git diff --stat
```

Commit only the expected connector/code changes, refreshed KPI CSVs, and
`refresh_manifest.json`. Generated validation reports should be reviewed
separately and credentials must never be committed.
