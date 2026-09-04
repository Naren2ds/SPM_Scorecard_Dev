# SPM API Contract

## Purpose

This document defines the backend API endpoints required to support the SPM Figma screens, mapped to the tables in [Table_Schema.MD](./Table_Schema.MD). It is the agreement between backend and frontend: the backend guarantees these request parameters and response fields; the frontend only requests, renders, and does not calculate.

**Core rule:** All KPI, pillar, coverage, spend, and portfolio calculations happen in the backend/data layer. The frontend sends filters and grouping, and displays the values returned.

---

## Common Request Parameters

Every endpoint below accepts this shared filter contract unless stated otherwise.

| Parameter | Type | Example | Required | Notes |
|---|---|---|---|---|
| `scorecard_id` | string | `SPM` | Yes | Selects the scorecard; also supports `SAZ_SPM_CALCULATION` |
| `reporting_period` | date | `2026-07-01` | Yes | First day of the reporting month |
| `zone` | string | `MAZ` | No | Filters `SUPPLIER.zone` |
| `country` | string | `Mexico` | No | Filters `SUPPLIER.country` |
| `gpo_category` | string | `Packaging` | No | Confirm exact source field with business before final build |
| `purchasing_category` | string | `Cans` | No | Filters `SUPPLIER.purchasing_category` |
| `scorecard_category` | string | `BST` | No | Filters `SUPPLIER.scorecard_category`; also drives `PILLAR_APPLICABILITY_RULE` |
| `parent_supplier_id` | string | `PARENT-001` | No | Filters to one parent supplier |
| `supplier_id` | string | `SUP-10027` | No | Filters to one vendor-level supplier |
| `group_by` | string (comma list) | `zone,country,parent_supplier` | Grid endpoints only | Controls hierarchy aggregation level |

All endpoints return HTTP 200 with a JSON body on success. Errors return a standard shape:

```json
{
  "error_code": "INVALID_REPORTING_PERIOD",
  "message": "No data found for reporting_period 2026-07-01 and scorecard_id SPM."
}
```

---

## Endpoint 1: Reporting Periods

**Figma screen:** Time Period slicer (recommended addition, not yet in Figma).

**Purpose:** Lets the frontend populate the period dropdown without guessing which periods have data.

```text
GET /api/spm/reporting-periods?scorecard_id=SPM
```

**Primary tables:** `SCORECARD_SCORE` (distinct `reporting_period` values), `SCORECARD_DEFINITION`.

**Response:**

```json
{
  "scorecard_id": "SPM",
  "periods": [
    { "reporting_period": "2026-07-01", "label": "July 2026", "is_latest": true },
    { "reporting_period": "2026-06-01", "label": "June 2026", "is_latest": false }
  ]
}
```

---

## Endpoint 2: Overview (Screen 1 — General View)

**Figma screen:** Overall SPM gauge and four pillar cards, with filters (Packaging / MAZ / All suppliers) and "Last updated" timestamp.

```text
GET /api/spm/overview
    ?scorecard_id=SPM
    &reporting_period=2026-07-01
    &gpo_category=Packaging
    &zone=MAZ
```

**Primary tables:** `SCORECARD_SCORE`, `PILLAR_SCORE`, `PILLAR_DEFINITION`, `PILLAR_APPLICABILITY_RULE`.

**Response:**

```json
{
  "scorecard_id": "SPM",
  "reporting_period": "2026-07-01",
  "filters_applied": { "gpo_category": "Packaging", "zone": "MAZ" },
  "calculated_at": "2026-07-30T09:15:00Z",
  "overall_score": 69.0,
  "score_band": "Fair",
  "pillars": [
    { "pillar_id": "SERVICE_LEVEL", "pillar_name": "Service Level", "score": 76.0, "status": "applicable" },
    { "pillar_id": "OPERATIONAL", "pillar_name": "Operational", "score": 62.7, "status": "applicable" },
    { "pillar_id": "SUSTAINABILITY", "pillar_name": "Sustainability", "score": 66.9, "status": "applicable" },
    { "pillar_id": "VALUE_CREATION", "pillar_name": "Value Creation", "score": 35.4, "status": "applicable" }
  ]
}
```

`status` is `"not_applicable"` when `PILLAR_APPLICABILITY_RULE` excludes the pillar, for example Sustainability for a BST-filtered population. The frontend renders `N/A` instead of a score for that card.

**Open item:** `calculated_at` requires a calculation-run/freshness field not yet finalized in `Table_Schema.MD`.

