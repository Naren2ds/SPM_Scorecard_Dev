# IOT KPI — Processing & Scoring Reference

## Source Table
```
brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_invoice_on_time
```

## Query
```sql
SELECT * FROM brewdat_uc_supchn_dev.gld_ghq_procurement_spm.supplier_invoice_on_time
```
No filter — fetches ALL suppliers.

---

## Backend Processing (`backend/fetch_iot_kpi.py`)

### Step 1 — Column Mapping
| Raw Column | → | Frontend Field |
|---|---|---|
| vendor_name | → | supplier |
| parent_name | → | parentSupplier |
| zone | → | zone |
| country | → | country |
| gpo_category | → | category |
| iot_applicable | → | kpiApplicability (`Y` → `"Applicable"`, else → `"Not Applicable"`) |
| invoice_ontime_count | → | invoiceOnTimeCount |
| total_po_lines | → | totalPoLines |

### Step 2 — Extract Year & Month
From `delivery_month` (format `YYYY-MM`):
- `year` = first 4 chars
- `month` = chars 5-6 (no leading zero)

### Step 3 — Aggregate
**Group by:** `year`, `month`, `supplier`, `parentSupplier`, `zone`, `country`, `category`, `kpiApplicability`

**SUM:** `invoiceOnTimeCount`, `totalPoLines`

### Step 4 — Output
- Path: `backend/data/iot_kpi.csv`
- Columns: `id, supplier, parentSupplier, zone, country, category, kpiApplicability, invoiceOnTimeCount, totalPoLines, year, month`

---

## Frontend Scoring (`frontend/src/IotKpiPage.tsx`)

### IOT Formula
```
IOT % = invoiceOnTimeCount / totalPoLines
```
(Result is 0–1 ratio, displayed as percentage)

### Columns Displayed in Results Tables

**Supplier Level** — raw values read directly from data per row:
| UI Header | Source Field | Description |
|---|---|---|
| Inv. On-Time | `invoiceOnTimeCount` | Invoices delivered on time |
| Tot. PO Lines | `totalPoLines` | Total PO lines delivered |

**Rollup Tables (Zone / Parent Supplier / Category)** — aggregated sums across applicable rows in the group:
| UI Header | How Aggregated |
|---|---|
| Inv. On-Time | SUM of `invoiceOnTimeCount` across applicable rows |
| Tot. PO Lines | SUM of `totalPoLines` across applicable rows |

Both columns appear immediately before the **IOT %** column in all four result tables.

### Scoring (same engine as DOT)

**Attainment:**
```
if IOT% < Floor (70%):   Attainment = 0
if IOT% >= Target (85%): Attainment = 1
else:                     Attainment = (IOT% - Floor) / (Target - Floor)
```

**Percentile:**
```
Percentile = (N - Rank) / (N - 1)
```

**Earned Score (Soft Stretch):**
```
Earned Score = Max Score × Attainment × (0.70 + 0.30 × Percentile)
```

### Configuration Defaults
| Parameter | Default |
|---|---|
| Max Score | 15 |
| Critical Floor | 70% |
| Target | 85% |
| Formula Mode | Softer Percentile Stretch |

### Filters (same as DOT)
Category, Year (default 2025+2026), Month, Parent Supplier, Supplier, Zone, Country — all multi-select.

---

## API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/iot-kpi` | Return cached IOT data (JSON) |
| POST | `/api/iot-kpi/refresh` | Background Databricks re-fetch |

---

## How to Seed Data
```bash
conda activate spm_scorecard
python backend/fetch_iot_kpi.py
```
