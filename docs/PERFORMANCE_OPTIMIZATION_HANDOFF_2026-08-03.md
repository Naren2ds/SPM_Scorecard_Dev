# Scorecard Performance Optimization Handoff

Date: 2026-08-03  
Repository: `SPM_Scorecard_Dev`  
Current branch: `enable-databricks-refresh`  
Current commit: `05679d9 Add internal Databricks scorecard refresh workflow`

## Purpose

This document records the current project state and the agreed direction for improving Scorecard performance. It is intended as the starting point for the next working session.

No `.env` values, Databricks credentials, SQL connection strings, or other secrets are included here.

## Work Completed Before the Performance Review

- The new automated tests and documentation were promoted from the `deployment` branch without directly changing the production-like `new-deployment` branch.
- A dedicated promotion branch was used to avoid putting unfinished work directly into production.
- Cherry-pick conflicts were resolved, including the modify/delete conflict involving `apps/backend/tests/validate_scorecard.py`.
- The duplicate validation-script concern was reviewed, with `test_validate_scorecard.py` retained as the pytest integration test.
- The internal Databricks refresh workflow was restored on a separate branch.
- Databricks refresh remains an internal backend/developer workflow and is not exposed to end users in the frontend.
- The refresh workflow and associated backend changes are in commit `05679d9` on `enable-databricks-refresh`.

## Test Status

The main backend test run reported:

```text
50 passed
1 failed
```

The failure was:

```text
apps/backend/tests/test_validate_scorecard.py::test_all_scorecard_calculations_pass
```

Interpretation:

- The 50 passing tests are primarily unit-level calculation tests.
- `test_all_scorecard_calculations_pass` is the broad scorecard integration/validation test.
- All 332,632 KPI-level validation checks passed.
- One parent-level normalized score differed by `0.01`: application result `9.67` versus independently calculated result `9.68`.
- Therefore, the remaining failure is a rounding/aggregation reconciliation issue, not evidence that the complete calculation pipeline is broken.
- This calculation discrepancy is separate from the current latency problem.

## Phase 1: Business Population Validation

Phase 1 is confirmed.

The refreshed dataset intentionally contains approximately 29,000 parent suppliers. The current normalized scorecard population is approximately:

```text
29,359 parents
```

Selected before-and-after refresh observations:

| Dataset | Previous rows | Previous parents | Refreshed rows | Refreshed parents |
|---|---:|---:|---:|---:|
| DOT | 29,967 | 2,655 | 201,225 | 27,103 |
| IOT | 25,331 | 2,523 | 206,620 | 27,103 |
| Price divergence | 31,136 | 2,220 | 175,874 | 24,786 |

The year filters still leave approximately 27,000 parents, so the increase is not explained by accidentally loading old years.

Conclusion:

- The 29K population is a valid business requirement.
- The optimization must support this population rather than filtering it back to approximately 3K.
- The main problem is how much data is calculated, transferred, stored, searched, and rendered for a normal page interaction.

## Complete Five-Phase Roadmap

The complete performance proposal is divided into five phases. Each phase has a separate purpose so that calculation correctness, UI performance, data refresh, and production safety are not changed simultaneously.

| Phase | Objective | Main outcome | Business calculation changes? |
|---|---|---|---|
| 1. Validate the business problem | Confirm that the increased data volume is legitimate | 29K parents accepted as the target population | No |
| 2. Optimize the Normalized Scorecard | Stop sending complete details for all parents to the browser | Summary, paginated leaderboard, search, one-parent detail, and on-demand export | No |
| 3. Optimize Individual KPI pages | Stop loading and recalculating complete raw KPI datasets in every browser | Backend filtering, pagination, precomputed rollups, and detail-on-demand | No |
| 4. Optimize refresh, storage, and caching | Produce fast, validated, immutable read datasets after Databricks refresh | Atomic snapshot refresh and precomputed scorecard/KPI views | No initially |
| 5. Validate, measure, and roll out safely | Prove correctness and latency improvements before promotion | Baselines, regression tests, performance targets, observability, and controlled deployment | No |

The recommended sequence is important:

```text
Validate population
        |
        v
Fix the largest UI/API bottleneck in Normalized Scorecard
        |
        v
Apply the same data-delivery model to Individual KPI pages
        |
        v
Make Databricks refresh produce optimized immutable snapshots
        |
        v
Measure, validate, and promote through a controlled release
```

Phase 1 is complete. Phase 2 is the next proposed implementation. Phase 3 should begin only after Phase 2 behavior and performance have been confirmed.

