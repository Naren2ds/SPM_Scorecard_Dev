# SPM Scorecard — Bug Fixes Log

All fixes applied during the July 2026 audit session.

---

## Fix 1 — `contextRows is not defined` (Runtime Crash)

**Affected files**: `frontend/src/pages/SupplierAssessmentPage.tsx`, `SupplierCompliancePage.tsx`, `SupplierMaturityPage.tsx`  
**Symptom**: Pages crashed immediately on load with `ReferenceError: contextRows is not defined`.  
**Root cause**: The `parentRollup` useMemo referenced `contextRows`, which was never declared in those files.  
**Fix**: Added `contextRows` useMemo to each page. It filters by category/year/zone/country (and excludes the `selParent`/`selSupplier` filters) so that percentile ranks are computed across the full population — matching the Normalized Scorecard backend behaviour.

---

## Fix 2 — `displayedParentRollup` Undefined (Runtime Crash)

**Affected file**: `frontend/src/pages/Co2EmissionPage.tsx`  
**Symptom**: Page crashed when the Parent Rollup table tried to render.  
**Root cause**: `displayedParentRollup` was used in the JSX but never defined.  
**Fix**: Added `displayedParentRollup` useMemo that post-filters `parentRollup` by selected parent supplier. Also fixed `parentRollup` to use `contextRows` instead of `filteredRows`.

---

## Fix 3 — IotKpiPage Hardcoded Max Score in Rollup Table

**Affected file**: `frontend/src/pages/IotKpiPage.tsx`  
**Symptom**: The Parent/Zone/Category rollup tables always showed max score as `15` regardless of the configured value.  
**Root cause**: The `RollupTable` component received a hardcoded `numeric(15, 2)` for the Max Score column.  
**Fix**: Added `maxScore` prop to `RollupTable` and passed `config.maxScore` at all three call sites.

---

## Fix 4 — EclipsePage Wrong Refresh Poll Key

**Affected file**: `frontend/src/pages/EclipsePage.tsx`  
**Symptom**: Clicking "Refresh Data" appeared to hang indefinitely — the polling loop never terminated.  
**Root cause**: The poll checked `j.eclipse_status`, which is never set by the backend. The backend sets `j.status`.  
**Fix**: Changed `j.eclipse_status !== "refreshing"` → `j.status !== "refreshing"`.

---

## Fix 5 — Normalized Scorecard Showed Only Top 20 Suppliers

**Affected files**: `frontend/src/ScorecardPage.tsx`, `backend/server.py`  
**Symptom**: The Normalized Scorecard page always returned only 20 parent suppliers.  
**Root cause**: The frontend sent `top_n=20` on every request. The backend also defaulted `top_n=20` for both `/api/scorecard` and `/api/scorecard/leaderboard`.  
**Fix**:
- Removed `const TOP_N = 20` and all `params.set("top_n", …)` calls from `ScorecardPage.tsx`.
- Changed backend defaults from `top_n: int = 20` → `top_n: int = 0` (0 = no limit).

---

## Fix 6 — Parent Supplier Dropdown Showing 8,799 Entries

**Affected file**: `frontend/src/ScorecardPage.tsx`, `backend/server.py`  
**Symptom**: The Parent Supplier multi-select on the Scorecard page listed ~8,799 individual supplier names instead of actual parent suppliers.  
**Root cause**: The `/api/scorecard/filters` endpoint sourced the `parents` list from raw KPI rows using `_rollup_key`. Before the orphan fix (see Fix 9 below), rows with no `parentSupplier` fell back to the individual supplier name, producing thousands of virtual parent entries.  
**Fix**:
- Removed the Parent Supplier `MultiSelectDropdown` from `ScorecardPage.tsx` entirely.
- Changed `/api/scorecard/filters` to source `parents` from `_scored_cache["scorecards"]` (the actual scored parent names) instead of raw KPI rows.

---

## Fix 7 — Stale Scorecard Cache After Databricks Refresh

**Affected file**: `backend/server.py`  
**Symptom**: After clicking "Refresh Data" on an individual KPI page (e.g. Supplier Assessment), the Normalized Scorecard still showed old scores. Only a full server restart updated the scorecard.  
**Root cause**: When a KPI's background refresh completed, it updated `_cache["supplier_assessment"]` (or the relevant key) but never called `_build_scored_cache()`. So `_scored_cache` (which powers the Scorecard API) was never rebuilt.  
**Fix**: Added a call to `_build_scored_cache()` at the end of all 9 background refresh functions:
- `_background_refresh_dot`
- `_background_refresh_iot`
- `_background_refresh_supplier_assessment`
- `_background_refresh_supplier_compliance`
- `_background_refresh_supplier_maturity`
- `_background_refresh_co2_emission`
- `_background_refresh_eclipse`
- `_background_refresh_ic`
- `_background_refresh_pdiv`

---

## Fix 8 — Algorithmic Mismatch: Orphan Supplier Grouping