---

## Endpoint 3: Scorecard Grid (Screens 2, 3, and 4 — one unified Zone x Country x Parent Supplier grid)

**Revision note:** The exported grid screenshot confirms Screens 2, 3, and 4 in the original Figma review are **the same table**, not three separate screens. Every row already carries Spend, SPM Score, Status, Deductions, **and** every KPI across all four pillars (Service Level, Operational, Sustainability, Value Creation) side by side. Endpoint 4 (KPI Grid) is therefore removed as a separate endpoint and merged into this one. Figma should be updated to reflect a single wide grid rather than three separate pillar tabs, and each KPI column should show both the KPI Value and (optionally, toggleable) the KPI Score.

**Figma screen:** Expandable tree table (Zone > Country > Parent Supplier) with Spend, SPM score, Status, Deductions, followed by every KPI column grouped under its pillar header.

```text
GET /api/spm/scorecard-grid
    ?scorecard_id=SPM
    &reporting_period=2026-07-01
    &gpo_category=Packaging
    &zone=MAZ
    &group_by=zone,country,parent_supplier
    &include_kpis=true
```

| Parameter | Type | Example | Required | Notes |
|---|---|---|---|---|
| `include_kpis` | boolean | `true` | No, default `true` | When `false`, returns only Spend/SPM Score/Status/Deductions for a lighter-weight summary grid |

**Primary tables:** `SUPPLIER`, `SCORECARD_SCORE`, `PILLAR_SCORE`, `KPI_INPUT`, `KPI_SCORE`, `KPI_DEFINITION`, `SUPPLIER_SPEND` (proposed, not yet in schema).

**Response:** One row per hierarchy level, with a nested `kpis` array grouped by pillar. Based on your screenshot data:

```json
{
  "group_by": ["zone", "country", "parent_supplier"],
  "pillars": ["SERVICE_LEVEL", "OPERATIONAL", "SUSTAINABILITY", "VALUE_CREATION"],
  "rows": [
    {
      "level": "TOTAL",
      "spend": 8825343.95,
      "spm_score": 69.0,
      "status": "Fair",
      "deductions_points": 31.0,
      "kpis": [
        { "kpi_id": "DOT", "kpi_name": "On-Time Delivery", "pillar_id": "SERVICE_LEVEL", "raw_value": 0.931, "raw_value_unit": "percent", "kpi_score": 9.31, "max_score": 10.0 },
        { "kpi_id": "NPS", "kpi_name": "Net Promoter Score", "pillar_id": "SERVICE_LEVEL", "raw_value": 74.2, "raw_value_unit": "score_0_100", "kpi_score": 7.42, "max_score": 10.0 },
        { "kpi_id": "PDIV", "kpi_name": "Price Divergence", "pillar_id": "OPERATIONAL", "raw_value": 0.019, "raw_value_unit": "percent", "kpi_score": 4.62, "max_score": 5.0 },
        { "kpi_id": "IC", "kpi_name": "Invoice Conformity", "pillar_id": "OPERATIONAL", "raw_value": 0.916, "raw_value_unit": "percent", "kpi_score": 4.58, "max_score": 5.0 },
        { "kpi_id": "IOT", "kpi_name": "Invoice On-Time", "pillar_id": "OPERATIONAL", "raw_value": 0.946, "raw_value_unit": "percent", "kpi_score": 9.46, "max_score": 10.0 },
        { "kpi_id": "SM", "kpi_name": "Supplier Maturity", "pillar_id": "SUSTAINABILITY", "raw_value": 89.2, "raw_value_unit": "score_0_100", "kpi_score": 8.92, "max_score": 10.0 },
        { "kpi_id": "COST", "kpi_name": "Cost", "pillar_id": "VALUE_CREATION", "raw_value": 8.1, "raw_value_unit": "score_0_10", "kpi_score": 8.1, "max_score": 10.0 },
        { "kpi_id": "CASH", "kpi_name": "Cash", "pillar_id": "VALUE_CREATION", "raw_value": 9.2, "raw_value_unit": "score_0_10", "kpi_score": 9.2, "max_score": 10.0 },
        { "kpi_id": "ENG", "kpi_name": "Engagement", "pillar_id": "VALUE_CREATION", "raw_value": 88.8, "raw_value_unit": "score_0_100", "kpi_score": 8.88, "max_score": 10.0 }
      ]
    },
    {
      "level": "ZONE",
      "zone": "MAZ",
      "spend": 8825343.95,
      "spm_score": 69.0,
      "status": "Fair",
      "deductions_points": 31.0,
      "kpis": [ "...same shape as TOTAL, aggregated for zone MAZ..." ]
    },
    {
      "level": "COUNTRY",
      "zone": "MAZ",
      "country": "Mexico",
      "spend": 5221550.80,
      "spm_score": 79.0,
      "status": "Good",
      "deductions_points": 21.0,
      "kpis": [ "...aggregated for country Mexico..." ]
    },
    {
      "level": "PARENT_SUPPLIER",
      "zone": "MAZ",
      "country": "Mexico",
      "parent_supplier": "Ball Packaging Mexico",
      "spend": 2453890.45,
      "spm_score": 88.0,
      "status": "Good",
      "deductions_points": 12.0,
      "kpis": [
        { "kpi_id": "DOT", "kpi_name": "On-Time Delivery", "pillar_id": "SERVICE_LEVEL", "raw_value": 0.97, "raw_value_unit": "percent", "kpi_score": 9.7, "max_score": 10.0 },
        { "kpi_id": "NPS", "kpi_name": "Net Promoter Score", "pillar_id": "SERVICE_LEVEL", "raw_value": 81.0, "raw_value_unit": "score_0_100", "kpi_score": 8.1, "max_score": 10.0 },
        { "kpi_id": "PDIV", "kpi_name": "Price Divergence", "pillar_id": "OPERATIONAL", "raw_value": 0.012, "raw_value_unit": "percent", "kpi_score": 4.88, "max_score": 5.0 },
        { "kpi_id": "IC", "kpi_name": "Invoice Conformity", "pillar_id": "OPERATIONAL", "raw_value": 0.97, "raw_value_unit": "percent", "kpi_score": 4.85, "max_score": 5.0 },
        { "kpi_id": "IOT", "kpi_name": "Invoice On-Time", "pillar_id": "OPERATIONAL", "raw_value": 0.98, "raw_value_unit": "percent", "kpi_score": 9.8, "max_score": 10.0 },
        { "kpi_id": "SM", "kpi_name": "Supplier Maturity", "pillar_id": "SUSTAINABILITY", "raw_value": 92.66666667, "raw_value_unit": "score_0_100", "kpi_score": 9.27, "max_score": 10.0 },
        { "kpi_id": "COST", "kpi_name": "Cost", "pillar_id": "VALUE_CREATION", "raw_value": 9.6, "raw_value_unit": "score_0_10", "kpi_score": 9.6, "max_score": 10.0 },
        { "kpi_id": "CASH", "kpi_name": "Cash", "pillar_id": "VALUE_CREATION", "raw_value": 11.2, "raw_value_unit": "score_0_10", "kpi_score": 11.2, "max_score": 10.0 },
        { "kpi_id": "ENG", "kpi_name": "Engagement", "pillar_id": "VALUE_CREATION", "raw_value": 100.0, "raw_value_unit": "score_0_100", "kpi_score": 10.0, "max_score": 10.0 }
      ]
    }
  ]
}
```

**Why one endpoint, not two:** Splitting into `scorecard-grid` (Screen 2) and `kpi-grid` (Screens 3/4) would force the frontend to make two calls per row and manually merge them back into one visual table, which duplicates the exact filter/group_by/hierarchy logic on both sides. Since Figma's actual grid already shows Spend + Score + Status + Deductions + all-pillar KPIs in a single row, one call returning the full row is simpler, faster, and matches the real UI.

**Open items requiring confirmation:**
- Whether `parent_supplier` here means `SUPPLIER.parent_supplier_id`/`parent_supplier_name`, and not the vendor-level `supplier_id`.
- Formula for `deductions_points`. Screenshot shows `Deductions = 100 - spm_score` at every row (for example `100 - 69 = 31`, `100 - 88 = 12`). Confirm this is the intended definition, or whether it should instead be based on lost pillar-weighted points.
- `spend` requires the new `SUPPLIER_SPEND` table (see [Table_Schema.MD](./Table_Schema.MD)).
- Some Cost/Cash values in the screenshot exceed their apparent 0–10 scale (for example `11.2`, `12.1`) — confirm the correct `raw_value_unit` and `max_score` for these Value Creation KPIs before finalizing `KPI_VERSION` entries.
- Whether `kpi_score` is shown by default beside `raw_value` in every column, or only on hover/toggle, per the Figma update needed to expose KPI values.

