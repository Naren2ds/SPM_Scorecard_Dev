# SAZ Data Pipeline

## Purpose

This document describes the SAZ data pipeline: a source-provided data ingestion pipeline that reads SAZ's existing Databricks table(s), validates them with Pydantic models, and writes them into the staging/input layer of the [Table Schema](./Table_Schema.MD). It performs **no scoring calculation** — SAZ already provides KPI, pillar, and final scores; this pipeline's only job is to get that data into the schema correctly.

Related documents:
- [Table_Schema.MD](./Table_Schema.MD) — the full table schema, including the `SOURCE_PROVIDED` calculation mode
- [API_Contract.md](./API_Contract.md) — how the frontend consumes the resulting scores

**Branch:** `feature/saz-data-pipeline`
**Code location:** `apps/saz_pipeline/src/data_pipeline/saz/`

---

## Scorecard Identity

```text
scorecard_id: SAZ_SPM_CALCULATION
calculation_mode: SOURCE_PROVIDED
```

Every row this pipeline produces is eventually tagged `calculation_source = SOURCE_PROVIDED` once promoted into the shared result tables. No attainment, pillar roll-up, or normalized-score formula is ever applied to SAZ data.

---

## End-to-End Flow

```text
Databricks source table(s)  (SAZ raw data)
        |
        v
apps/saz_pipeline/src/data_pipeline/saz/
        |
        +-- load_supplier/          --> writes into SUPPLIER
        +-- load_kpi_input/         --> writes into KPI_INPUT       (input_value column; SAZ does not pre-score individual KPIs)
        +-- load_pillar_input/      --> writes into PILLAR_INPUT
        +-- load_scorecard_input/   --> writes into SCORECARD_INPUT
        |
        v
Promotion job (separate, reusable across all SOURCE_PROVIDED scorecards)
        |
        +-- KPI_INPUT.input_value                 --> reference/display only for SAZ; no KPI_SCORE row is promoted
        +-- PILLAR_INPUT.source_pillar_score_pct --> PILLAR_SCORE
        +-- SCORECARD_INPUT.source_normalized_score --> SCORECARD_SCORE
        (each row tagged calculation_source = SOURCE_PROVIDED)
        |
        v
Backend API (/api/spm/overview, /api/spm/scorecard-grid, etc.)
        filtered by scorecard_id = SAZ_SPM_CALCULATION
        |
        v
Frontend — same screens, same grid, same API contract as generic SPM
```

---

## Why the Pipeline Only Touches 4 of the Schema Tables

The full schema has three categories of tables. This pipeline only writes to the middle category.

| Category | Tables | Who populates them | Why this pipeline doesn't touch them |
|---|---|---|---|
| **Configuration** (set up once, rarely changes) | `SCORECARD_DEFINITION`, `PILLAR_DEFINITION`, `KPI_DEFINITION`, `KPI_VERSION`, `KPI_SCOPE`, `PILLAR_APPLICABILITY_RULE` | Admin, manually or via the KPI onboarding Excel template | Business decisions (which pillars/KPIs exist, calculation mode) — not data that arrives from Databricks every run |
| **Input / staging** (refreshed every pipeline run) | `SUPPLIER`, `KPI_INPUT`, `PILLAR_INPUT`, `SCORECARD_INPUT` | **This pipeline** | This is the data that changes every reporting period |
| **Output / shared results** (consumed by API/frontend) | `KPI_SCORE`, `PILLAR_SCORE`, `SCORECARD_SCORE` | A separate promotion job, not this pipeline | Validation (duplicate checks, valid FK references, numeric ranges) lives in one reusable place shared by every `SOURCE_PROVIDED` scorecard, not duplicated per pipeline |

The configuration tables must already exist (`scorecard_id = SAZ_SPM_CALCULATION` registered, pillars and KPIs defined) before this pipeline can run — see [Table_Schema.MD](./Table_Schema.MD) for the full definitions.

---

## Folder-to-Table Mapping