**Affected file**: `backend/scorecard.py` — `_rollup_key()` function  
**Symptom**: Scores in the Normalized Scorecard differed from the Individual KPI pages for suppliers whose rows had empty `parentSupplier`.  
**Root cause**: When `parentSupplier` was blank, `_rollup_key` fell back to the individual **supplier name** (e.g. "ARDAGH GLASS MAASMECHELEN"). This created hundreds of separate virtual parent entries — one per orphan supplier — making the cohort artificially small. The frontend instead groups all orphan rows under a single `"Unassigned parent"` entry via `dim(row.parentSupplier, "Unassigned parent")`.  
**Fix**: Changed the `_rollup_key` fallback:
```python
# Before
return str(row.get("supplier", "") or "").strip() or "(Unknown)"

# After
return "Unassigned parent"
```
All orphan rows now form a single cohort entry, matching the frontend exactly.

---

## Fix 9 — Algorithmic Mismatch: Percentile Formula

**Affected file**: `backend/scorecard.py` — `_kpi_attainments()` function  
**Symptom**: Even after Fix 8, scores still didn't match for some suppliers. The Normalized Scorecard showed 7.97 for ARDAGH GROUP SA while the SA page showed 7.44.  
**Root cause**: The backend percentile formula was `(N - rank_0idx) / N` (0-indexed rank, no tie handling, worst supplier gets `1/N` ≠ 0). The frontend uses:
```
percentile = (N - averageRank) / (N - 1)
```
with midpoint rank for tied groups, and special cases:
- N=1 → 1.0
- All values identical → `value ≥ target ? 1.0 : 0.5`
- Worst supplier → 0.0 (not `1/N`)

**Fix**: Rewrote the Step 2 percentile block in `_kpi_attainments` to implement the same algorithm:
```python
if total == 1:
    percentiles[next(iter(per_parent))] = 1.0
else:
    ratios = {k: per_parent[k]["ratio"] for k in per_parent}
    distinct = set(round(v, 12) for v in ratios.values())
    if len(distinct) == 1:
        shared = next(iter(ratios.values()))
        pct = 1.0 if shared >= float(target) else 0.5
        percentiles = {k: pct for k in per_parent}
    else:
        sorted_keys = sorted(per_parent.keys(), key=lambda k: ratios[k], reverse=reverse_sort)
        cursor = 0
        while cursor < total:
            current = round(ratios[sorted_keys[cursor]], 12)
            end = cursor + 1
            while end < total and round(ratios[sorted_keys[end]], 12) == current:
                end += 1
            avg_rank = (cursor + 1 + end) / 2
            pct = (total - avg_rank) / (total - 1)
            for i in range(cursor, end):
                percentiles[sorted_keys[i]] = pct
            cursor = end
```
**Validation**: After both Fix 8 and Fix 9, ARDAGH GROUP SA earned = **7.4392** (backend) vs **7.44** (frontend) — match confirmed.  
Since `_rollup_key` and `_kpi_attainments` are shared helpers, these two fixes apply to **all 9 active KPIs** (DOT, SA, SC, PDIV, IC, IOT, SM, ECL, CO2).

---

## Fix 10 — Frontend Parent Rollup Orphan Label Mismatch

**Affected files**: `frontend/src/pages/EclipsePage.tsx`, `InvoiceConformityPage.tsx`, `IotKpiPage.tsx`, `PriceDivergencePage.tsx`  
**Symptom**: The Parent Rollup table on these 4 pages grouped orphan suppliers (empty `parentSupplier`) under `"Unassigned"`, while the Normalized Scorecard groups them under `"Unassigned parent"`. This caused a label mismatch between the individual KPI page and the scorecard.  
**Root cause**: These 4 pages have inline rollup functions that used a generic fallback:
```typescript
const key = row[groupBy]?.trim() || "Unassigned";
```
The 5 other KPI pages (DOT, SA, SC, SM, CO2) use `calculateParentRollup` from `shared/scoring.ts` which correctly applies `dimensionValue(row.parentSupplier, "Unassigned parent")`.  
**Fix**: Changed the key lookup in all 4 pages to use `"Unassigned parent"` when grouping by `parentSupplier`:
```typescript
const key = groupBy === "parentSupplier"
  ? (row.parentSupplier?.trim() || "Unassigned parent")
  : (row[groupBy]?.trim() || "Unassigned");
```

---

## Summary Table

| # | Fix | Files Changed |
|---|-----|---------------|
| 1 | `contextRows` useMemo missing | SA, SC, SM pages |
| 2 | `displayedParentRollup` undefined + Co2 `parentRollup` wrong input | Co2EmissionPage |
| 3 | Hardcoded max score in RollupTable | IotKpiPage |
| 4 | Wrong refresh poll key (`eclipse_status` → `status`) | EclipsePage |
| 5 | Scorecard Top 20 restriction removed | ScorecardPage, server.py |
| 6 | Parent Supplier dropdown 8,799 entries removed | ScorecardPage, server.py |
| 7 | Stale scorecard cache after KPI refresh | server.py (9 refresh functions) |
| 8 | Orphan grouping: `_rollup_key` fallback → "Unassigned parent" | scorecard.py |
| 9 | Percentile formula: `(N-avgRank)/(N-1)` with tie-averaging | scorecard.py |
| 10 | Frontend parent rollup orphan label: "Unassigned" → "Unassigned parent" | ECL, IC, IOT, PDIV pages |
