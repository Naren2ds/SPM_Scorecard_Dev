# KPI Data Flow and Scorecard Calculation

This note explains how data moves from raw KPI files to the final frontend view,
and where caching is used.

## 1. Big Picture

```text
Databricks source table
    -> fetch_*.py connector
    -> processed CSV in apps/backend/data/
    -> server loads CSV into _cache
    -> KPI pages use one of two loading paths:
       1. optimized KPIs recalculate in backend after slicers
       2. consistent KPIs recalculate in frontend after slicers
    -> compute_scorecard() builds normalized scorecard
    -> _scored_cache stores final scorecard in memory
    -> frontend renders the UI
```

## 2. Raw KPI Flow

Each KPI has a fetch script such as:

- `fetch_dot_kpi.py`
- `fetch_iot_kpi.py`
- `fetch_supplier_assessment.py`
- `fetch_supplier_compliance.py`
- `fetch_supplier_maturity.py`
- `fetch_co2_emission.py`
- `fetch_eclipse.py`
- `fetch_invoice_conformity.py`
- `fetch_price_divergence.py`

Each script does the same general work:

```text
1. Read rows from Databricks
2. Rename raw columns to app columns
3. Convert values to numeric/text as needed
4. Group rows by the KPI grain
5. Calculate the KPI metric
6. Write the final CSV to apps/backend/data/
```

Example group-by dimensions can include:

- `supplier`
- `parentSupplier`
- `zone`
- `country`
- `category`
- `sub_category`
- `purchasing_category`
- `scorecard_category`
- `vendor_account_number`
- `year`
- `month`
- `kpiApplicability`

## 3. Where Cache Is Used

There are two important in-memory caches in `server.py`:

### `_cache`

This holds the raw processed KPI rows loaded from CSV.

```text
CSV on disk -> _load_cache_from_disk() -> _cache
```

The individual KPI endpoints read from this cache.

### `_scored_cache`

This holds the precomputed normalized scorecard.

```text
_cache -> compute_scorecard() -> _scored_cache
```

This is what the normalized scorecard API serves.

## 4. KPI Earned Score Flow

For each KPI, the backend calculates a parent supplier score in `scorecard.py`.

```text
raw KPI rows
   -> aggregate to one raw KPI value per parent
   -> apply floor/target attainment
   -> split parents into scorecard_category cohorts
   -> calculate percentile rank inside each cohort
   -> calculate earned KPI points
```

This cohort rule applies to all nine active KPIs. A supplier or parent is
compared only with peers that have the same `scorecard_category`. Blank values
use the explicit fallback `Unassigned scorecard category`. Raw KPI formulas,
floor/target attainment, KPI weights, pillar weights, and the earned-score
formula are unchanged.

The general earned score formula is:

```text
earned = max_score * attainment * (0.70 + 0.30 * percentile)
```

The exact raw ratio depends on the KPI:

- DOT: on-time lines divided by adjusted delivered lines
- IOT: invoice on-time count divided by total PO lines
- Invoice Conformity: conforming invoices divided by total invoices
- Price Divergence: absolute invoice minus PO difference divided by PO value
- SA: weighted count of green/yellow/red rows
- SC, SM, ECL: mean value per parent supplier
- CO2: quartile-based scoring on emission values

## 5. Individual KPI Loading Paths

Individual KPI pages now follow two loading patterns.

### Path A: Backend-Calculated Optimized KPIs

Used by:

- DOT
- IOT
- Price Divergence

Flow:

```text
Frontend slicers
   -> API query params
   -> backend filters cached rows
   -> backend recalculates KPI result, cohort, rank, percentile, and earned score
   -> frontend displays returned results
```

For these pages, the frontend sends slicers such as `category`,
`sub_category`, `purchasing_category`, `scorecard_category`,
`vendor_account_number`, `year`, `month`, `zone`, and `country` to the backend.
The backend read model applies the filters against `_cache` and returns the
final results for the selected cohort.

### Path B: Frontend-Calculated Consistent KPIs

Used by:

- Supplier Assessment
- Supplier Compliance
- Supplier Maturity
- CO2 Emission
- Eclipse
- Invoice Conformity

Flow:

```text
Backend cached rows
   -> frontend receives KPI source rows
   -> frontend applies slicers
   -> frontend recalculates visible KPI result, cohort, rank, percentile, and earned score
   -> frontend displays results
```

For these pages, the backend provides refreshed cached rows, while the frontend
shared KPI model performs the slicer-specific calculation.

In both paths, slicers define the cohort. Changing `Sub Category`,
`Purchase Category`, `Ranking Category`, or `Account Number` can change the
rows included, the peer comparison group, percentile, rank, and earned score.

Display label mapping:

```text
category              -> Category
sub_category          -> Sub Category
purchasing_category   -> Purchase Category
scorecard_category    -> Ranking Category
vendor_account_number -> Account Number
```

## 6. Normalized Scorecard Flow

Once every KPI has an earned score, the scorecard is assembled:

```text
KPI earned points
   -> pillar score %
   -> weighted pillar contribution
   -> normalized score
   -> coverage-adjusted score
```

Formula:

```text
pillar_score_pct = sum(earned KPI points) / sum(applicable KPI max points)

normalized_score = sum(pillar_score_pct * pillar_weight) / sum(applicable pillar weight) * 100

coverage_adjusted_score = normalized_score * coverage
```

The pillar weights are defined in `apps/backend/scorecard.py`.

### Normalized Scorecard Control Mapping

The Normalized Scorecard page mixes backend cohort recomputation with frontend
selection controls.