| Pipeline folder | Pydantic model | Target schema table | What it writes |
|---|---|---|---|
| `load_supplier/` | `SupplierRecord` | `SUPPLIER` | Zone, country, parent supplier, category attributes for SAZ suppliers |
| `load_kpi_input/` | `KpiInputRecord` | `KPI_INPUT` | `input_value` (raw measurement per supplier x KPI x period), plus `applicability_status`. SAZ never populates `source_kpi_score` — it does not pre-compute per-KPI scores. |
| `load_pillar_input/` | `PillarInputRecord` | `PILLAR_INPUT` | `source_pillar_score_pct`, `source_weighted_contribution`, `source_coverage_pct` per supplier x pillar x period |
| `load_scorecard_input/` | `ScorecardInputRecord` | `SCORECARD_INPUT` | `source_normalized_score`, `source_coverage_pct`, `source_coverage_adjusted_score`, `source_score_band` per supplier x period |

---

## Scaffolding

```text
apps/
    saz_pipeline/
        src/
            data_pipeline/
                saz/
                    load_supplier/
                        load_supplier.py   <- query + SupplierRecord + transform logic
                        main.py            <- entrypoint (Databricks job/workflow task)
                    load_kpi_input/
                        load_kpi_input.py
                        main.py
                    load_pillar_input/
                        load_pillar_input.py
                        main.py
                    load_scorecard_input/
                        load_scorecard_input.py
                        main.py
        requirements.txt
        tests/
```

Each `main.py` is the callable entrypoint invoked by a Databricks Job/Workflow task. It calls into its sibling `load_<table_name>.py` for the actual fetch/validate/write logic, keeping orchestration separate from transformation.

A shared base loader class (to be placed in a common module) handles the repeated Databricks connect → fetch → validate → write flow, so each `load_<table_name>.py` only supplies its query and its Pydantic model.

```text
BaseDatabricksLoader
    .fetch_raw() -> DataFrame
    .validate(df, model) -> list[PydanticModel]
    .write(records) -> output path/table
```

---

## Validation Rules

Rows failing Pydantic validation are logged and excluded, not silently dropped. A rejected-rows report is produced per run so data-quality issues are visible before they reach the input tables.

| Rule | Applies to |
|---|---|
| Required fields present and correctly typed | All four models |
| `applicability_status` restricted to `Applicable` / `Not Applicable` | `KpiInputRecord` |
| `reporting_period` is a valid first-of-month date | All four models |
| `input_value`, `source_pillar_score_pct`, `source_normalized_score` within an agreed numeric range | `KpiInputRecord`, `PillarInputRecord`, `ScorecardInputRecord` |
| No duplicate `(parent_supplier_id, pillar/scorecard, reporting_period)` grain per batch | `PillarInputRecord`, `ScorecardInputRecord` |
| No duplicate `kpi_input_id` (`main_category`-`supplier_id`-`kpi_id`-`subcategory`-`reporting_period`) per batch | `KpiInputRecord` |

**Why `subcategory` is part of `kpi_input_id`:** the same vendor can have multiple source rows for the same month, one per product line/subcategory (e.g. WESTROCK: `FOLDING CARTONS` vs `CORRUGATED BOARD`), each with genuinely different KPI measurements. Deduplicating only on `(supplier_id, kpi_id, reporting_period)` would silently discard one of them. Including `subcategory` in the ID keeps every distinct measurement while still catching true accidental duplicates (an identical `kpi_input_id` appearing twice).

---

## Confirmed Source Tables and Column Mapping

**Source tables (split per `main_category`, confirmed by direct inspection, identical wide schema of ~69 columns in every table):**

| main_category | Table | Row count |
|---|---|---:|
| `BST` | `brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_bst` | 777 |
| `Brand Act Commercial` | `brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_brand_act_commercial` | 406 |
| `Brand Commercials` | `brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_brand_commercials` | 54 |
| `Capex MRO` | `brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_capex_mro` | 98 |
| `Directs` | `brewdat_uc_supchn_dev.gld_ghq_procurement_spm.saz_supplier_scorecard_directs` | 749 |

This is a physical split of the original single wide table (2,084 rows total, matching exactly) into 5 tables by category — no column changes. Each loader now selects its source table via `main_category` using `MAIN_CATEGORY_TO_TABLE` in `apps/saz_pipeline/src/data_pipeline/saz/common/constants.py`, instead of filtering one combined table by `WHERE main_category = ...`.

### Category Hierarchy Discovered