## Current Normalized Scorecard Flow

The current high-level flow is:

```text
Open Normalized Scorecard page
        |
        +--> Fetch filter options, including the full parent list
        |
        +--> Fetch /api/scorecard without a top_n limit
                    |
                    +--> Return approximately 29K parent scorecards
                    +--> Return four pillar objects per parent
                    +--> Return approximately 15 KPI objects per parent
        |
        +--> Store the complete response in React state
        +--> Calculate page summaries in the browser
        +--> Search the complete parent array in the browser
        +--> Render thousands of parent <option> elements
        +--> Find the selected parent by scanning the complete array
```

At the current population, the full response can represent approximately:

```text
29,359 parent objects
117,436 pillar objects
440,000+ nested KPI objects
```

HTTP GZip reduces network bytes, but the browser must still decompress the payload, parse the complete JSON document, allocate all JavaScript objects, store them in memory, search them, and render the selection controls.

## What the Current Response Contains

The main `ScorecardResponse` currently includes:

- `pillar_weights`
- `total_expected_kpi_weight`
- Complete KPI configuration metadata
- `scorecards`, containing every returned parent
- Applied zone, category, and parent filters

Each parent scorecard includes:

- `parentSupplier`
- `normalized_score`
- `coverage_pct`
- `coverage_adjusted_score`
- `applicable_pillar_weight`
- `total_earned`
- `total_applicable_max`
- `invoice_value`
- `band`
- Complete pillar details

Each pillar includes:

- Pillar name
- Pillar weight
- Earned points
- Applicable maximum points
- Pillar percentage
- Weighted contribution
- Status
- Complete KPI breakdown

Each KPI includes:

- KPI ID and name
- Maximum score
- Raw value
- Attainment
- Percentile
- Earned score
- Applicability
- Floor used
- Target used

## What the Initial Page Should Not Contain

The initial leaderboard/page response should not contain:

- Detailed KPI objects for all 29K parents
- Raw KPI values for all parents
- KPI attainment and percentile for all parents
- KPI floor and target values repeated for every parent
- KPI applicability flags for every parent
- Full nested pillar calculations for every parent
- All 29K parent names rendered in one HTML `<select>`
- Complete export data loaded before the user requests an export
- Complete KPI configuration before a parent detail is opened

These details should not be deleted from the application. They should be moved to selected-parent detail and export responses, where they are actually needed.

## Phase 2: Proposed Normalized Scorecard Architecture

Phase 2 changes data delivery and frontend rendering. It should not change the scorecard formula, KPI calculations, normalized score, coverage rules, band rules, or applicability behavior.

The proposed flow is:

```text
Open page
        |
        +--> Fetch small summary response
        +--> Fetch first 100 compact leaderboard rows
        |
        +--> Render the page immediately

Search or select a parent
        |
        +--> Fetch the complete detail for one parent
        +--> Render pillars, KPIs, and override controls

Request export
        |
        +--> Backend generates or streams the full CSV on demand
```

### 1. Summary Endpoint

Proposed endpoint:

```http
GET /api/scorecard/summary
```

It should return only:

- Total parent count
- Filtered parent count
- Average normalized score
- Average coverage percentage
- Green, Amber, and Red counts
- Scorecard cache/data refresh timestamp

It should not return individual parents, pillars, KPIs, or the parent search list.

### 2. Paginated Leaderboard Endpoint

The existing `/api/scorecard/leaderboard` endpoint already removes nested KPI lists. It should be extended rather than replaced.

Proposed request:

```http
GET /api/scorecard/leaderboard?page=1&page_size=100&sort=normalized_score&order=desc
```

Each compact row should contain only the fields required by the visible leaderboard:

- Parent supplier name
- Normalized score
- Coverage percentage
- Coverage-adjusted score, if displayed
- Invoice value, if displayed
- Band
- Optional compact percentages for the four pillars, if displayed

It should not include raw KPI values, attainment, percentile, KPI earned scores, floors, targets, applicability, or full KPI metadata.

Recommended defaults:

```text
Default page size: 100
Maximum page size: 200
Default sort: normalized score descending
```

The response should also include:

- Current page
- Page size
- Total matching parents
- Total pages
- Applied search, sort, and filters
- Cache/data refresh timestamp

Pagination must occur before JSON serialization.

### 3. Selected-Parent Detail Endpoint

The project already has a suitable endpoint:

```http
GET /api/scorecard/parent?name=<parent-name>
```

This endpoint should return the complete scorecard for only the selected parent:

- Parent summary fields
- All four pillar calculations
- Complete KPI breakdown
- Raw values
- Attainment
- Percentile
- Earned score
- Applicability
- Floor and target values
- KPI configuration required for the applicability override panel

This preserves the existing client-side applicability override feature while reducing the normal detail payload to approximately 15 KPI objects.

### 4. Parent Search Endpoint

Proposed endpoint:

```http
GET /api/scorecard/parents/search?q=<search-text>&limit=30
```

Recommended behavior:

- Begin searching after two characters.
- Debounce frontend requests by approximately 250 milliseconds.
- Return no more than 30 compact parent identities.
- Load scorecard detail only after a result is selected.
- Do not preload or render all 29K names.

For the POC, the exact parent name can remain the lookup identifier. A stable parent supplier ID would be safer in a product version.

### 5. Export Endpoint

Proposed endpoint:

```http
GET /api/scorecard/export
```

The backend should generate or stream the complete CSV only when Export is requested. The export can continue to contain all matching parents, KPI scores, maximum scores, pillar percentages, coverage, normalized score, band, and applied filters.

The normal page should not download all detailed parent records merely to make a future export possible.

## Proposed Backend Cache

For the POC, the full scorecard may continue to be calculated once after refresh. The backend should then derive optimized read models:

```text
Full scorecard calculation
        |
        +--> Precomputed summary object
        +--> Compact sorted leaderboard rows
        +--> Full detail indexed by parent
        +--> Parent search index
        +--> Precomputed filter options
```

Recommended structures:

```python
scorecard_summary = {...}

leaderboard_rows = [
    {
        "parentSupplier": "Supplier A",
        "normalized_score": 9.42,
        "coverage_pct": 93.5,
        "band": "Green",
    }
]

scorecard_by_parent = {
    "Supplier A": {...full parent detail...},
    "Supplier B": {...full parent detail...},
}
```

`scorecard_by_parent` provides direct lookup instead of scanning the complete parent list for every selection.

For zone/category combinations, the backend should preserve the current recalculation behavior and cache repeated contexts using a normalized key such as:

```text
zones=EU|categories=Packaging
```

## Proposed Frontend State

The frontend should replace the single massive scorecard response state with separate state objects:

- Summary
- Current leaderboard page
- Selected parent detail
- Parent search results
- Active filters
- Independent loading and error states

The initial page should load summary plus one compact leaderboard page. The detailed parent response should be fetched only when a parent is selected.

Applicability overrides can continue to run immediately in the browser, but only against the selected parent's KPI list.

## Existing Versus Proposed

| Area | Existing | Proposed |
|---|---|---|
| Initial response | All 29K detailed parents | Summary plus 100 compact parents |
| Parent selection | All names loaded and rendered | Backend autocomplete, maximum 30 results |
| Parent details | Included for every parent | Loaded for one selected parent |
| KPI details | Approximately 440K nested objects | Approximately 15 for the selected parent |
| Summary cards | Calculated in the browser | Precomputed by the backend |
| Pagination | None | Backend pagination |
| Search | Browser scans the full array | Backend indexed search |
| Parent lookup | Array scan | Dictionary lookup |
| Export | Depends on the complete frontend dataset | Separate on-demand backend export |
| Applicability overrides | Client-side | Preserved for selected parent |
| Scorecard formulas | Existing rules | Unchanged |

## Recommended Phase 2 Implementation Order

1. Extend `/api/scorecard/leaderboard` with pagination, sorting, and backend search.
2. Add `/api/scorecard/summary`.
3. Add or confirm `scorecard_by_parent` direct lookup for `/api/scorecard/parent`.
4. Replace the 29K-option frontend selector with backend autocomplete.
5. Change initial page loading to summary plus leaderboard rather than `/api/scorecard`.
6. Move complete CSV generation to `/api/scorecard/export`.
7. Preserve and verify zone/category filtering.
8. Add API and frontend tests for pagination, search, selection, and loading states.
9. Compare normalized scores, coverage, bands, pillar scores, and applicability overrides before and after the change.
10. Measure payload size, backend response time, browser rendering time, and parent-selection latency.

## Phase 2 Acceptance Criteria

Phase 2 should be considered successful when:

- The initial page does not call the full `/api/scorecard` response.
- The initial leaderboard returns at most the requested page size.
- No HTML control renders all 29K parent names.
- Selecting a parent requests only that parent's complete detail.
- Search returns a small backend-filtered result set.
- CSV export still provides the required complete output.
- Existing scorecard business results remain unchanged.
- The remaining `0.01` validation discrepancy is tracked separately and is not hidden by the performance change.
- Performance measurements show a material improvement at the validated 29K-parent population.

## Decisions to Confirm Before Implementation

The current recommendation is to proceed with these assumptions:

- Preserve the applicability override feature.
- Preserve full CSV export, but move it to a server endpoint.
- Use 100 rows as the default leaderboard page size.
- Use normalized score descending as the default sort.
- Use parent name as the POC identifier.
- Preserve zone/category recalculation behavior.
- Do not change scorecard calculation formulas during Phase 2.

## Phase 3: Optimize Individual KPI Pages

### Objective

Optimize the individual KPI pages after the Normalized Scorecard flow has been corrected. Examples include DOT, IOT, Price Divergence, Invoice Conformity, Supplier Assessment, Supplier Compliance, Supplier Maturity, Eclipse, and CO2 Emission.

The individual KPI pages currently perform substantial data work in the browser. The general pattern is:

```text
Open one KPI page
        |
        +--> Fetch the complete KPI dataset
        +--> Store all raw rows in React state
        +--> Build all filter-option lists in the browser
        +--> Filter all rows in the browser
        +--> Rank and calculate percentiles in the browser
        +--> Calculate supplier, parent, zone, or category rollups
        +--> Render a limited number of rows while retaining all rows in memory
```

This model worked for a few thousand rows, but refreshed datasets now contain approximately 175K to 206K rows for some KPIs. Rendering only the first 200 table rows does not solve the main problem because the browser still downloads and processes the complete dataset.

### Current Individual KPI Data

Depending on the KPI, the browser can receive and process fields such as:

- Supplier and parent supplier
- Zone, country, category, and year
- KPI applicability
- Raw numerator and denominator fields
- Precomputed KPI value
- Status or classification fields
- Supplier-level score
- Rank and percentile
- Attainment and earned score
- Parent, zone, and category rollups

Not all of this information is needed during initial page load.

### Proposed Individual KPI Flow

```text
Open KPI page
        |
        +--> Fetch KPI summary
        +--> Fetch filter metadata
        +--> Fetch first page of compact result rows
        |
        +--> Render immediately

Change filters or search
        |
        +--> Backend applies filters and returns one page

Select a supplier or parent
        |
        +--> Fetch detailed raw calculation inputs on demand

Request export
        |
        +--> Backend streams the complete filtered export
```

### Proposed KPI Endpoints

The exact endpoint names can follow the existing project conventions, but each KPI should expose equivalent contracts:

```http
GET /api/<kpi>/summary
GET /api/<kpi>/results?page=1&page_size=100&search=...
GET /api/<kpi>/detail?id=...
GET /api/<kpi>/filters
GET /api/<kpi>/export
```

The initial KPI results endpoint should return only visible columns. Raw source fields and detailed formula inputs should be returned by the detail endpoint only when the user asks to inspect one result.

### Ranking and Percentile Requirement

Rank and percentile must still be calculated against the correct full comparison cohort, not merely the current page of 100 rows.

Correct sequence:

```text
Apply business cohort filters
        |
        +--> Calculate rank and percentile over the full filtered cohort
        |
        +--> Sort the complete result logically
        |
        +--> Return only the requested page
```

Incorrect sequence:

```text
Take first 100 rows
        |
        +--> Calculate percentile within those 100 rows
```

The second sequence would improve speed but change business results, so it must not be used.

### Shared Backend Calculation Layer

The backend scorecard and individual KPI pages should call the same KPI calculation functions and use the same configuration. This prevents divergence in:

- Floor and target
- Maximum score
- Direction of improvement
- Applicability behavior
- Parent fallback naming
- Cohort definition
- Rank and percentile
- Aggregation method
- Rounding

The frontend should display calculation results and support controlled POC inputs, but it should not become a second independent implementation of the same scoring rules.

### Phase 3 POC Scope

For the POC, optimize one high-volume KPI first, preferably DOT or IOT. Use it as the reference implementation before converting all KPI pages.

Recommended order:

1. Capture the current KPI response size and page-load timing.
2. Define summary, paginated result, detail, filter, and export contracts.
3. Move filtering, ranking, percentile, and rollups to reusable backend functions.
4. Add server-side pagination and search.
5. Keep only one result page and one selected detail in frontend state.
6. Compare every score and rollup against the current implementation.
7. Measure the improvement.
8. Apply the proven pattern to the remaining KPI pages.

