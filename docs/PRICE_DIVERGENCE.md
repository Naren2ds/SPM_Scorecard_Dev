# Price Divergence KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_price_divergence
```

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_price_divergence
```
No filter — fetches ALL suppliers.

---

## Backend Processing (`backend/fetch_price_divergence.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| vendor_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| country | → | country |
| gpo_category | → | category |
| delivery_month | → | year, month |
| total_po_value | → | poValue (summed) |
| total_invoice_value | → | invoiceValue (summed) |

### Step 2 — Extract Year & Month
From `delivery_month` (format `YYYY-MM`):
- `year` = first 4 chars
- `month` = chars 5-6 (no leading zero)

### Step 3 — Aggregate
**Group by:** `year`, `month`, `supplier`, `parentSupplier`, `zone`, `country`, `category`

**SUM:** `poValue`, `invoiceValue`

### Step 4 — Calculate Price Divergence %
```
divergencePct = ABS(SUM(invoiceValue) - SUM(poValue)) / SUM(poValue)
```
- Result is 0-1 ratio (0 = perfect match, 1 = 100% divergence)
- If poValue = 0: divergencePct = empty (excluded from scoring)

### Step 5 — Output
- Path: `backend/data/price_divergence.csv`
- Columns: `id, supplier, parentSupplier, zone, country, category, kpiApplicability, poValue, invoiceValue, divergencePct, year, month`
- ~31,136 rows

---

## Frontend Page (`frontend/src/PriceDivergencePage.tsx`)

### Scoring Direction: INVERTED (lower = better)
Unlike DOT/IOT where higher % is better, Price Divergence scores **lower values higher**.

### Filters (multi-select dropdowns, dynamic from data)
| Filter | Default | Behavior |
|---|---|---|
| Category | All | Multi-select |
| Year | 2025, 2026 (pre-selected) | Multi-select |
| Month | All | Multi-select |
| Parent Supplier | All | Multi-select |
| Supplier | All | Multi-select |
| Zone | All | Multi-select |
| Country | All | Multi-select |

### Configuration
| Parameter | Default |
|---|---|
| Max Score | 10 |
| Critical Floor % | 15 (divergence ≥ 15% = score 0) |
| Target % | 5 (divergence ≤ 5% = full attainment) |
| Formula Mode | Softer Percentile Stretch |

### Formulas

**Attainment (INVERTED — lower divergence = better):**
```
if divergence >= Floor (15%): Attainment = 0 (too much divergence)
if divergence <= Target (5%): Attainment = 1 (excellent match)
else:                         Attainment = (Floor - divergence) / (Floor - Target)
```

**Percentile:**
```
Rank 1 = lowest divergence = best = 100th percentile
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

### Scoring Hierarchy (4 levels, scrollable with sticky headers)
| Level | Groups by | Method |
|---|---|---|
| 1. Supplier Level | Individual rows | Score each (first 200 displayed) |
| 2. Zone Rollup | zone | Sum poValue + invoiceValue → recalculate divergencePct → score |
| 3. Parent Rollup | parentSupplier | Sum poValue + invoiceValue → recalculate divergencePct → score |
| 4. Category Rollup | category | Sum poValue + invoiceValue → recalculate divergencePct → score |

### Edge Cases
| Situation | Rule |
|---|---|
| Only 1 supplier in cohort | Percentile = 100% |
| All identical divergence, ≤ target | Percentile = 100% |
| All identical divergence, > target | Percentile = 50% |
| Divergence ≥ floor (15%) | Earned Score = 0 |
| Missing/zero PO value | Excluded from ranking |
| Not Applicable | Excluded from all rollups |

---

## API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/price-divergence` | Return cached data (JSON) |
| POST | `/api/price-divergence/refresh` | Background Databricks re-fetch |

---

## How to Seed Data
```bash
conda activate spm_scorecard
python backend/fetch_price_divergence.py
```
