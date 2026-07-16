# Eclipse Score KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance
```
Same table as Supplier Maturity.

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_sustainability_performance
```

---

## Backend Processing (`backend/fetch_eclipse.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| supplier_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| category | → | category |
| eclipse_score_2025 | → | eclipseScore (normalised to 0-1) |

### Step 2 — Normalisation
- 0–1 → keep as-is (already a ratio)
- 1–100 → divide by 100
- <0 or >100 → invalid (empty string)

### Step 3 — Aggregate
**Group by:** `year`, `supplier`, `parentSupplier`, `zone`, `category`, `kpiApplicability`

**MEAN:** `eclipseScore`

### Step 4 — Constants
- `kpiApplicability` = "Applicable" (all rows)
- `year` = "2025" (fixed, derived from column name `eclipse_score_2025`)

### Step 5 — Output
- Path: `backend/data/eclipse.csv`
- Columns: `id, supplier, parentSupplier, zone, category, kpiApplicability, eclipseScore, year`
- ~270 rows

---

## Frontend Page (`frontend/src/EclipsePage.tsx`)

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select |
| Year | 2025 (pre-selected) | Multi-select |
| Parent Supplier | All | Multi-select |
| Supplier | All | Multi-select |
| Zone | All | Multi-select |

No Month filter (year is constant).

### Configuration
| Parameter | Default |
|---|---|
| Max Score | 5 |
| Critical Floor % | 50 |
| Target % | 80 |
| Formula Mode | Softer Percentile Stretch |

### Scoring (same engine as DOT/IOT/Maturity)

**Value:** `eclipseScore` (0-1, pre-normalised by backend)

**Attainment:**
```
if eclipseScore < Floor (0.50):  Attainment = 0
if eclipseScore >= Target (0.80): Attainment = 1
else:                             Attainment = (eclipseScore - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
```

**Earned Score (Soft Stretch):**
```
Earned Score = 5 × Attainment × (0.70 + 0.30 × Percentile)
```

**Earned Score (Strict):**
```
Earned Score = 5 × Percentile × Attainment
```

### Scoring Hierarchy (4 levels, scrollable with sticky headers)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each (first 200 displayed) |
| 2. Zone Rollup | zone | Mean eclipseScore → re-score |
| 3. Parent Rollup | parentSupplier | Mean eclipseScore → re-score |
| 4. Category Rollup | category | Mean eclipseScore → re-score |

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

## API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/eclipse` | Return cached Eclipse data (JSON) |
| POST | `/api/eclipse/refresh` | Background Databricks re-fetch |

---

## How to Seed Data
```bash
conda activate spm_scorecard
python backend/fetch_eclipse.py
```