### Phase 3 Acceptance Criteria

- A KPI page does not download its complete 175K to 206K row dataset during normal page load.
- Rank and percentile remain based on the complete correct cohort.
- Parent, zone, and category rollups match the existing calculation.
- Filtering and search happen before pagination.
- The browser stores only the visible page, summary, filter metadata, and selected detail.
- Export remains available through a dedicated backend response.
- Results match both the previous individual KPI pages and the Normalized Scorecard.

## Phase 4: Optimize Refresh, Storage, and Caching

### Objective

Make the internal Databricks refresh produce a complete, validated, optimized data snapshot that the application can serve quickly. Users should never wait for Databricks queries or full scorecard reconstruction during a normal page request.

### Current POC Refresh Concern

The current workflow refreshes CSV files from Databricks and the backend loads those files into memory. CSV is simple and appropriate for a POC, but the application now has approximately 597K raw rows across the larger datasets and approximately 66 MB of CSV data.

Potential problems as volume grows include:

- Parsing all CSV files during startup
- Storing the same values repeatedly as Python dictionaries
- Rebuilding scorecard structures after every process restart
- Serving requests while a refresh is partially complete
- A failed refresh leaving a mixture of old and new files
- Recomputing the same filtered scorecard contexts repeatedly
- No explicit snapshot identifier connecting raw data, scorecard output, and validation report

### Proposed Refresh Architecture

The internal refresh should become a controlled pipeline:

```text
Internal refresh command or scheduled job
        |
        +--> Query Databricks using backend-only credentials
        +--> Write files into a temporary snapshot directory
        +--> Validate schema and required columns
        +--> Validate row counts and parent counts
        +--> Calculate KPI-level derived datasets
        +--> Calculate Normalized Scorecard read models
        +--> Run scorecard reconciliation tests
        +--> Publish the snapshot atomically only if validation succeeds
        +--> Warm the application cache or restart/reload safely
```

End users should not receive Databricks credentials and should not see a refresh button in the frontend.

### Snapshot Layout

For the POC, CSV can remain the source format, but each successful refresh should behave like an immutable snapshot. A possible layout is:

```text
apps/backend/data/snapshots/
    2026-08-03T143000Z/
        raw/
        derived/
        scorecard/
        validation/
        manifest.json
    current.json
```

The manifest should record non-secret operational metadata:

- Snapshot ID
- Refresh start and completion time
- Source/query version
- Row count by dataset
- Parent count by dataset
- Output file checksums or sizes
- Validation status
- Application/schema version

`current.json` should point to the last validated snapshot. Publishing a new snapshot should be an atomic pointer change rather than overwriting live files one by one.

### Storage Recommendation

POC recommendation:

- Keep the workflow simple.
- Retain CSV if it minimizes immediate code changes.
- Add immutable snapshots and manifests first.
- Precompute compact JSON/CSV read models for summary and leaderboard endpoints.

If CSV parsing or memory remains a bottleneck after Phases 2 and 3, evaluate a local analytical format:

- Parquet for compact columnar storage and faster analytical reads
- DuckDB for filtered analytical queries over Parquet or CSV
- SQLite for indexed lookup and straightforward pagination

This storage change should be based on measurements. It is not required merely because the dataset has grown.

### Cache Strategy

The application cache should separate:

- Raw KPI rows
- Derived KPI result rows
- Compact leaderboard rows
- Full detail indexed by parent or supplier
- Summary statistics
- Filter metadata
- Reused zone/category calculation contexts

Every cache entry should be associated with a snapshot ID. After publishing a new snapshot, old cache entries should not be mixed with new data.

### Failure Behavior

If refresh or validation fails:

- Keep serving the last successful snapshot.
- Do not publish partially generated files.
- Record the failure in refresh logs and the validation report.
- Return a non-zero command exit status for automation.
- Never expose connection strings or credentials in logs.

### Phase 4 Acceptance Criteria

- Normal user requests never connect directly to Databricks.
- Databricks credentials remain only in backend environment configuration.
- A refresh either publishes a complete validated snapshot or publishes nothing.
- The last successful snapshot remains available after a failed refresh.
- Summary, leaderboard, search, and detail caches all identify the same snapshot.
- Refresh duration, row counts, parent counts, validation results, and snapshot ID are recorded.
- Application startup and cache warm-up times are measured and acceptable.

