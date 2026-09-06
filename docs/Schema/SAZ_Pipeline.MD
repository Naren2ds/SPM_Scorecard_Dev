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
        +-- load_supplier_spend/    --> writes into SUPPLIER_SPEND
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
        (1:1 copy at source grain, tagged calculation_source = SOURCE_PROVIDED; no aggregation)
        |
        v
Backend API (/api/spm/overview, /api/spm/scorecard-grid, etc.)
        filtered by scorecard_id = SAZ_SPM_CALCULATION
        aggregates to the requested grouping level at query time
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
| `load_supplier/` | `SupplierRecord` | `SUPPLIER` | Supplier identity, zone, and category attributes |
| `load_supplier_spend/` | `SupplierSpendRecord` | `SUPPLIER_SPEND` | `spend_amount` per supplier x sub-category x period |
| `load_kpi_input/` | `KpiInputRecord` | `KPI_INPUT` | `input_value` (raw measurement per supplier x KPI x period), plus `applicability_status`. SAZ never populates `source_kpi_score` — it does not pre-compute per-KPI scores. |
| `load_pillar_input/` | `PillarInputRecord` | `PILLAR_INPUT` | `source_pillar_score_pct` per supplier x pillar x period |
| `load_scorecard_input/` | `ScorecardInputRecord` | `SCORECARD_INPUT` | `source_normalized_score`, `source_coverage_adjusted_score`, `source_score_band` per supplier x period |

Every fact record carries the full dimension set so the API can aggregate at any level without re-joining `SUPPLIER`:

```text
supplier_id + parent_supplier_id + zone + country
+ gpo_category + purchasing_category + scorecard_category + sub_category
+ reporting_period
```

---

## Scaffolding

```text
apps/saz_pipeline/
    src/data_pipeline/saz/
        common/
            base_loader.py      <- shared Databricks fetch + Pydantic validation
            constants.py        <- source tables, per-category KPI/pillar column maps
            configuration.py    <- SCORECARD/PILLAR/KPI definitions + KPI-to-pillar mapping
            source_utils.py     <- shared row parsing (period, numeric, supplier key)
            integrity_checks.py <- FK checks against configuration before promotion
        load_supplier/          <- models.py, load_supplier.py, main.py
        load_supplier_spend/    <- models.py, load_supplier_spend.py, main.py
        load_kpi_input/         <- models.py, load_kpi_input.py, main.py
        load_pillar_input/      <- models.py, load_pillar_input.py, main.py
        load_scorecard_input/   <- models.py, load_scorecard_input.py, main.py
    Mapping/                    <- business KPI-to-pillar mapping (source of truth)
    requirements.txt
```

Each `main.py` is the callable entrypoint invoked by a Databricks Job/Workflow task. It calls into its sibling `load_<table_name>.py` for the actual fetch/validate logic, keeping orchestration separate from transformation.

`BaseDatabricksLoader` handles the repeated Databricks connect → fetch → validate flow, so each loader only supplies its source table and Pydantic model:

```text
BaseDatabricksLoader
    .fetch_raw(table_name) -> DataFrame
    .validate(df, transform) -> (valid_records, rejected_rows)
```

There is no `.write()`. Persistence to Delta is owned by the MLE — see [Table_Schema_Steps_creation.MD](./Table_Schema_Steps_creation.MD). Each loader returns validated records; the temporary `export_*_csv.py` scripts write them to `data/*.csv` for review only.

`validate()` returns rejected rows rather than raising, so one bad row never aborts a batch. It also normalizes pandas `NaN` back to `None` before validation, because a column mixing values with `None` becomes `float64` on `to_dict()` and would otherwise fail optional-field validation.

---

## Validation Rules

Rows failing Pydantic validation are logged and excluded, not silently dropped. A rejected-rows report is produced per run so data-quality issues are visible before they reach the input tables.

| Rule | Applies to |
|---|---|
| Required fields present and correctly typed | All five models |
| `applicability_status` restricted to `Applicable` / `Not Applicable` | `KpiInputRecord` |
| `reporting_period` is a valid first-of-month date | All five models |
| No duplicate primary key per batch | All five models |

Each fact table's primary key embeds `main_category`, the supplier key, `subcategory`, and the period — for example `kpi_input_id` is `main_category`-`supplier_id`-`kpi_id`-`subcategory`-`reporting_period`. An exact repeat is therefore a genuine source duplicate, not a distinct measurement.

**Numeric values are deliberately unconstrained.** Early versions rejected negatives, which discarded valid data: `nps` is a real −100..100 index and legitimately went to −8. Scores are stored on their native source scale with no range assumption.

**Why `subcategory` is part of every key:** the same vendor can have multiple source rows for the same month, one per product line (e.g. WESTROCK: `FOLDING CARTONS` vs `CORRUGATED BOARD`), with genuinely different results — 776 vs 579 in April 2026. Deduplicating without `subcategory` would silently discard one.

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