| Control | Behavior | Where it happens |
| --- | --- | --- |
| `Zone` | Recomputes the scorecard cohort for the selected zone(s). | Backend recompute |
| `Category` | Recomputes the scorecard cohort for the selected category/categories. | Backend recompute |
| `Country` | Recomputes the scorecard cohort for the selected country/countries. | Backend recompute |
| `Sub Category` | Recomputes the scorecard cohort for the selected sub-category values. | Backend recompute |
| `Purchase Category` | Recomputes the scorecard cohort for the selected purchasing category values. | Backend recompute |
| `Ranking Category` | Recomputes the scorecard cohort for the selected `scorecard_category` values. | Backend recompute |
| `Parent Supplier` | Selects one parent supplier from the current computed cohort and shows its detail. | Row selection |
| `Search Supplier` | Searches parent suppliers within the current cohort so a parent can be selected. | Search + row selection |

Practical flow:

```text
No filters
   -> frontend reads global backend _scored_cache

Zone, Category, Country, Sub Category, Purchase Category, or Ranking Category selected
   -> frontend sends filters to backend
   -> backend reruns compute_scorecard(...) for that cohort
   -> frontend renders the filtered backend result

Parent Supplier or Search Supplier used
   -> frontend selects a parent from the current scorecard cohort
   -> no full scorecard recomputation just for that parent
```

## 7. Refresh Flow

When you refresh a KPI dataset, the flow is:

```text
Refresh endpoint
   -> fetch raw Databricks data
   -> process into CSV
   -> save CSV to disk
   -> reload CSV into _cache
   -> rebuild _scored_cache
   -> frontend sees updated data
```

For the normalized scorecard, the backend also rebuilds the scorecard cache
at startup and after refresh.

## 8. Frontend View

The frontend has two roles:

- For optimized KPIs, it sends slicers to the backend and renders returned
  calculated results.
- For consistent KPIs, it receives cached KPI rows and recalculates the selected
  slicer view locally.
- For the normalized scorecard, it calls the scorecard API and renders the
  backend `_scored_cache` results.

## 9. Short Version

If you want the shortest mental model:

```text
Raw data -> CSV -> _cache

Optimized KPIs:
_cache -> backend applies slicers and recalculates -> frontend

Consistent KPIs:
_cache -> frontend applies slicers and recalculates -> frontend

Normalized scorecard:
_cache -> compute_scorecard() -> _scored_cache -> frontend
```

## 10. Key Files

- `apps/backend/server.py`
- `apps/backend/scorecard.py`
- `apps/backend/dot_read_model.py`
- `apps/backend/iot_read_model.py`
- `apps/backend/pdiv_read_model.py`
- `apps/backend/fetch_dot_kpi.py`
- `apps/backend/fetch_iot_kpi.py`
- `apps/backend/fetch_supplier_assessment.py`
- `apps/backend/fetch_supplier_compliance.py`
- `apps/backend/fetch_supplier_maturity.py`
- `apps/backend/fetch_co2_emission.py`
- `apps/backend/fetch_eclipse.py`
- `apps/backend/fetch_invoice_conformity.py`
- `apps/backend/fetch_price_divergence.py`
- `apps/frontend/src/pages/ConsistentKpiPage.tsx`
- `apps/frontend/src/shared/consistentKpiModel.ts`

## 11. One-Page Visual Diagram

```text
                               ALL 9 KPI FLOWS
┌─────────────────────────────────────────────────────────────────────────────┐
│  Raw Databricks tables                                                      │
│   DOT  IOT  SA  SC  SM  CO2  ECL  IC  PDIV                                  │
└─────────────────────────────────────────────────────────────────────────────┘
        │        │        │        │        │        │        │        │
        ▼        ▼        ▼        ▼        ▼        ▼        ▼        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  fetch_*.py connectors                                                      │
│  - read source rows                                                         │
│  - rename columns                                                           │
│  - group by KPI grain                                                       │
│  - calculate KPI metric                                                     │
│  - write CSV to apps/backend/data/                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  In-memory raw KPI cache: _cache                                             │
│  - loaded from CSV at startup                                                │
│  - reloaded after refresh                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                 │                                       │
                 │                                       │
                 ▼                                       ▼
┌───────────────────────────────────────────┐   ┌─────────────────────────────┐
│ KPI pages / drill-down APIs               │   │ Normalized scorecard cache   │
│                                           │   │ _scored_cache                │
│ /api/dot-kpi                              │   │                             │
│ /api/iot-kpi                              │   │ compute_scorecard(_cache)    │
│ /api/supplier-assessment                  │   │   -> per-KPI earned score    │
│ /api/supplier-compliance                  │   │   -> pillar score            │
│ /api/supplier-maturity                    │   │   -> normalized score        │
│ /api/co2-emission                         │   │   -> coverage-adjusted score  │
│ /api/eclipse                              │   └─────────────────────────────┘
│ /api/invoice-conformity                   │
│ /api/price-divergence                    │
└───────────────────────────────────────────┘
                 │                                       │
                 ▼                                       ▼
┌───────────────────────────────────────────┐   ┌─────────────────────────────┐
│ Frontend KPI tables                      │   │ Frontend Normalized Scorecard│
│ - shows processed KPI rows               │   │ - shows parent suppliers     │
│ - supports filters / drill-down           │   │ - uses cached scorecard data │
└───────────────────────────────────────────┘   └─────────────────────────────┘
```

### Quick reading guide

- Left side: the 9 KPI datasets and their individual pages.
- Middle: the backend CSV cache that powers the KPI APIs.
- Right side: the precomputed normalized scorecard cache.
- Bottom: what the frontend actually renders.
