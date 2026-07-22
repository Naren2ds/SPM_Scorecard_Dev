# CO₂ Emission KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance
```

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance
```
No vendor filter — fetches ALL suppliers.

---

## Backend Processing (`backend/fetch_co2_emission.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| supplier_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| supplier_category | → | category |
| KPI_applicable | → | kpiApplicability (forced `"Applicable"` for all rows in the current phase) |
| emissions_tco2e_2025 | → | co2Emission (year = `"2025"`) |
| emissions_tco2e_2026 | → | co2Emission (year = `"2026"`) |

Note: backend targets 2025/2026 columns and emits rows for whichever of these
columns are present in the source schema.

### Step 2 — Constants
- `year` comes from source emission year columns (`emissions_tco2e_2025`, `emissions_tco2e_2026`).
- `kpiApplicability` = `"Applicable"` (forced; source `KPI_applicable` is currently blank).
- No `country` column.

### Step 3 — Aggregate
**Group by:** `year`, `supplier`, `parentSupplier`, `zone`, `category`, `kpiApplicability`
**Aggregation:** `mean(co2Emission)` (supplier-level attribute — mean over duplicates returns the constant value).

### Step 4 — Output
- Path: `backend/data/co2_emission.csv`
- Columns: `id, supplier, parentSupplier, zone, category, kpiApplicability, co2Emission, year`

---

## Frontend Page (`frontend/src/Co2EmissionPage.tsx`)

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select |
| Year | 2025 + 2026 (pre-selected) | Multi-select |
| Parent Supplier | All | Multi-select |
| Supplier | All | Multi-select |
| Zone | All | Multi-select |

Empty selection = All (no filter applied).

### Configuration
| Parameter | Default | Notes |
|---|---|---|
| Max Score | 10 | Same as Supplier Compliance |
| Critical Floor (tCO₂e) | **Q1 of filtered rows** | Recomputes when filters change |
| Target (tCO₂e) | **Q3 of filtered rows** | Recomputes when filters change |
| Auto Q1 / Q3 defaults | On | Uncheck to enter manual values |
| Formula Mode | Softer Percentile Stretch | Same modes as other KPIs |

**Constraints enforced:** `criticalFloor < target`, both ≥ 0, `maxScore > 0`.

When the user edits Floor or Target manually the "Auto Q1 / Q3" toggle switches off. Re-check it to restore quartile-derived defaults from the currently filtered data.

### Scoring Hierarchy (3 levels, all scrollable with sticky headers)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each row (first 200 displayed) |
| 2. Zone Rollup | zone | Simple average of contributing supplier CO₂ values → score (Proxy Calculation) |
| 3. Parent Rollup | parentSupplier | Same as Zone (Proxy Calculation) |

### Formulas (identical shape to Supplier Compliance — higher value = better)

**Attainment:**
```
if value < Floor:     Attainment = 0
if value >= Target:   Attainment = 1
else:                 Attainment = (value - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
Rank 1 = highest CO₂ value = best. Ties get averaged rank.
```

**Earned Score (Soft Stretch):**
```
Earned Score = Max Score × Attainment × (0.70 + 0.30 × Percentile)
```

**Earned Score (Strict):**
```
Earned Score = Max Score × Percentile × Attainment
```

### Q1 / Q3 Defaults
Q1 and Q3 are computed with linear interpolation (numpy default `"linear"`) over the **applicable, valid** CO₂ values in the **currently filtered** rows. If Q1 ≥ Q3 (extreme no-variance case) Target is pushed to Q1 + 1 so scoring remains defined.

### Edge Cases
| Situation | Rule |
|---|---|
| Only 1 supplier in cohort | Percentile = 100% |
| All identical values, ≥ target | Percentile = 100% |
| All identical values, < target | Percentile = 50% |
| Two or more suppliers tie | Averaged rank; same percentile |
| Value below floor | Earned Score = 0 |
| Missing / non-numeric / negative | Missing Value — excluded from ranking |
| Not Applicable | Excluded from all rollups |

---

## Architecture

```
Databricks SQL Warehouse (all suppliers, no filter)
        ↓
backend/fetch_co2_emission.py (map + aggregate mean)
        ↓
backend/data/co2_emission.csv (cached on disk)
        ↓
backend/server.py (FastAPI, loads CSV into memory on startup)
        ↓  GET /api/co2-emission (JSON, instant)
        ↓  POST /api/co2-emission/refresh (background Databricks re-fetch)
        ↓
frontend/src/Co2EmissionPage.tsx (React, loads from API on mount)
  ├── Multi-select filters → filter rows
  ├── Q1 / Q3 of filtered rows → auto-derived Floor / Target
  ├── Configuration → scoring params (floor, target, formula)
  ├── Scoring engine (co2EmissionScoring.ts) → compute results
  └── Scrollable result tables with sticky headers (3 levels)
```

### API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/co2-emission` | Return cached data (JSON) |
| POST | `/api/co2-emission/refresh` | Background Databricks re-fetch |
| GET | `/api/status` | Health check + row counts (DOT + SA + SC + CO₂) |

### Key Design Decisions
- `use_cloud_fetch=False` in Databricks connector (corporate SSL proxy blocks cloud fetch)
- Data lives in `backend/data/` only (not in frontend)
- Supplier-level table capped at 200 rows in UI (full data in Export CSV)
- Year filter defaults to `["2025", "2026"]` and backend emits only these years
- `KPI_applicable` currently forced to `"Applicable"` for all rows — update when source column is populated
- `country` column is not present in the source table for this KPI
- Backend cache and refresh thread are isolated (separate lock for CO₂)
- Rollups use simple average (Proxy Calculation) because the source has no completed / required counts
- Critical Floor and Target default to Q1 / Q3 of the currently filtered rows (recomputes on filter change unless the user has overridden them)

---

## How to Run

### Seed initial data
```bash
conda activate spm_scorecard
python backend/fetch_co2_emission.py
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
| `frontend/src/co2EmissionTypes.ts` | TypeScript types |
| `frontend/src/co2EmissionScoring.ts` | Scoring engine (percentile, attainment, earned score, quartile defaults, proxy rollups) |
| `frontend/src/Co2EmissionPage.tsx` | Page component (filters, config, results hierarchy, export) |

## Reference Documents
- DOT KPI (structural template): `docs/DOT_KPI.md`
- Supplier Compliance (sibling KPI, same formula shape): `docs/SUPPLIER_COMPLIANCE.md`
