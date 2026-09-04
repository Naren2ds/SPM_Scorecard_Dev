# Table Schema — Creation Order and Implementation Details

## Purpose

[Table_Schema.MD](./Table_Schema.MD) defines the *logical* SPM data model (entities, columns, relationships). It does not specify the order in which the physical Delta tables should be created, nor several implementation details a real Databricks build needs (catalog/schema location, primary-key enforcement, partitioning, write strategy). This document fills that gap so the tables can be built in Databricks without re-deriving these decisions each time.

Output persistence decision: **Delta tables in Databricks** (confirmed 2026-09-04).

**Scope note (2026-09-04):** actually creating the Delta tables and wiring `MERGE INTO` writes is deferred — owned by the MLE, not by this pipeline codebase right now. The current deliverable of `apps/saz_pipeline` is the validated Python/pandas output (Pydantic-validated records / DataFrames from each `load_*` function), which the MLE will convert into the physical Delta tables described below. This document remains the reference for the target schema, build order, and physical-implementation decisions once that conversion happens — it is not yet actionable as DDL work in this repo.

---

## Why Configuration Tables Come Before Promotion

The input and score tables have foreign-key relationships back to the configuration tables:

- `KPI_INPUT.kpi_version_id` → `KPI_VERSION`
- `PILLAR_INPUT.pillar_id` / `PILLAR_SCORE.pillar_id` → `PILLAR_DEFINITION`
- `SCORECARD_INPUT.scorecard_id` / `SCORECARD_SCORE.scorecard_id` → `SCORECARD_DEFINITION`

The promotion job (`*_INPUT` → `*_SCORE`) must validate against configuration before it copies data into the shared score tables (e.g. "is `SUSTAINABILITY` a registered pillar for this scorecard?"). Building promotion before configuration exists would mean validating against tables that don't exist yet. This also matches the sequence already described in `Table_Schema.MD`'s [End-to-End Implementation Flow](./Table_Schema.MD#end-to-end-implementation-flow) (Step 1: config → Step 2: supplier → Steps 3-4: inputs → Steps 6B-7B: promotion for `SOURCE_PROVIDED`).

---

## Build Order

| Order | Table | Layer | Row count for SAZ | Blocking? |
|---|---|---|---|---|
| 1 | `SCORECARD_DEFINITION` | Configuration | 1 row | Yes — every other table references `scorecard_id` |
| 2 | `PILLAR_DEFINITION` | Configuration | 4 rows | Yes — `PILLAR_INPUT`/`PILLAR_SCORE` reference `pillar_id` |
| 3 | `KPI_DEFINITION` + `KPI_VERSION` | Configuration | ~45 rows | Yes — `KPI_INPUT`/`KPI_SCORE` reference the KPI catalogue |
| 4 | `PILLAR_APPLICABILITY_RULE`, `KPI_SCOPE` | Configuration | Optional / can defer | No for SAZ — see note below |
| 5 | `SUPPLIER`, `KPI_INPUT`, `PILLAR_INPUT`, `SCORECARD_INPUT` | Input / staging | Already built via Python loaders | Yes — promotion reads these |
| 6 | Promotion job → `KPI_SCORE`, `PILLAR_SCORE`, `SCORECARD_SCORE` | Output / shared | Last | N/A |

**Note on step 4:** `PILLAR_APPLICABILITY_RULE` and `KPI_SCOPE` drive recalculation for `ENGINE_CALCULATED` scorecards. For `SAZ_SPM_CALCULATION` (`SOURCE_PROVIDED`), `Table_Schema.MD` states these are validation/display metadata only and must not be used to recalculate SAZ-provided scores. They can be created empty or deferred without blocking the SAZ pipeline.

**Known gap surfaced by this ordering:** the current `KpiInputRecord` (SAZ loader) stores the raw source column name as `kpi_id` (e.g. `"turnover"`), not a `kpi_version_id`. Once `KPI_DEFINITION`/`KPI_VERSION` exist (step 3), a decision is needed: either map `kpi_id → kpi_version_id` in the loader, or confirm `kpi_id` is an acceptable stand-in key for `SOURCE_PROVIDED` scorecards, since SAZ doesn't version its KPIs the way `ENGINE_CALCULATED` scorecards do.

---

## Step 1 — `SCORECARD_DEFINITION`

One row for SAZ, per `Table_Schema.MD`'s worked example:

| `scorecard_id` | `scorecard_name` | `calculation_mode` | `calculation_frequency` | `scorecard_status` | `effective_from` | `effective_to` |
|---|---|---|---|---|---|---|
| `SAZ_SPM_CALCULATION` | `SAZ Supplier Performance` | `SOURCE_PROVIDED` | `MONTHLY` | `ACTIVE` | `2026-01-01` | `NULL` |

## Step 2 — `PILLAR_DEFINITION`

Four rows, matching what `load_pillar_input` already produces (`pillar_id` values `SUSTAINABILITY`, `OPERATIONAL`, `VALUE_CREATION`, `SERVICE_LEVEL`):

| `pillar_id` | `scorecard_id` | `pillar_name` | `pillar_weight` | `is_active` |
|---|---|---|---|---|
| `SUSTAINABILITY` | `SAZ_SPM_CALCULATION` | Sustainability | *pending business confirmation* | `true` |
| `OPERATIONAL` | `SAZ_SPM_CALCULATION` | Operational | *pending business confirmation* | `true` |
| `VALUE_CREATION` | `SAZ_SPM_CALCULATION` | Value Creation | *pending business confirmation* | `true` |
| `SERVICE_LEVEL` | `SAZ_SPM_CALCULATION` | Service Level | *pending business confirmation* | `true` |

`pillar_weight` is not derivable from the SAZ source data — SAZ provides pre-computed pillar/overall scores directly, so pillar weighting is display/documentation metadata only for this scorecard, not used in a calculation. Needs a value before this table is finalized (even a placeholder, since the column is `NOT NULL` per `Table_Schema.MD`).

## Step 3 — `KPI_DEFINITION` + `KPI_VERSION`

**Status: implemented in `common/configuration.py`** (`KPI_DEFINITIONS`, 48 rows; `KPI_VERSIONS`, 48 rows, one per KPI). Seed data is the KPI unit/name proposal table already built in [SAZ_Pipeline.MD](./SAZ_Pipeline.MD#business-names-and-units--pending-validation).

`KPI_VERSION`'s scoring fields (`max_score`, `scoring_method`, `direction`, `floor_value`, `target_value`) govern `ENGINE_CALCULATED` scoring and are deliberately left unset for every SAZ row, since SAZ never recalculates a per-KPI score (see [SAZ_Pipeline.MD's `input_value` correction](./SAZ_Pipeline.MD)). The table exists so the same model/shape works when another zone's scorecard is `ENGINE_CALCULATED` and actually needs those fields populated. `period_granularity` is set to `MONTHLY` since that is a factual reporting-cadence attribute, not a scoring rule.

