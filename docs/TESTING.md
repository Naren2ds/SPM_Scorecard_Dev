# SPM Scorecard — Testing Checklist

Use this file before merging any KPI branch to master.

---

## Pre-Merge Checklist (run for every branch)

### 1. No Unwanted File Changes
```powershell
git diff --name-only master
```
**PASS if:** Only your KPI files + `App.tsx` + `server.py` show up.
**FAIL if:** `DotKpiPage.tsx`, `scoring.ts`, `fetch_dot_kpi.py`, or another KPI's files appear.

### 2. TypeScript Compiles
```powershell
cd frontend
npx tsc --noEmit
```
**PASS if:** No output (zero errors).

### 3. Vite Build Passes
```powershell
cd frontend
npx vite build
```
**PASS if:** `✓ built in Xms` appears.

### 4. Backend Server Starts
```powershell
cd backend
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```
**PASS if:** `Application startup complete` + no import errors.

### 5. API Returns Data
```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/status'
```
**PASS if:** All KPI row counts > 0.

---

## Per-KPI Test Cases

### DOT KPI Tests

| # | Test Case | Steps | Expected Result |
|---|---|---|---|
| D1 | Page loads with data | Open DOT KPI tab | Shows "29967 rows loaded", filters populated |
| D2 | Category filter works | Select "CANS" in Category dropdown | Row count drops, only CANS rows in results |
| D3 | Year filter works | Select "2026" only | Only 2026 data shown |
| D4 | Month filter works | Select "1" | Only January data |
| D5 | Multi-filter combo | Category=LOGISTICS + Year=2025 | Smaller subset, all rows match both |
| D6 | Config change updates scores | Change Max Score from 15 to 10 | All Earned Scores recalculate, max is now 10 |
| D7 | Floor change | Set Critical Floor to 90% | Most suppliers show "Below critical floor" |
| D8 | Zone rollup present | Scroll to Zone Rollup section | Table shows aggregated zone-level scores |
| D9 | Parent rollup present | Scroll to Parent Rollup section | Table shows parent-supplier level scores |
| D10 | Category rollup present | Scroll to Category Rollup section | Table shows category-level scores |
| D11 | Export works | Click Export Results | CSV downloads with correct data |
| D12 | Formula mode switch | Change to "Strict" | Scores recalculate, strict formula applied |
| D13 | Sticky headers | Scroll down in any table | Header row stays fixed at top |
| D14 | Refresh Data button | Click Refresh Data | Shows "Refreshing...", eventually reloads |

### IOT KPI Tests

| # | Test Case | Steps | Expected Result |
|---|---|---|---|
| I1 | Page loads with data | Open IOT KPI tab | Shows row count, filters populated |
| I2 | IOT % calculated | Check IOT % column | Values like 100.00%, 50.00%, 0.00% (not all blank) |
| I3 | Category filter works | Select "LOGISTICS" | Only LOGISTICS rows in results |
| I4 | Year filter default | On first load | Only 2025+2026 data (pre-selected) |
| I5 | Config change | Change Target to 95% | Fewer "Valid score" rows, more "Below critical floor" |
| I6 | Zone rollup present | Scroll to Zone Rollup | Aggregated zone-level IOT scores shown |
| I7 | Parent rollup present | Scroll to Parent Rollup | Parent-supplier level IOT scores |
| I8 | Category rollup present | Scroll to Category Rollup | Category-level IOT scores |
| I9 | Export works | Click Export Results | CSV downloads |
| I10 | Supplier table capped | Check supplier level heading | Shows "showing first 200" if > 200 rows |

### Cross-KPI Tests

| # | Test Case | Steps | Expected Result |
|---|---|---|---|
| X1 | Tab switching | Click DOT → IOT → DOT | Each page loads independently, no crash |
| X2 | DOT unaffected by IOT changes | Open DOT KPI tab | Same behavior as before IOT was added |
| X3 | Filters independent | Set filter on DOT, switch to IOT | IOT has its own filter state (not DOT's) |
| X4 | Both APIs respond | Check /api/status | Both dot_kpi_rows and iot_kpi_rows > 0 |
| X5 | Scoring Guide still works | Click Scoring Guide tab | Shows methodology page |

---

## Performance Tests

| # | Test Case | Expected |
|---|---|---|
| P1 | Page load time | < 3 seconds with 30K rows |
| P2 | Filter change response | < 1 second for score recalculation |
| P3 | No "Page Unresponsive" | Never appears during normal use |
| P4 | Backend startup time | < 5 seconds (loads CSV from disk) |

---

## How to Run Full Test Suite

```powershell
# 1. Kill old processes
taskkill /F /IM python.exe; taskkill /F /IM node.exe

# 2. Start fresh
cd C:\Users\C416241\Documents\SPM_Scorecard_Dev
.\run.bat

# 3. Open browser
# http://127.0.0.1:5173

# 4. Run through test cases above manually
# 5. Check API
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/status'

# 6. Verify no type errors
cd frontend; npx tsc --noEmit
```

---

## Adding Tests for New KPIs

When adding a new KPI, copy the IOT test section and update:
1. Tab name
2. Expected % column name
3. Expected filters
4. Rollup levels (always 4: Supplier, Zone, Parent, Category)
5. API endpoint check

---

## Common Failures & Fixes

| Symptom | Cause | Fix |
|---|---|---|
| "0 / 0 rows" | Backend not running or wrong port | Restart: `.\run.bat` |
| "Page Unresponsive" | Rendering too many rows | Ensure supplier table is capped at 200 |
| All % values are 0 or "-" | Column name mismatch in backend | Check `fetch_<kpi>.py` column mapping vs raw data |
| "Refresh failed" | Databricks timeout or SSL error | Use `use_cloud_fetch=False`, check .env credentials |
| Port 8000 already in use | Old python process running | `taskkill /F /IM python.exe` then retry |
| Filters empty (no options) | Data not loaded from API | Check browser console for CORS or fetch errors |
| Scores don't update on filter change | `filteredRows` not wired to scoring useMemo | Ensure scoring uses `filteredRows`, not `rows` |