## Phase 5: Validate, Measure, and Roll Out Safely

### Objective

Prove that the optimized system is faster without changing business results, then promote it without directly modifying the current production branch.

### Establish a Baseline

Before changing each flow, record:

- Raw dataset row counts
- Parent and supplier counts
- API response time
- API payload size before and after GZip
- Backend calculation time
- JSON serialization time
- Browser download and JSON parse time
- React render time
- Time until the page is usable
- Time to search and select a parent
- Memory used by the browser and backend

Measurements should use the validated approximately 29K-parent snapshot, not a reduced development sample.

### Correctness Validation

Performance changes must pass layered validation:

- Unit tests for scoring formulas
- API contract tests for pagination, filtering, sorting, and search
- Integration reconciliation against the independent scorecard validation
- Comparison of old and new outputs for every parent and KPI
- Tests for zone/category cohort behavior
- Tests for missing values, applicability, ties, single-supplier cohorts, and no-variance cohorts
- Export row-count and value comparison

The known `9.67` versus `9.68` parent-level discrepancy should be resolved or explicitly accepted as a documented rounding rule. It should not be silently ignored.

### Suggested POC Performance Targets

These are starting targets and should be adjusted after baseline measurement:

| Interaction | Suggested warm-cache target |
|---|---:|
| Summary endpoint | Under 300 ms |
| First leaderboard page | Under 500 ms |
| Parent search | Under 300 ms |
| One-parent detail | Under 500 ms |
| Individual KPI first page | Under 750 ms |
| Frontend usable after navigation | Under 2 seconds on the internal network |

Large exports and Databricks refreshes are background/on-demand operations and should have separate duration targets.

### Observability

For the POC, lightweight structured logging is sufficient. Record:

- Endpoint name
- Snapshot ID
- Filter context
- Matching row/parent count
- Returned page size
- Cache hit or miss
- Calculation duration
- Serialization duration
- Total request duration
- Refresh and validation status

Do not log connection strings, access tokens, SQL credentials, or complete sensitive supplier records.

### Safe Git and Deployment Flow

Continue using feature branches rather than committing experimental work directly to `new-deployment`.

Recommended flow:

```text
new-deployment
        |
        +--> phase-2-scorecard-performance
                    |
                    +--> implement and test
                    +--> compare output and latency
                    +--> open pull request
                    +--> deploy to non-production environment
                    +--> perform business/UAT validation
                    +--> merge only after approval
```

Phase 3 and Phase 4 should preferably use separate branches or small pull requests. This makes regressions easier to identify and avoids combining score calculation, UI, storage, and refresh changes into one risky promotion.

### Rollback

Rollback should be possible at two levels:

- Code rollback: deploy the previous known-good application commit.
- Data rollback: point the application back to the previous validated snapshot.

The existing production-like `new-deployment` branch should remain unchanged until the optimized branch has passed automated tests, output comparison, performance validation, and user acceptance testing.

### Phase 5 Acceptance Criteria

- Baseline and optimized measurements are documented using the same dataset.
- Business outputs are unchanged or any rounding decisions are explicitly approved.
- Performance targets are met or deviations are understood.
- Refresh failure and application rollback procedures are tested.
- No Databricks credentials or refresh controls are exposed to end users.
- A pull request and non-production validation occur before promotion to `new-deployment`.

## Five-Phase Deliverables

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Validated data-volume report confirming approximately 29K parents | Confirmed |
| 2 | Optimized Normalized Scorecard APIs and frontend flow | Proposed, awaiting confirmation |
| 3 | Optimized shared backend flow for high-volume Individual KPI pages | Planned after Phase 2 |
| 4 | Validated immutable refresh snapshot and cache workflow | Planned after Phase 3 evidence |
| 5 | Performance report, regression evidence, deployment and rollback plan | Planned throughout, finalized before promotion |

## Next Session

Start by confirming the Phase 2 assumptions above. The remaining phases are now recorded but should not all be implemented at once. After confirmation:

1. Inspect and document the exact fields currently rendered by the Normalized Scorecard table, summary cards, parent detail panel, and CSV export.
2. Finalize the compact leaderboard and selected-parent API contracts.
3. Implement Phase 2 in small, testable steps.
4. Measure performance before and after the implementation.
5. Confirm Phase 2 business output and latency with the 29K-parent dataset.
6. Only after Phase 2 is confirmed, proceed to Phase 3 using one high-volume KPI as the reference implementation.