```text
main_category  (5 values: BST, Brand Act Commercial, Brand Commercials, Capex MRO, Directs)
    -> category  (6 values: BST, CAPEX, COMM CAPEX, COMMERCIAL, PACKAGING, RAU; sub-grouping within main_category)
        -> subcategory  (e.g. SERVICES, MARKETING, MAINTENANCE, OTHER RAW MATERIALS)
```

`main_category` determines which pillar/KPI columns are populated for a row — the same mechanism as the existing BST Sustainability-exclusion rule in generic SPM. `category` is a finer sub-grouping one level below `main_category` (e.g. `Capex MRO` splits into `CAPEX` / `COMM CAPEX`; `Directs` splits into `PACKAGING` / `RAU`) and is stored in the new `SUPPLIER.saz_category` column (see [Table_Schema.MD](./Table_Schema.MD)).

### `SUPPLIER` Mapping

| Source column | Target column | Notes |
|---|---|---|
| `parent_company` | `parent_supplier_name` | Roll-up key |
| `main_category` | `scorecard_category` | Drives pillar/KPI applicability |
| `category` | `saz_category` | Sub-grouping within `main_category` |
| `subcategory` | `sub_category` | |
| `total_spend` | `SUPPLIER_SPEND.spend_amount` (proposed table) | |
| `year` + `month` | `reporting_period` (all `*_INPUT` tables) | Combine into first-of-month date, e.g. `2026` + `July` -> `2026-07-01` |
| `source_file` | `source_reference` (all `*_INPUT` tables) | Good lineage value, e.g. `july_2026_main_category_bst.xlsx` |

### `SCORECARD_INPUT.source_normalized_score` — column varies by `main_category`

| main_category | Source column |
|---|---|
| `BST`, `Brand Act Commercial`, `Brand Commercials` | `overall_score` |
| `Capex MRO` | `overall_score_indirects` |
| `Directs` | `overall_score_directs` |

### `PILLAR_INPUT.source_pillar_score_pct` — one row per pillar per supplier per period

| Pillar | Source column(s) | Populated for |
|---|---|---|
| Sustainability | `sustainability` | All 5 `main_category` values |
| Operational | `operational` | BST, Brand Act Commercial, Capex MRO, Directs |
| Value Creation | `COALESCE(value_generation, value_generation_formula)` | `value_generation` for Brand Act Commercial/Brand Commercials/Capex MRO/Directs; `value_generation_formula` for BST — **confirmed to be the same pillar under two column names, never populated simultaneously** |
| Service Level | `service_level_indirects` | Capex MRO |
| Service Level | `service_level_directs` | Directs |

### `KPI_INPUT.input_value` — confirmed populated columns per `main_category` (full-table check, 2,084 rows)

| main_category | Populated KPI columns |
|---|---|
| `BST` | `ns`, `acceptance_term`, `cost`, `cash_flow`, `engagement`, `price`, `upload_nf`, `turnover`, `absenteeism`, `satisfaction`, `gps`, `bees_tasks`, `sla_vacancies`, `blank_route`, `invoice_compliance_po_not_found`, `deloitte_compliance`, plus rare (`turnover_perception`: 18 rows, `contract_compliance_tech`: 4 rows, `quality_tech`: 18 rows) |
| `Brand Act Commercial` | `ns`, `acceptance_term`, `cost`, `cash_flow`, `engagement`, `invoice_compliance`, `price`, `upload_nf`, `ontime_production`, `recall`, `recall_ontime`, `quality_recall_ontime_recall`, `docs_nok_media_system`, `events_audit`, plus rare (`contract_compliance`: 3 rows) |
| `Brand Commercials` | `ns`, `nps`, `media_tools`, `cac`, `cpo`, `ratio_prod`, `extra_cost`, `op`, `media_system`, `acceptance_term`, `cash_flow` |
| `Capex MRO` | `acceptance_term`, `cost`, `cash_flow`, `engagement`, `mtf_total`, `mtf_audit`, `mtf_leadtime`, `mtf_tickets`, `mtf_audit_div`, `mtf_on_time`, `project_nps`, `ariba_adherence`, `invoice_compliance`, `price`, `upload_nf`, `eclipse_adherence` |
| `Directs` | `acceptance_term`, `cost`, `cash_flow`, `engagement`, `price`, `eclipse_adherence`, `invoice_compliance_po_not_found`, `quality_cars`, `quality_documentation`, `order_acceptance_rate`, `otif` |