---

## Endpoint 4: Portfolio (Screen 5 — Supplier Portfolio / Category Strategy)

**Figma screen:** Bubble chart, X-axis Performance, Y-axis Weighted Spend, bubble colour by supplier category, quadrant labels.

```text
GET /api/spm/portfolio
    ?scorecard_id=SPM
    &reporting_period=2026-07-01
    &purchasing_category=Cans,Glass
```

**Primary tables:** `SCORECARD_SCORE`, `SUPPLIER`, `SUPPLIER_SPEND` (proposed), `PORTFOLIO_SEGMENT_RULE` (proposed).

**Response:**

```json
{
  "axis_definitions": {
    "x_axis": "normalized_score",
    "y_axis": "spend_share_trailing_12m",
    "bubble_size": "spend_amount_trailing_12m"
  },
  "thresholds": { "performance": 70, "spend_share": 0.40 },
  "points": [
    {
      "parent_supplier": "Vidrala México",
      "supplier_category": "Glass",
      "performance": 85,
      "spend_share": 0.35,
      "spend_amount": 3100000.00,
      "quadrant": "IMPROVEMENT"
    },
    {
      "parent_supplier": "Owens-Illinois Perú",
      "supplier_category": "Glass",
      "performance": 58,
      "spend_share": 0.24,
      "spend_amount": 1400000.00,
      "quadrant": "RECOVER_REPLACE"
    }
  ]
}
```

**Open items requiring business confirmation before final build:**
- Exact definition of `spend_share` (trailing 12-month vs. current period vs. absolute).
- Source of `supplier_category` bubble colour: confirm against `SUPPLIER.sub_category` or `SUPPLIER.purchasing_category`.
- Quadrant threshold values, to be stored in the proposed `PORTFOLIO_SEGMENT_RULE` table.

---

## Endpoint 5: Export

**Figma screen:** Excel export button (Screen 1).

```text
GET /api/spm/export
    ?scorecard_id=SPM
    &reporting_period=2026-07-01
    &gpo_category=Packaging
    &zone=MAZ
    &group_by=zone,country,parent_supplier
    &format=xlsx
```

**Behavior:** Uses the same filters and grouping as the currently active screen. Returns a file stream, not JSON. Must reflect exactly the rows and columns visible to the user at the time of export, including KPI Value and KPI Score if both are visible.

---

## Endpoint-to-Figma-Screen Summary

| Figma Screen | Endpoint | Primary Tables | Open Items |
|---|---|---|---|
| Time Period slicer (recommended) | `/api/spm/reporting-periods` | `SCORECARD_SCORE` | None |
| 1. General View | `/api/spm/overview` | `SCORECARD_SCORE`, `PILLAR_SCORE`, `PILLAR_DEFINITION` | `calculated_at` freshness field |
| 2, 3, 4. Unified Zone/Country/Parent Supplier grid (Spend, Score, Status, Deductions, all-pillar KPIs) | `/api/spm/scorecard-grid` | `SUPPLIER`, `SCORECARD_SCORE`, `PILLAR_SCORE`, `KPI_INPUT`, `KPI_SCORE`, `KPI_DEFINITION`, `SUPPLIER_SPEND` | Hierarchy level, `deductions_points` formula, spend table, KPI Score visibility |
| 5. Supplier Portfolio | `/api/spm/portfolio` | `SCORECARD_SCORE`, `SUPPLIER`, `SUPPLIER_SPEND`, `PORTFOLIO_SEGMENT_RULE` | Weighted Spend definition, quadrant thresholds |
| Excel export | `/api/spm/export` | Same as the active screen | None |

**Figma action needed:** Update the design to reflect one wide grid (as in the exported screenshot) rather than three separate screens/tabs, with KPI Value shown in every KPI column and KPI Score available either inline or via toggle/tooltip.

---

## Confirmation Checklist Before Backend Build

1. Is the lowest grid row `parent_supplier_id` or `supplier_id`?
2. What is the exact formula for `deductions_points`?
3. What is the business definition of `Weighted Spend` for the portfolio Y-axis and bubble size?
4. Does the `Packaging` filter map to `gpo_category`, `purchasing_category`, or another field?
5. Should `kpi_score` be shown by default next to `raw_value`, or only in a drilldown?
6. Confirm whether `SUPPLIER_SPEND` and `PORTFOLIO_SEGMENT_RULE` should be added to [Table_Schema.MD](./Table_Schema.MD) before backend implementation starts.