`main_category` determines which pillar/KPI columns are populated for a row. SAZ's three levels map onto the generic category fields — no zone gets its own category column:

| SAZ source | Generic field | Example |
|---|---|---|
| `main_category` | `gpo_category` **and** `scorecard_category` | `Directs` |
| `category` | `purchasing_category` | `PACKAGING` |
| `subcategory` | `sub_category` | `FOLDING CARTONS` |

`main_category` is written to both `gpo_category` and `scorecard_category` deliberately: `PILLAR_APPLICABILITY_RULE` evaluates `scorecard_category`, so dropping it would break the BST Sustainability exclusion.

Confirmed by full-table inspection: 30 distinct `(main_category, category, subcategory)` combinations. Note level 1 and level 2 are identical for `BST`; the hierarchy only visibly branches for `Capex MRO` (`CAPEX` / `COMM CAPEX`) and `Directs` (`PACKAGING` / `RAU`).

### `SUPPLIER` Mapping

| Source column | Target column | Notes |
|---|---|---|
| `parent_company` | `supplier_id`, `parent_supplier_id`, `parent_supplier_name` | SAZ has no vendor-level identity, so all three are the same normalized value; `vendor_name` is `"NA"` |
| `main_category` | `gpo_category`, `scorecard_category` | `scorecard_category` drives pillar applicability |
| `category` | `purchasing_category` | |
| `subcategory` | `sub_category` | |
| `total_spend` | `SUPPLIER_SPEND.spend_amount` | Separate table; see [Table_Schema.MD](./Table_Schema.MD) |
| `year` + `month` | `reporting_period` (all fact tables) | Combine into first-of-month date, e.g. `2026` + `July` -> `2026-07-01` |
| `source_file` | `source_reference` (all fact tables) | Lineage, e.g. `july_2026_main_category_bst.xlsx` |
| *(none)* | `country` | SAZ source has no country column — always `NULL` |
| *(constant)* | `zone` | Always `"SAZ"` |

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
| Operational | `op` | Brand Commercials |
| Value Creation | `COALESCE(value_generation, value_generation_formula)` | `value_generation` for Brand Act Commercial/Brand Commercials/Capex MRO/Directs; `value_generation_formula` for BST — **confirmed to be the same pillar under two column names, never populated simultaneously** |
| Service Level | `ns` | BST, Brand Act Commercial, Brand Commercials |
| Service Level | `service_level_indirects` | Capex MRO |
| Service Level | `service_level_directs` | Directs |

**`ns` and `op` are pillar scores, not KPIs.** Both were initially mis-classified as KPI columns. Two pieces of evidence corrected this: they sit on the same 0–1000 scale as the other pillar fields (individual KPIs are mostly 0–100), and the categories that populate `ns` are exactly those with no `service_level_*` column. Both have been removed from `MAIN_CATEGORY_TO_KPI_COLUMNS`, `KPI_DEFINITION`, and `KPI_VERSION`.

### `KPI_INPUT.input_value` — confirmed populated columns per `main_category` (full-table check, 2,084 rows)

| main_category | Populated KPI columns |
|---|---|
| `BST` | `acceptance_term`, `cost`, `cash_flow`, `engagement`, `price`, `upload_nf`, `turnover`, `absenteeism`, `satisfaction`, `gps`, `bees_tasks`, `sla_vacancies`, `blank_route`, `invoice_compliance_po_not_found`, `deloitte_compliance`, plus rare (`turnover_perception`: 18 rows, `contract_compliance_tech`: 4 rows, `quality_tech`: 18 rows) |
| `Brand Act Commercial` | `acceptance_term`, `cost`, `cash_flow`, `engagement`, `invoice_compliance`, `price`, `upload_nf`, `ontime_production`, `recall`, `recall_ontime`, `quality_recall_ontime_recall`, `docs_nok_media_system`, `events_audit`, plus rare (`contract_compliance`: 3 rows) |
| `Brand Commercials` | `nps`, `media_tools`, `cac`, `cpo`, `ratio_prod`, `extra_cost`, `cost`, `media_system`, `acceptance_term`, `cash_flow`, `engagement` |
| `Capex MRO` | `acceptance_term`, `cost`, `cash_flow`, `engagement`, `mtf_total`, `mtf_audit`, `mtf_leadtime`, `mtf_tickets`, `mtf_audit_div`, `mtf_on_time`, `project_nps`, `ariba_adherence`, `invoice_compliance`, `price`, `upload_nf`, `eclipse_adherence` |
| `Directs` | `acceptance_term`, `cost`, `cash_flow`, `engagement`, `price`, `eclipse_adherence`, `invoice_compliance_po_not_found`, `quality_cars`, `quality_documentation`, `order_acceptance_rate`, `otif` |

`ns` and `op` were removed from these lists — see the pillar note above. This leaves **46 distinct KPI IDs** across 70 category-specific combinations.

