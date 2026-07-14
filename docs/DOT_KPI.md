# DOT KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_delivery_performance
```

## Raw Columns (from Databricks)
| # | Column | Sample |
|---|---|---|
| 1 | zone | EUR |
| 2 | country | Belgium |
| 3 | company_code | BE11 |
| 4 | vendor_name | Benepack |
| 5 | vendor_account_number | 0003022912 |
| 6 | vendor_type | Third Party |
| 7 | gpo_category | LOGISTICS |
| 8 | sub_category | LOGISTICS |
| 9 | purchasing_category | LOGISTICS |
| 10 | purchase_document_type | ZAB - Call-off |
| 11 | parent_name | Benepack |
| 12 | delivery_month | 2026-04 |
| 13 | total_po_lines | 166 |
| 14 | total_delivered | 166 |
| 15 | on_time_delivered | 166 |
| 16 | late_delivered | 0 |
| 17 | x1_overdue | 0 |
| 18 | x2_future_due | 0 |
| 19 | dot_not_applicable_lines | 0 |
| 20 | dot_applicable | Y |
| 21 | total_order_value | 1193885.14 |
| 22 | dot_percentage | 100.00 |
| 23 | __insert_gmt_ts | 2026-07-13 |

---

## Backend Processing Steps (`backend/fetch_dot_kpi.py`)

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
- `month` = chars 5-6 (e.g. `"04"`)

### Step 3 — Aggregate
**Group by:** `year`, `month`, `supplier`, `parentSupplier`, `zone`, `country`, `category`, `kpiApplicability`

**SUM:** `onTimePoLines`, `totalDeliveredPoLines`, `x1DelayedOver30Days`, `x2EarlyOver30Days`

### Step 4 — dotPercent
Left empty (`""`). Frontend calculates from raw values automatically.

### Step 5 — Output
CSV with columns:
```
id, supplier, parentSupplier, zone, country, category, kpiApplicability, dotPercent, onTimePoLines, totalDeliveredPoLines, x1DelayedOver30Days, x2EarlyOver30Days, year, month
```
Output path: `frontend/public/data/dot_kpi.csv`

---

## Frontend Scoring (unchanged from original)

### DOT Formula (calculated by frontend)
```
DOT = onTimePoLines / (totalDeliveredPoLines + 0.99 × x1DelayedOver30Days + 0.10 × x2EarlyOver30Days)
```

### Scoring Hierarchy (4 levels)

| Level | What it does |
|---|---|
| **1. Supplier** | Score each row individually |
| **2. Zone Rollup** | Group by zone → sum raw PO-lines → recalculate DOT → score |
| **3. Parent Rollup** | Group by parent supplier → sum raw PO-lines → recalculate DOT → score |
| **4. Category Rollup** | Group by category → sum raw PO-lines → recalculate DOT → score |

### Attainment Factor
```
if DOT < Critical Floor (70%):  Attainment = 0
if DOT >= Target (85%):         Attainment = 1
else:                           Attainment = (DOT - Floor) / (Target - Floor)
```

### Percentile
```
Percentile = (N - Rank) / (N - 1)
```
- Rank 1 = best = 100th percentile
- Ties get average rank

### Earned Score
**Soft Stretch (default):**
```
Earned Score = Max Score × Attainment × (0.70 + 0.30 × Percentile)
```

**Strict:**
```
Earned Score = Max Score × Percentile × Attainment
```

### Configuration Defaults
| Parameter | Default |
|---|---|
| Max Score | 15 |
| Critical Floor | 70% |
| Target | 85% |
| Cohort Level | Supplier |
| Formula Mode | Softer Percentile Stretch |

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

### Data Flow
```
Databricks SQL Warehouse
        ↓ (on-demand via /api/dot-kpi/refresh)
FastAPI backend (port 8000)
  ├── In-memory cache (serves instantly)
  └── CSV file cache (survives restarts)
        ↓ (JSON API)
React frontend (port 5173)
  ├── Loads cached data on mount (instant)
  ├── "Refresh Data" button → triggers background Databricks fetch
  └── Auto-updates UI when fresh data arrives
```

### API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/dot-kpi` | Return cached DOT KPI data instantly (JSON) |
| POST | `/api/dot-kpi/refresh` | Trigger background refresh from Databricks |
| GET | `/api/status` | Health check + cache status |

### Stale-While-Revalidate Pattern
1. App starts → backend loads last CSV from disk into memory (instant)
2. Frontend fetches from `/api/dot-kpi` on page mount (instant, ~10ms)
3. User clicks "Refresh Data" → backend fetches from Databricks in background thread
4. Once done → cache updated, frontend polls and auto-loads fresh data
5. No blocking, no spinners on initial load

---

## Frontend Filtering (Live)

The configuration bar includes **Category**, **Year**, and **Month** dropdowns that filter data **before** scoring.

| Filter | Values | Behavior |
|---|---|---|
| Category | All, LOGISTICS, PACKAGING, CANS, etc. | Matches `category` field exactly |
| Year | All, 2024, 2025, 2026, ... | Matches `year` field (4-digit string) |
| Month | All, 01–12 | Matches `month` field (2-digit string) |

**How it works:**
- When any filter is set to "All", that dimension is not filtered
- When a specific value is selected, only rows matching that value are passed to scoring
- All 4 rollup levels (Supplier, Zone, Parent, Category) recalculate live based on filtered data
- Changing Max Score, Floor, Target, Cohort Level, or Formula Mode also recalculates instantly

---

## How to Run
```powershell
# Option 1: Batch file (starts both backend + frontend)
cd C:\Users\C416241\Documents\SPM_Scorecard_Dev
.\run.bat

# Option 2: Manual (two terminals)
# Terminal 1 - Backend:
cd backend
python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload

# Terminal 2 - Frontend:
cd frontend
npm run dev
```