### Business Names and Units — Pending Validation

No SAZ data dictionary is available. `kpi_name` and `input_unit` values in `KPI_DEFINITION` are proposed below from column names and observed value ranges (full-table `MIN`/`MAX`/`AVG` per `main_category`), and are marked **pending business validation** until confirmed by a SAZ stakeholder. Do not treat these as final.

`input_value` is stored on its native source scale without rescaling (see [KPI_INPUT mapping](#kpi_inputinput_value--confirmed-populated-columns-per-main_category-full-table-check-2084-rows) above); `input_unit` only documents how to interpret it for display/analytics.

| `kpi_id` | Used in `main_category` | Observed range | Proposed `input_unit` | Proposed `kpi_name` | Notes |
|---|---|---|---|---|---|
| `acceptance_term` | All 5 | 0–100 | `percent_0_100` | Acceptance Term | |
| `cost` | All 5 | 0–100 | `percent_0_100` | Cost Adherence | |
| `cash_flow` | All 5 | 3.33–96.67 | `percent_0_100` | Cash Flow Adherence | Never observed at 0 |
| `engagement` | All 5 | 0 (BST/Capex MRO/Brand Act Commercial); 0–100 (Directs) | `percent_0_100` | Engagement | Always 0 outside Directs — confirm whether it's genuinely unused for those categories |
| `price` | All 5 | 0–100 | `percent_0_100` | Price Adherence | |
| `upload_nf` | BST, Brand Act Commercial, Capex MRO | 6.67–100 | `percent_0_100` | Invoice (NF) Upload | |
| `turnover` | BST, Brand Commercials | 0–100 | `percent_0_100` | Turnover | Not a 0–1 fraction |
| `invoice_compliance_po_not_found` | BST, Directs | 0–100 | `percent_0_100` | Invoice Compliance (PO Not Found) | |
| `invoice_compliance` | Brand Act Commercial, Capex MRO | 0–100 | `percent_0_100` | Invoice Compliance | |
| `absenteeism` | BST | 0.04–1443.75 | **`pending`** | Absenteeism | Exceeds 0–100; possibly a rate per 1,000 workers or a different denominator |
| `satisfaction` | BST | 26.15–100 | `percent_0_100` | Satisfaction | |
| `gps` | BST | 73.95–95.11 | `percent_0_100` | GPS | Meaning of "GPS" unconfirmed |
| `bees_tasks` | BST | 26.79–43.77 | `percent_0_100` | BEES Tasks | |
| `sla_vacancies` | BST | 300–4900 | **`pending`** | SLA Vacancies | Looks like a count, not a percent |
| `blank_route` | BST | 0–10.48 | `percent_0_100` | Blank Route | Narrow range; confirm vs. count |
| `deloitte_compliance` | BST | 0–100 | `percent_0_100` | Deloitte Compliance | |
| `turnover_perception` | BST | 40–90 | `percent_0_100` | Turnover Perception | Rare (18 rows) |
| `contract_compliance_tech` | BST | 25–85 | `percent_0_100` | Contract Compliance (Tech) | Rare (4 rows) |
| `quality_tech` | BST | 46.67–100 | `percent_0_100` | Quality (Tech) | Rare (18 rows) |
| `ns` | BST, Brand Act Commercial, Brand Commercials | 0–1000 | **`index_0_1000`** | NS (Service Level Index?) | Not a percent; meaning of "NS" unconfirmed |
| `ontime_production` | Brand Act Commercial | 47.54–100 | `percent_0_100` | On-Time Production | |
| `recall` | Brand Act Commercial | 0–100 | `percent_0_100` | Recall | |
| `recall_ontime` | Brand Act Commercial | 100 (constant) | `percent_0_100` | Recall On-Time | |
| `quality_recall_ontime_recall` | Brand Act Commercial | 40–100 | `percent_0_100` | Quality Recall On-Time | |
| `docs_nok_media_system` | Brand Act Commercial | 0–100 | `percent_0_100` | Docs NOK (Media System) | |
| `events_audit` | Brand Act Commercial | 60.95–100 | `percent_0_100` | Events Audit | |
| `contract_compliance` | Brand Act Commercial | 81.58–97.22 | `percent_0_100` | Contract Compliance | Rare (3 rows) |
| `nps` | Brand Commercials | -8–100 | **`index_neg100_100`** | Net Promoter Score | Confirms NPS can legitimately be negative |
| `media_tools` | Brand Commercials | 100–300 | **`pending`** | Media Tools | Not a percent; possibly currency or count |
| `cac` | Brand Commercials | 2418 (constant) | **`pending`** | Customer Acquisition Cost | Likely currency |
| `cpo` | Brand Commercials | 191 (constant) | **`pending`** | Cost Per Order | Likely currency |
| `ratio_prod` | Brand Commercials | 90 (constant) | `percent_0_100` | Production Ratio | |
| `extra_cost` | Brand Commercials | 100 (constant) | **`pending`** | Extra Cost | Only one observed value; percent vs. currency unclear |
| `op` | Brand Commercials | 0–100,000 | **`pending`** | OP | Likely currency/volume, not a percent |
| `media_system` | Brand Commercials | 0–300 | **`pending`** | Media System | Not a percent |
| `mtf_total` | Capex MRO | 95.8 (constant) | `percent_0_100` | MTF Total | |
| `mtf_audit` | Capex MRO | 100 (constant) | `percent_0_100` | MTF Audit | |
| `mtf_leadtime` | Capex MRO | 90–95 | `percent_0_100` | MTF Lead Time | |
| `mtf_tickets` | Capex MRO | 100 (constant) | `percent_0_100` | MTF Tickets | |
| `mtf_audit_div` | Capex MRO | 97–98 | `percent_0_100` | MTF Audit (Div) | |
| `mtf_on_time` | Capex MRO | 87–91 | `percent_0_100` | MTF On-Time | |
| `project_nps` | Capex MRO | 0–96 | `percent_0_100` | Project NPS | Named NPS but never observed negative here |
| `ariba_adherence` | Capex MRO | 0–100 | `percent_0_100` | Ariba Adherence | |
| `eclipse_adherence` | Capex MRO, Directs | 20–100 | `percent_0_100` | Eclipse Adherence | |
| `quality_cars` | Directs | 77.78–100 | `percent_0_100` | Quality (CARs) | |
| `quality_documentation` | Directs | 0–100 | `percent_0_100` | Quality Documentation | |
| `order_acceptance_rate` | Directs | 0–100 | `percent_0_100` | Order Acceptance Rate | |
| `otif` | Directs | 1.1–79.27 | `percent_0_100` | On Time In Full | Never reaches 100 in current data |

---

## Open Items Before Implementation

| Question | Status |
|---|---|
| What Databricks table(s) does SAZ actually provide the data from? | **Resolved** — 5 dedicated per-category tables (see `MAIN_CATEGORY_TO_TABLE`), not one combined table |
| Does SAZ provide KPI-level detail, or only pillar and final score? | **Resolved** — provides all three levels (KPI, pillar, final score) in the same row |
| Is the source one combined table or five separate tables? | **Resolved** — 5 separate tables, one per `main_category`, identical wide schema; all four loaders (`load_supplier`, `load_kpi_input`, `load_pillar_input`, `load_scorecard_input`) iterate over the 5 tables and split columns per target |
| `value_generation` vs `value_generation_formula` — same pillar? | **Resolved** — same Value Creation pillar under two column names, never populated simultaneously; use `COALESCE` |
| SAZ `category` column — separate taxonomy or duplicate? | **Resolved** — genuine sub-grouping within `main_category`; added as new `SUPPLIER.saz_category` column |
| Business names/data dictionary for the ~50 KPI columns | **Not available** — `kpi_name` values will be proposed from column names and marked pending validation |
| Where should the promotion job (`*_INPUT` -> `*_SCORE`) live — `apps/saz_pipeline` or `apps/backend`? | Still open |
| Output format: CSV (matching `apps/backend/data/*.csv` convention) or Delta table? | Still open |

---

## Status

Placeholder files have been created for all four loaders and their entrypoints. No fetch, validation, or write logic has been implemented yet — pending confirmation of the source Databricks table(s) and the open items above.
