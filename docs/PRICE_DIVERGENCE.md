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

## Frontend Page (`apps/frontend/src/pages/PriceDivergencePage.tsx`)

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

### Columns Displayed in Results Tables

**Supplier Level** — raw values read directly from data per row (already shown in table):
| UI Header | Source Field | Description |
|---|---|---|
| PO Value | `poValue` | Aggregated PO value (summed by backend) |
| Invoice Value | `invoiceValue` | Aggregated invoice value (summed by backend) |

**Rollup Tables (Zone / Parent Supplier / Category)** — aggregated sums across applicable rows in the group:
| UI Header | How Aggregated |
|---|---|
| PO Value | SUM of `poValue` across applicable rows |
| Invoice Value | SUM of `invoiceValue` across applicable rows |

Both columns appear immediately before the **Divergence %** column in all rollup tables. Divergence % at rollup level is recalculated from the aggregated sums: `ABS(SUM Invoice Value - SUM PO Value) / SUM PO Value`.

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
