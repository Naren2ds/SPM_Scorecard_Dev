# Supplier Assessment (Quality) KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_quality_performance
```

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_quality_performance
```
No vendor filter — fetches ALL suppliers.

---

## Backend Processing (`backend/fetch_supplier_assessment.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| supplier_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| country | → | country |
| supplier_category | → | category |
| supplier_approval_status | → | supplierApprovalStatus (display column only) |
| annual_assessment | → | categorised into Green / Yellow / Red / N/A / Blank counts |
| KPI_applicable | → | kpiApplicability (forced `"Applicable"` for all rows in the current phase) |

### Step 2 — Constants
- `year` = `"2026"` for every row (per current business rule)
- `kpiApplicability` = `"Applicable"` (forced; source `KPI_applicable` is currently blank)

### Step 3 — Rating Categorisation
Each `annual_assessment` cell is mapped to one bucket (case-insensitive):

| Raw value | Bucket |
|---|---|
| `Green`, `G` | green |
| `Yellow`, `Amber`, `Y` | yellow |
| `Red`, `R` | red |
| `N/A`, `NA`, `Not Applicable` | na |
| Blank, `(Blank)`, unrecognised | blank |

### Step 4 — Aggregate to Counts
**Group by:** `year`, `supplier`, `parentSupplier`, `zone`, `country`, `category`, `kpiApplicability`, `supplierApprovalStatus`

**Count occurrences of:** `green`, `yellow`, `red`, `na`, `blank`

Each output row represents one supplier per unique dimension combination.

### Step 5 — Output
- Path: `backend/data/supplier_assessment.csv`
- Columns: `id, supplier, parentSupplier, zone, country, category, kpiApplicability, supplierApprovalStatus, greenCount, yellowCount, redCount, naCount, blankCount, year`
- ~3,545 rows (from ~3,557 raw rows in current dataset)

---

## Frontend Page (`frontend/src/SupplierAssessmentPage.tsx`)

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select, dynamic options from loaded data |
| Year | 2026 (pre-selected) | Multi-select |
| Parent Supplier | All | Multi-select |
| Supplier | All | Multi-select |
| Zone | All | Multi-select |
| Country | All | Multi-select |

Empty selection = All (no filter applied).

### Configuration
| Parameter | Default |
|---|---|
| Max Score | 10 |
| Green Weight (`wG`) | 1.0 |
| Yellow Weight (`wY`) | 0.5 |
| Red Weight (`wR`) | 0.0 |
| Critical Floor % | 50 |
| Target % | 80 |
| Formula Mode | Softer Percentile Stretch |
| Cap @ Red % | 10 |
| Enable Red Cap | OFF |

**Constraints enforced:** `wG > wY > wR ≥ 0`, `wG ≤ 1`, `criticalFloor < target`, all thresholds in `[0, 1]`.

### Scoring Hierarchy (5 levels, all scrollable with sticky headers)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each row (first 200 displayed) |
| 2. Zone Rollup | zone | Sum raw counts → recalculate Health Index → score |
| 3. Parent Rollup | parentSupplier | Sum raw counts → recalculate Health Index → score |
| 4. Category Rollup | category | Sum raw counts → recalculate Health Index → score |
| 5. Country Rollup | country | Sum raw counts → recalculate Health Index → score |

### Formulas (per `docs/Support_Docs/supplier-assessment-percentile-scoring.md`)

**Assessment Health Index (AHI):**
```
AHI = (greenCount × wG + yellowCount × wY + redCount × wR) / totalValidAssessments
totalValidAssessments = greenCount + yellowCount + redCount   (N/A and Blank excluded)
```

**Attainment:**
```
if AHI < Floor:   Attainment = 0
if AHI >= Target: Attainment = 1
else:             Attainment = (AHI - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
Rank 1 = best (highest AHI). Ties get averaged rank.
```

**Earned Score (Soft Stretch):**
```
Earned Score = Max Score × Attainment × (0.70 + 0.30 × Percentile)
```

**Earned Score (Strict):**
```
Earned Score = Max Score × Percentile × Attainment
```

**Red Guardrail Cap (optional):**
```
if capScoreIfRedExceedsThreshold AND (redCount / totalValidAssessments) >= redCapThreshold:
    Earned Score = min(Earned Score, Max Score × 0.50)
```

### Edge Cases
| Situation | Rule |
|---|---|
| Only 1 supplier in cohort | Percentile = 100% |
| All identical AHI, AHI ≥ target | Percentile = 100% |
| All identical AHI, AHI < target | Percentile = 50% |
| Two or more suppliers tie | Averaged rank; same percentile |
| AHI below floor | Earned Score = 0 |
| Only N/A / Blank values | No Valid Assessment — excluded from ranking |
| Blank only (no N/A, no valid) | Missing Assessment — excluded |
| Not Applicable | Excluded from all rollups |

---

## Architecture

```
Databricks SQL Warehouse (all suppliers, no filter)
        ↓
backend/fetch_supplier_assessment.py (process + aggregate counts)
        ↓
backend/data/supplier_assessment.csv (cached on disk)
        ↓
backend/server.py (FastAPI, loads CSV into memory on startup)
        ↓  GET /api/supplier-assessment (JSON, instant)
        ↓  POST /api/supplier-assessment/refresh (background Databricks re-fetch)
        ↓
frontend/src/SupplierAssessmentPage.tsx (React, loads from API on mount)
  ├── Multi-select filters → filter rows
  ├── Configuration → scoring params (weights, floor, target, formula, red cap)
  ├── Scoring engine (supplierAssessmentScoring.ts) → compute results
  └── Scrollable result tables with sticky headers (5 levels)
```

### API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/supplier-assessment` | Return cached data (JSON) |
| POST | `/api/supplier-assessment/refresh` | Background Databricks re-fetch |
| GET | `/api/status` | Health check + row counts (both DOT and SA) |

### Key Design Decisions
- `use_cloud_fetch=False` in Databricks connector (corporate SSL proxy blocks cloud fetch)
- Data lives in `backend/data/` only (not in frontend)
- Supplier-level table capped at 200 rows in UI (full data in Export CSV)
- Year filter defaults to `["2026"]` because source rows are all tagged year 2026
- `KPI_applicable` currently forced to `"Applicable"` for all rows — update when source column is populated
- `supplier_approval_status` is a display column only (not a filter) in the current phase
- Backend cache and refresh thread are isolated from DOT KPI's cache/thread (separate lock)

---

## How to Run

### First time setup
```bash
git clone https://github.com/Sarthak-ABIIN/SPM_Scorecard_Dev.git
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
python backend/fetch_supplier_assessment.py
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

## Frontend Files
| File | Purpose |
|---|---|
| `frontend/src/supplierAssessmentTypes.ts` | TypeScript types (input row, config, scored row, rollup row) |
| `frontend/src/supplierAssessmentScoring.ts` | Scoring engine (AHI, percentile, attainment, earned score, rollups) |
| `frontend/src/SupplierAssessmentPage.tsx` | Page component (filters, config, results hierarchy, export) |

## Reference Documents
- Scoring specification: `docs/Support_Docs/supplier-assessment-percentile-scoring.md`
- DOT KPI (structural template): `docs/DOT_KPI.md`
