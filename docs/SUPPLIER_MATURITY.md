# Supplier Maturity Score KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance
```
(Shared with CO₂ Emission KPI — different column drives the value.)

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance
```
No vendor filter — fetches ALL suppliers.

---

## Backend Processing (`backend/fetch_supplier_maturity.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| supplier_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| supplier_category | → | category |
| KPI_applicable | → | kpiApplicability (forced `"Applicable"` for all rows in the current phase) |
| supplier_maturity_score_2025 | → | maturityScore (raw 0-100 → normalised to [0, 1]) |

### Step 2 — Constants
- `year` = `"2025"` for every row (source column is `supplier_maturity_score_2025` — year is baked in).
- `kpiApplicability` = `"Applicable"` (forced; source `KPI_applicable` is currently blank).
- No `country` column.

### Step 3 — Maturity Score Normalisation
| Raw value | Normalisation applied |
|---|---|
| Value in [0, 1] | Used as-is (e.g. `0.85` → `0.85`) |
| Value in (1, 100] | Divided by 100 (e.g. `85` → `0.85`) |
| Value < 0 or > 100 | Discarded → Missing / Invalid |
| Non-numeric | Discarded → Missing / Invalid |

The internal value is always stored in the **[0, 1]** range.

### Step 4 — Aggregate
**Group by:** `year`, `supplier`, `parentSupplier`, `zone`, `category`, `kpiApplicability`
**Aggregation:** `mean(maturityScore)` (supplier-level attribute — mean returns the constant value; duplicates would average).

### Step 5 — Output
- Path: `backend/data/supplier_maturity.csv`
- Columns: `id, supplier, parentSupplier, zone, category, kpiApplicability, maturityScore, year`

---

## Frontend Page (`frontend/src/SupplierMaturityPage.tsx`)

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select |
| Year | 2025, 2026 (pre-selected) | Multi-select |
| Parent Supplier | All | Multi-select |
| Supplier | All | Multi-select |
| Zone | All | Multi-select |

Empty selection = All (no filter applied).

### Configuration
| Parameter | Default |
|---|---|
| Max Score | 10 |
| Critical Floor % | 60 |
| Target % | 80 |
| Formula Mode | Softer Percentile Stretch |

**Constraints enforced:** `criticalFloor < target`, both in `[0, 1]`, `maxScore > 0`.

### Scoring Hierarchy (4 levels, all scrollable with sticky headers)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each row (first 200 displayed) |
| 2. Zone Rollup | zone | Simple average of contributing supplier maturity scores → score (Proxy Calculation) |
| 3. Parent Rollup | parentSupplier | Same as Zone (Proxy Calculation) |
| 4. Category Rollup | category | Same as Zone (Proxy Calculation) |

### Formulas (identical shape to Supplier Compliance — higher score = better)

**Maturity Score (already pre-computed by source, normalised at ingest):**
```
score ∈ [0, 1]
```

**Attainment:**
```
if score < Floor:   Attainment = 0
if score >= Target: Attainment = 1
else:               Attainment = (score - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
Rank 1 = best (highest maturity score). Ties get averaged rank.
```

**Earned Score (Soft Stretch):**
```
Earned Score = Max Score × Attainment × (0.70 + 0.30 × Percentile)
```

**Earned Score (Strict):**
```
Earned Score = Max Score × Percentile × Attainment
```

### Rollup Aggregation — Simple Average (Proxy)
```
Rollup Maturity % = (1/n) × Σ score_i
```
Because the source table exposes only a direct score per supplier, all rollups use the **simple average** of contributing scores. Rollup rows are flagged with status **Proxy Calculation**.

### Edge Cases
| Situation | Rule |
|---|---|
| Only 1 supplier in cohort | Percentile = 100% |
| All identical scores, ≥ target | Percentile = 100% |
| All identical scores, < target | Percentile = 50% |
| Two or more suppliers tie | Averaged rank; same percentile |
| Score below floor | Earned Score = 0 |
| Missing / non-numeric / out-of-range | Missing Score — excluded from ranking |
| Not Applicable | Excluded from all rollups |

---

## Architecture

```
Databricks SQL Warehouse (all suppliers, no filter)
        ↓
backend/fetch_supplier_maturity.py (normalise + aggregate mean)
        ↓
backend/data/supplier_maturity.csv (cached on disk)
        ↓
backend/server.py (FastAPI, loads CSV into memory on startup)
        ↓  GET /api/supplier-maturity (JSON, instant)
        ↓  POST /api/supplier-maturity/refresh (background Databricks re-fetch)
        ↓
frontend/src/SupplierMaturityPage.tsx (React, loads from API on mount)
  ├── Multi-select filters → filter rows
  ├── Configuration → scoring params (floor, target, formula)
  ├── Scoring engine (supplierMaturityScoring.ts) → compute results
  └── Scrollable result tables with sticky headers (4 levels)
```

### API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/supplier-maturity` | Return cached data (JSON) |
| POST | `/api/supplier-maturity/refresh` | Background Databricks re-fetch |
| GET | `/api/status` | Health check + row counts (DOT + SA + SC + SM) |

### Key Design Decisions
- `use_cloud_fetch=False` in Databricks connector (corporate SSL proxy blocks cloud fetch)
- Data lives in `backend/data/` only (not in frontend)
- Supplier-level table capped at 200 rows in UI (full data in Export CSV)
- Year filter defaults to `["2025", "2026"]` (data is inherently 2025 based on the source column name)
- `KPI_applicable` currently forced to `"Applicable"` for all rows — update when source column is populated
- `country` column is not present in the source table for this KPI
- Backend cache and refresh thread are isolated (separate lock for Supplier Maturity)
- Rollups use simple average (Proxy Calculation) because the source has no supporting counts

---

## How to Run

### Seed initial data
```bash
conda activate spm_scorecard
python backend/fetch_supplier_maturity.py
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
| `frontend/src/supplierMaturityTypes.ts` | TypeScript types |
| `frontend/src/supplierMaturityScoring.ts` | Scoring engine (percentile, attainment, earned score, proxy rollups) |
| `frontend/src/SupplierMaturityPage.tsx` | Page component (filters, config, results hierarchy, export) |

## Reference Documents
- DOT KPI (structural template): `docs/DOT_KPI.md`
- Supplier Compliance (sibling KPI, same formula shape): `docs/SUPPLIER_COMPLIANCE.md`
