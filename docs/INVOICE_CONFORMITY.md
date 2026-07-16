# Invoice Conformity KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_invoice_conformity
```

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_invoice_conformity
```
No filter — fetches ALL suppliers. Single snapshot (no date column).

---

## Backend Processing (`backend/fetch_invoice_conformity.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| vendor_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| country | → | country |
| gpo_category | → | category |
| missing_po | → | missingPo (count) |
| wrong_po | → | wrongPo (count) |
| wrong_invoice | → | wrongInvoice (count) |
| total_invoices | → | totalInvoices (count) |

### Step 2 — Aggregate
**Group by:** `supplier`, `parentSupplier`, `zone`, `country`, `category`, `kpiApplicability`

**SUM:** `missingPo`, `wrongPo`, `wrongInvoice`, `totalInvoices`

### Step 3 — Calculate Conformity %
```
mismatchCount = missingPo + wrongPo + wrongInvoice
conformityPct = 1 - (mismatchCount / totalInvoices)
```
Result is 0-1 (higher = better). If totalInvoices = 0, value is empty.

### Step 4 — Output
- Path: `backend/data/invoice_conformity.csv`
- Columns: `id, supplier, parentSupplier, zone, country, category, kpiApplicability, conformityPct, missingPo, wrongPo, wrongInvoice, totalInvoices, mismatchCount`
- ~5,784 rows

---

## Frontend Page (`frontend/src/InvoiceConformityPage.tsx`)

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select |
| Parent Supplier | All | Multi-select |
| Supplier | All | Multi-select |
| Zone | All | Multi-select |
| Country | All | Multi-select |

No Year/Month filter (single snapshot).

### Configuration
| Parameter | Default |
|---|---|
| Max Score | 15 |
| Critical Floor % | 70 |
| Target % | 85 |
| Formula Mode | Softer Percentile Stretch |

### Scoring

**Value:** `conformityPct` (0-1, higher = better, rank highest first)

**Attainment:**
```
if conformityPct < Floor (0.70):  Attainment = 0
if conformityPct >= Target (0.85): Attainment = 1
else:                              Attainment = (conformityPct - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
Rank 1 = highest conformity = best
```

**Earned Score (Soft Stretch):**
```
Earned Score = Max Score × Attainment × (0.70 + 0.30 × Percentile)
```

**Earned Score (Strict):**
```
Earned Score = Max Score × Percentile × Attainment
```

### Scoring Hierarchy (4 levels)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each (first 200 displayed) |
| 2. Zone Rollup | zone | SUM raw counts → recalculate conformity → score |
| 3. Parent Rollup | parentSupplier | SUM raw counts → recalculate conformity → score |
| 4. Category Rollup | category | SUM raw counts → recalculate conformity → score |

**Rollup aggregation is WEIGHTED** (not simple average): sums all missingPo + wrongPo + wrongInvoice and totalInvoices, then recalculates conformity from totals.

### Edge Cases
| Situation | Rule |
|---|---|
| Only 1 supplier in cohort | Percentile = 100% |
| All identical, value ≥ target | Percentile = 100% |
| All identical, value < target | Percentile = 50% |
| Value below floor | Earned Score = 0 |
| totalInvoices = 0 | Missing Data — excluded |
| Not Applicable | Excluded from all rollups |

---

## API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/invoice-conformity` | Return cached data (JSON) |
| POST | `/api/invoice-conformity/refresh` | Background Databricks re-fetch |

---

## How to Seed Data
```bash
conda activate spm_scorecard
python backend/fetch_invoice_conformity.py
```