Each `KPI_INPUT` row carries both `kpi_id` (readable source column name) and `kpi_version_id` (FK to `KPI_VERSION`, resolved via `KPI_VERSION_ID_BY_KPI_ID` in `configuration.py`). The version pins which scoring rules were in force; SAZ has exactly one version per KPI today, so a zone that re-versions rules must resolve by `reporting_period` against `effective_from`/`effective_to` instead.

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
| `ns` | *(not a KPI)* | 0–1000 | — | — | **Reclassified as the Service Level pillar score** for BST / Brand Act Commercial / Brand Commercials |
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
| `op` | *(not a KPI)* | 0–100,000 | — | — | **Reclassified as the Operational pillar score** for Brand Commercials |
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

## Resolved Decisions

| Question | Resolution |
|---|---|
| Which Databricks tables does SAZ provide? | 5 dedicated per-category tables (see `MAIN_CATEGORY_TO_TABLE`), not one combined table |
| Does SAZ provide KPI-level detail, or only pillar and final score? | All three levels in the same row |
| `value_generation` vs `value_generation_formula` | Same Value Creation pillar under two names, never populated simultaneously; use `COALESCE` |
| SAZ `category` column | Maps to the generic `purchasing_category`; the zone-exclusive `saz_category` column was removed |
| `ns` and `op` | **Pillar scores, not KPIs** \u2014 Service Level and Operational respectively |
| Supplier identity | SAZ has only `parent_company`; `supplier_id` = `parent_supplier_id` = normalized parent name, `vendor_name` = `"NA"` |
| Is `sub_category` part of the score grain? | Yes \u2014 the same vendor has genuinely different scores per product line |
| Are `zone` / `country` part of the grain? | Yes. In multi-zone data 131 of 2,505 parent suppliers span >1 country and 62 span >1 zone (`ARDAGH GROUP`: 14 countries, 4 zones). SAZ writes `zone = "SAZ"`, `country = NULL` |
| Output persistence | Delta tables, built by the MLE. This pipeline returns validated records; `export_*_csv.py` is review-only |
| Aggregation rule | **Simple average for now**, pending business confirmation. `SUPPLIER_SPEND` exists so switching to spend-weighted is a one-function change |
| Score scale | SAZ stays on its native **0\u20131000** scale, unrescaled |

---

## Open Items

| Item | Status |
|---|---|
| Business names / units for the 46 KPI columns | **Pending** \u2014 proposed values in the table above are not authoritative |
| Pillar weights | **Pending** \u2014 currently a 25.0 equal-split placeholder. Unused by SAZ (scores are supplied), but required before any engine-calculated zone |
| Spend-weighted aggregation | **Pending business confirmation.** Materially different: WESTROCK April 2026 is 776 (folding cartons, 72% of spend) vs 579 (corrugated board). Simple average gives 677.5; spend-weighted gives ~721 |
| `score_scale` on `SCORECARD_DEFINITION` | **Not yet added.** Without it the frontend cannot know SAZ is 0\u20131000 and will render 776 on a 0\u2013100 gauge |
| Promotion job location | Open \u2014 `apps/saz_pipeline` or `apps/backend` |
| `KPI_INPUT.loaded_at` | In the schema, not in the model; add when the Delta tables are built |
| `SUPPLIER.company_code`, `country`, `vendor_account_number` | In the schema, absent from the SAZ source; another zone's loader will need them |

---

## Status

All five loaders are implemented and validated against live Databricks data.

| Table | Records | Rejected |
|---|---:|---:|
| `SUPPLIER` | 296 | 1,788 (duplicate parent rows, expected) |
| `SUPPLIER_SPEND` | 2,084 | 0 |
| `KPI_INPUT` | 12,190 | 0 |
| `PILLAR_INPUT` | 5,899 | 0 |
| `SCORECARD_INPUT` | 2,083 | 0 |

Configuration (`SCORECARD_DEFINITION`, `PILLAR_DEFINITION`, `PILLAR_APPLICABILITY_RULE`, `KPI_DEFINITION`, `KPI_VERSION`) is complete, with all 46 KPIs mapped to a pillar. `check_integrity.py` passes: no orphan suppliers, no unknown KPI/pillar/scorecard IDs.

**Next step:** the promotion job \u2014 a 1:1 copy from `PILLAR_INPUT` \u2192 `PILLAR_SCORE` and `SCORECARD_INPUT` \u2192 `SCORECARD_SCORE` at source grain, tagged `calculation_source = SOURCE_PROVIDED`. No `KPI_SCORE` rows are promoted for SAZ, because SAZ supplies raw KPI measurements rather than per-KPI scores.

Temporary review artifacts to delete once validation is complete: `export_*_csv.py`, `check_integrity.py`, `smoke_test_models.py`, and `data/*.csv` (gitignored).
