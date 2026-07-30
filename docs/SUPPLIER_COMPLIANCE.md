# Supplier Compliance % KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_quality_performance
```
(Shared with Supplier Assessment KPI — different column drives the value.)

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_quality_performance
```
No vendor filter — fetches ALL suppliers.

---

## Backend Processing (`backend/fetch_supplier_compliance.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| supplier_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| country | → | country |
| supplier_category | → | category |
| supplier_approval_status | → | supplierApprovalStatus (display column only) |
| supplier_compliance_pct | → | compliancePct (pre-computed, direct mode) |
| KPI_applicable | → | kpiApplicability (forced `"Applicable"` for all rows in the current phase) |

### Step 2 — Constants
- `year` = `"2026"` for every row (per current business rule)
- `kpiApplicability` = `"Applicable"` (forced; source `KPI_applicable` is currently blank)

### Step 3 — Compliance % Normalisation
| Raw value | Normalisation applied |
|---|---|
| Value in [0, 1] | Used as-is (e.g. `0.85` → `0.85`) |
| Value in (1, 100] | Divided by 100 (e.g. `85` → `0.85`) |
| Value < 0 or > 100 | Discarded → Missing / Invalid |
| Non-numeric | Discarded → Missing / Invalid |

The internal value is always stored in the **[0, 1]** range.

### Step 4 — Aggregate
**Group by:** `year`, `supplier`, `parentSupplier`, `zone`, `country`, `category`, `kpiApplicability`, `supplierApprovalStatus`

**Aggregation:** `mean(compliancePct)` (the value is a supplier-level attribute — mean returns the constant value unchanged; duplicates would average).

### Step 5 — Output
- Path: `backend/data/supplier_compliance.csv`
- Columns: `id, supplier, parentSupplier, zone, country, category, kpiApplicability, supplierApprovalStatus, compliancePct, year`

---

## Frontend Page (`apps/frontend/src/pages/SupplierCompliancePage.tsx`)

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select |
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
| Critical Floor % | 60 |
| Target % | 90 |
| Formula Mode | Softer Percentile Stretch |

**Constraints enforced:** `criticalFloor < target`, both in `[0, 1]`, `maxScore > 0`.

### Scoring Hierarchy (5 levels, all scrollable with sticky headers)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each row (first 200 displayed) |
| 2. Zone Rollup | zone | Simple average of contributing supplier compliance % → score (Proxy Calculation) |
| 3. Parent Rollup | parentSupplier | Same as Zone (Proxy Calculation) |
| 4. Category Rollup | category | Same as Zone (Proxy Calculation) |
| 5. Country Rollup | country | Same as Zone (Proxy Calculation) |

### Formulas (per `docs/Support_Docs/supplier-compliance-scoring.md`)

**Compliance % (already pre-computed by source, normalised at ingest):**
```
compliance ∈ [0, 1]
```

**Attainment:**
```
if compliance < Floor:   Attainment = 0
if compliance >= Target: Attainment = 1
else:                    Attainment = (compliance - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
Rank 1 = best (highest compliance). Ties get averaged rank.
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
Rollup Compliance % = (1/n) × Σ compliance_i
```
Because the source table does not expose completed / required document counts, all rollups use the **simple average** of contributing supplier compliance percentages. Rollup rows are flagged with status **Proxy Calculation**.

### Edge Cases
| Situation | Rule |
|---|---|
| Only 1 supplier in cohort | Percentile = 100% |
| All identical compliance, ≥ target | Percentile = 100% |
| All identical compliance, < target | Percentile = 50% |
| Two or more suppliers tie | Averaged rank; same percentile |
| Compliance below floor | Earned Score = 0 |
| Missing / non-numeric / out-of-range | Missing Compliance — excluded from ranking |
| Not Applicable | Excluded from all rollups |

---

## Architecture

```
Databricks SQL Warehouse (all suppliers, no filter)
        ↓
backend/fetch_supplier_compliance.py (normalise + aggregate mean)
        ↓
backend/data/supplier_compliance.csv (cached on disk)
        ↓
backend/server.py (FastAPI, loads CSV into memory on startup)
        ↓  GET /api/supplier-compliance (JSON, instant)
        ↓  POST /api/supplier-compliance/refresh (background Databricks re-fetch)
        ↓
apps/frontend/src/pages/SupplierCompliancePage.tsx (React, loads from API on mount)
  ├── Multi-select filters → filter rows
  ├── Configuration → scoring params (floor, target, formula)
  ├── Scoring engine (supplierComplianceScoring.ts) → compute results
  └── Scrollable result tables with sticky headers (5 levels)
```

### API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/supplier-compliance` | Return cached data (JSON) |
| POST | `/api/supplier-compliance/refresh` | Background Databricks re-fetch |
| GET | `/api/status` | Health check + row counts (DOT + SA + SC) |

### Key Design Decisions
- `use_cloud_fetch=False` in Databricks connector (corporate SSL proxy blocks cloud fetch)
- Data lives in `backend/data/` only (not in frontend)
- Supplier-level table capped at 200 rows in UI (full data in Export CSV)
- Year filter defaults to `["2026"]` because source rows are all tagged year 2026
- `KPI_applicable` currently forced to `"Applicable"` for all rows — update when source column is populated
- `supplier_approval_status` is a display column only (not a filter) in the current phase
- Backend cache and refresh thread are isolated from DOT and SA (separate lock)
- Rollups use simple average (Proxy Calculation) because the source has no completed / required counts

---

## How to Run

### Seed initial data
```bash
conda activate spm_scorecard
python backend/fetch_supplier_compliance.py
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
| `frontend/src/supplierComplianceTypes.ts` | TypeScript types |
| `frontend/src/supplierComplianceScoring.ts` | Scoring engine (percentile, attainment, earned score, proxy rollups) |
| `apps/frontend/src/pages/SupplierCompliancePage.tsx` | Page component (filters, config, results hierarchy, export) |

## Reference Documents
- Scoring specification: `docs/Support_Docs/supplier-compliance-scoring.md`
- DOT KPI (structural template): `docs/DOT_KPI.md`
- Supplier Assessment (sibling KPI): `docs/SUPPLIER_ASSESSMENT.md`