Still missing before these rows can be considered fully finalized:

- `pillar_id` per KPI (which of the 4 SAZ pillars each KPI rolls up to) — not yet mapped
- Business confirmation of the proposed `kpi_name`/`input_unit` values themselves — still pending per `SAZ_Pipeline.MD`
- Whether `KPI_INPUT.kpi_id` should be replaced with a real `kpi_version_id` FK, or whether `kpi_id` remains an acceptable stand-in key for `SOURCE_PROVIDED` scorecards (see the "Known gap" note above) — still open

---

## Missing Implementation Details Not Specified in Table_Schema.MD

These are physical-Delta-table decisions the logical schema doc doesn't cover. They should be resolved before writing `CREATE TABLE` DDL.

| Decision | Options | Recommendation / status |
|---|---|---|
| **Catalog/schema location** | Reuse `brewdat_uc_supchn_dev.gld_ghq_procurement_spm` (same as SAZ source tables) vs. a new dedicated schema (e.g. `brewdat_uc_supchn_dev.gld_spm` or similar) | **Open — needs a decision.** Mixing generated SPM tables into the same schema as raw source tables may be confusing; a dedicated schema keeps config/input/output tables separate from raw source feeds. |
| **Primary-key enforcement** | Delta/Unity Catalog supports `CONSTRAINT ... PRIMARY KEY` but it is **NOT ENFORCED** by default (informational only) | Recommend declaring PK/FK constraints for documentation and downstream query-optimizer benefit, but rely on application-level validation (as the Pydantic models already do) for real enforcement. |
| **Partitioning** | Partition large input/output tables (`KPI_INPUT`, `KPI_SCORE`, etc.) by `reporting_period` for query performance vs. no partitioning for small config tables | Recommend partitioning `KPI_INPUT`, `PILLAR_INPUT`, `SCORECARD_INPUT`, `KPI_SCORE`, `PILLAR_SCORE`, `SCORECARD_SCORE` by `reporting_period` (or a derived `year`/`month` column). Configuration tables (`SCORECARD_DEFINITION`, `PILLAR_DEFINITION`, `KPI_DEFINITION`, `KPI_VERSION`) are small — no partitioning needed. |
| **Write strategy (idempotency)** | `INSERT` (append-only, risks duplicates on re-run) vs. `MERGE INTO` (upsert on natural key) vs. `INSERT OVERWRITE` per period (truncate-and-reload a partition) | Recommend `MERGE INTO` keyed on each table's natural ID (`kpi_input_id`, `pillar_input_id`, `scorecard_input_id`, `supplier_id`) so a re-run for the same period is safe and doesn't duplicate rows. This must be implemented in `BaseDatabricksLoader.write()` (not yet built). |
| **Data types for score columns** | `DOUBLE` vs. `DECIMAL(p,s)` | Recommend `DECIMAL` with explicit precision/scale (e.g. `DECIMAL(10,2)`) for score/percentage columns to avoid floating-point drift in aggregation and reporting, matching the `DECIMAL` types already specified in the ERD. |
| **Environment** | Dev vs. prod catalog | Build and validate in the dev catalog (`brewdat_uc_supchn_dev`, matching the existing SAZ source tables) before promoting to a prod catalog. |
| **Access control** | Who/what can read and write each table | Not yet defined — needs input from the Databricks workspace admin/data governance owner. |

---

## Status

- Output persistence confirmed: Delta tables (target format, built later).
- Build order confirmed: configuration (steps 1-3, optionally 4) before input (step 5, loaders already built) before promotion/output (step 6).
- Catalog/schema location, write strategy (`MERGE` vs `INSERT`), and partitioning are open decisions for whoever builds the physical tables — not yet resolved.
- **Physical Delta table creation is deferred to the MLE.** `apps/saz_pipeline`'s current scope ends at producing validated Python/pandas output (the four `load_*` functions); it does not create or write to Delta tables. Steps 1-3 (config tables) are documented here as the target schema/seed data for that later conversion, not as pending work in this codebase.
