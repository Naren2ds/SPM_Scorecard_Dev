# DOT KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_delivery_performance
```

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_delivery_performance
```
No vendor filter — fetches ALL suppliers.

---

## Backend Processing (`backend/fetch_dot_kpi.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| vendor_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| country | → | country |
| gpo_category | → | category |
| dot_applicable | → | kpiApplicability (`Y` → `"Applicable"`, else → `"Not Applicable"`) |
| on_time_delivered | → | onTimePoLines |
| total_delivered | → | totalDeliveredPoLines |
| x1_overdue | → | x1DelayedOver30Days |
| x2_future_due | → | x2EarlyOver30Days |

### Step 2 — Extract Year & Month
From `delivery_month` (format `YYYY-MM`):
- `year` = first 4 chars (e.g. `"2026"`)
- `month` = chars 5-6 (e.g. `"4"`)

### Step 3 — Aggregate
**Group by:** `year`, `month`, `supplier`, `parentSupplier`, `zone`, `country`, `category`, `kpiApplicability`

**SUM:** `onTimePoLines`, `totalDeliveredPoLines`, `x1DelayedOver30Days`, `x2EarlyOver30Days`

### Step 4 — dotPercent
Left empty (`""`). Frontend calculates DOT from raw values automatically using:
```
DOT = onTimePoLines / (totalDeliveredPoLines + 0.99 × x1DelayedOver30Days + 0.10 × x2EarlyOver30Days)
```

### Step 5 — Output
- Path: `backend/data/dot_kpi.csv`
- Columns: `id, supplier, parentSupplier, zone, country, category, kpiApplicability, dotPercent, onTimePoLines, totalDeliveredPoLines, x1DelayedOver30Days, x2EarlyOver30Days, year, month`
- ~29,967 rows, ~3,212 unique suppliers

---

## Frontend Page (`frontend/src/DotKpiPage.tsx`)

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select, dynamic options from loaded data |
| Year | 2025, 2026 (pre-selected) | Multi-select |
| Month | All | Multi-select |
| Parent Supplier | All | Multi-select |
| Supplier | All | Multi-select |
| Zone | All | Multi-select |
| Country | All | Multi-select |

Empty selection = All (no filter applied).

### Configuration
| Parameter | Default |
|---|---|
| Max Score | 15 |
| Critical Floor % | 70 |
| Target % | 85 |
| Formula Mode | Softer Percentile Stretch |

### Scoring Hierarchy (4 levels, all scrollable with sticky headers)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each row (first 200 displayed) |
| 2. Zone Rollup | zone | Sum raw PO-lines → recalculate DOT → score |
| 3. Parent Rollup | parentSupplier | Sum raw PO-lines → recalculate DOT → score |
| 4. Category Rollup | category | Sum raw PO-lines → recalculate DOT → score |

### Formulas (unchanged from original repo)

**Attainment:**
```
if DOT < Floor:   Attainment = 0
if DOT >= Target: Attainment = 1
else:             Attainment = (DOT - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
```

**Earned Score (Soft Stretch):**
```
Earned Score = Max Score × Attainment × (0.70 + 0.30 × Percentile)
```

**Earned Score (Strict):**
```
Earned Score = Max Score × Percentile × Attainment
```

### Edge Cases
| Situation | Rule |
|---|---|
| Only 1 supplier in cohort | Percentile = 100% |
| All identical, value ≥ target | Percentile = 100% |
| All identical, value < target | Percentile = 50% |
| Value below floor | Earned Score = 0 |
| Missing/blank value | Excluded from ranking |
| Not Applicable | Excluded from all rollups |

---

## Architecture

```
Databricks SQL Warehouse (all suppliers, no filter)
        ↓
backend/fetch_dot_kpi.py (process + aggregate)
        ↓
backend/data/dot_kpi.csv (cached on disk)
        ↓
backend/server.py (FastAPI, loads CSV into memory on startup)
        ↓  GET /api/dot-kpi (JSON, instant)
        ↓  POST /api/dot-kpi/refresh (background Databricks re-fetch)
        ↓
frontend/src/DotKpiPage.tsx (React, loads from API on mount)
  ├── Multi-select filters → filter rows
  ├── Configuration → scoring params
  ├── Scoring engine (scoring.ts) → compute results
  └── Scrollable result tables with sticky headers
```

### API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/dot-kpi` | Return cached data (JSON) |
| POST | `/api/dot-kpi/refresh` | Background Databricks re-fetch |
| GET | `/api/status` | Health check + row count |

### Key Design Decisions
- `use_cloud_fetch=False` in Databricks connector (corporate SSL proxy blocks cloud fetch)
- Data lives in `backend/data/` only (not in frontend)
- Supplier-level table capped at 200 rows in UI (full data in Export CSV)
- Year filter defaults to 2025+2026 on first load
- `run.bat` auto-kills old processes before starting

---

## How to Run

### First time setup
```bash
git clone https://github.com/Naren2ds/SPM_Scorecard_Dev.git
cd SPM_Scorecard_Dev
conda create -n spm_scorecard python=3.13 -y
conda activate spm_scorecard
pip install -r backend/requirements.txt
cd frontend && npm install && cd ..
```

### Configure credentials
Create `backend/.env`:
```
DATABRICKS_SERVER_HOSTNAME=adb-xxxx.x.azuredatabricks.net
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/xxxx
DATABRICKS_TOKEN=dapiXXXXXXXXXXXX
```

### Seed initial data
```bash
conda activate spm_scorecard
python backend/fetch_dot_kpi.py
```

### Run app
```bash
conda activate spm_scorecard
.\run.bat
```
Opens backend on `http://127.0.0.1:8000` + frontend on `http://127.0.0.1:5173`

### Stop app
```bash
taskkill /F /IM python.exe
taskkill /F /IM node.exe
```

---

## Template for Adding New KPIs

Follow this pattern for each new KPI:

1. **Backend**: Create `backend/fetch_<kpi_name>.py`
   - Define SQL query for the source table
   - Map raw columns → frontend field names
   - Aggregate as needed
   - Output to `backend/data/<kpi_name>.csv`

2. **Backend server**: Add API endpoint in `backend/server.py`
   - `GET /api/<kpi-name>` — serve cached data
   - `POST /api/<kpi-name>/refresh` — background refresh

3. **Frontend**: Create `frontend/src/<KpiName>KpiPage.tsx`
   - Load from API on mount
   - Add filters (dynamic multi-select from data)
   - Add configuration bar
   - Connect to scoring engine
   - Display results in scrollable tables

4. **Frontend App.tsx**: Add tab for the new KPI

5. **Docs**: Create `docs/<KPI_NAME>.md` following this same template
