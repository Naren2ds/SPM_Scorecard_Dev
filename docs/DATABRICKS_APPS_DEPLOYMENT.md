# Databricks Apps Deployment

This project follows the same hybrid React + FastAPI deployment pattern as the
PET Resin Cost Platform. Databricks builds the React frontend and runs one
FastAPI process that serves both the UI and `/api` endpoints.

## Validated Runtime Layout

- `app.yaml` starts `uvicorn server:app` on `$DATABRICKS_APP_PORT`.
- Root `requirements.txt` installs the backend dependencies.
- Root `package.json` installs and builds `apps/frontend`.
- FastAPI serves `apps/frontend/dist` at `/`.
- The frontend defaults to same-origin `/api` calls in production.
- Vite proxies `/api` to `127.0.0.1:8000` only during local development.

## Local Validation

From the repository root:

```powershell
npm run build
pip install -r requirements.txt
$env:DATABRICKS_APP_PORT = '8000'
uvicorn server:app --app-dir apps/backend --host 0.0.0.0 --port $env:DATABRICKS_APP_PORT
```

Verify:

```text
http://127.0.0.1:8000/
http://127.0.0.1:8000/api/status
http://127.0.0.1:8000/api/scorecard/cache-status
```

## Deploy from Git in the Databricks UI

Create a custom Databricks App and configure these values:

| Setting | Value |
|---|---|
| Git repository | `https://github.com/Naren2ds/SPM_Scorecard_Dev.git` |
| Git provider | GitHub |
| Git reference | `deployment` |
| Reference type | Branch |
| Source code path | Leave blank (repository root) |

For a private repository, configure a Git credential for the app service
principal from the app overview page. The user performing this step needs
`CAN MANAGE` on the app.

Then select **Deploy**, choose **From Git**, confirm the `deployment` branch,
and deploy. Databricks will run the root Node and Python dependency steps,
execute `npm run build`, and start the `app.yaml` command.

After the deployment reaches `SUCCEEDED`, open the app URL and verify the UI.
Use the app's **Logs** tab if the build or startup fails.

## CLI Alternative

This machine needs Databricks CLI 0.229.0 or later and workspace authentication
before the following commands can be used:

```powershell
databricks auth login --host https://<workspace-host>

databricks apps create <app-name> --json '{"git_repository":{"url":"https://github.com/Naren2ds/SPM_Scorecard_Dev.git","provider":"gitHub"}}'

databricks apps deploy <app-name> --json '{"git_source":{"branch":"deployment"}}'
```

If the app already exists but is not connected to this repository, use
`databricks apps create-update` to set `git_repository` before deploying.

## Runtime Data Note

The bundled KPI CSV files are available after every deployment. Changes made
through feedback or scorecard-configuration endpoints currently write to the
app's local filesystem and should be treated as temporary across restarts and
redeployments. Store those mutable files in a Unity Catalog volume or database
before relying on them as persistent production records.
