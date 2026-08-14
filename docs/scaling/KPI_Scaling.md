# KPI Onboarding — Scaling Guide

> **Context:** How much effort is required to onboard a new KPI (e.g., NPS, Turnover) into the existing Normalized Scorecard architecture?
> **Short answer:** The normalized scorecard calculation engine requires **zero changes**. It is fully data-driven from `KPI_CONFIGS`. Only the individual KPI data layer needs to be built.

---

## Architecture Overview

The scorecard engine in `apps/backend/scorecard.py` iterates over `KPI_CONFIGS` to:
- Fetch scored results from cache
- Determine applicability status per supplier (`VALID_DATA`, `MISSING_DATA`, `NOT_APPLICABLE`)
- Compute earned points, pillar %, weighted contributions, normalized score, and coverage-adjusted score

All of this is **automatic** once a KPI has a real `cache_key` pointing to data.

---

## Current KPI IDs in `KPI_CONFIGS`

| ID | Name | Pillar | Status |
|---|---|---|---|
| DOT | Delivery On Time | Service Level | ✅ Active |
| SA | Supplier Assessment | Service Level | ✅ Active |
| SC | Supplier Compliance | Service Level | ✅ Active |
| NPS | Net Promoter Score | Service Level | 🔲 Placeholder |
| TURN | Turnover | Service Level | 🔲 Placeholder |
| POACC | PO Acceptance | Service Level | 🔲 Placeholder |
| PDIV | Price Divergence | Operational | ✅ Active |
| IC | Invoice Conformity | Operational | ✅ Active |
| IOT | Invoice On Time | Operational | ✅ Active |
| SM | Supplier Maturity | Sustainability | ✅ Active |
| ECL | Eclipse Score | Sustainability | ✅ Active |
| CO2 | CO₂ Reduction Potential | Sustainability | ✅ Active |
| COST | Cost | Value Creation | 🔲 Placeholder |
| CASH | Cash | Value Creation | 🔲 Placeholder |
| ENG | Engagement | Value Creation | 🔲 Placeholder |

> NPS and Turnover **already exist as placeholders** — `cache_key` is `None`. Onboarding them means converting placeholders into real, data-backed KPIs.

---

## KPI Config Schema (required fields per entry)

```python
{
    "id":        "DOT",           # Unique KPI identifier
    "name":      "Delivery On Time",
    "pillar":    "Service Level",
    "cache_key": "dot_kpi",       # Key into the in-memory cache dict (None = placeholder)
    "max_score": 10.0,            # Maximum points this KPI contributes to the pillar
    "floor":     0.70,            # Attainment floor (0 points below this)
    "target":    0.85,            # Attainment target (full points at/above this)
    "direction": "higher",        # "higher" | "lower" | "quartile"
    "unit":      "percent",
}
```

---

## The 7-Step Onboarding Checklist

### Step 1 — Register KPI config ⚡ ~10 min
**File:** `apps/backend/scorecard.py` → `KPI_CONFIGS` list

For NPS/Turnover: the placeholder entry already exists. Fill in:
- `cache_key` → e.g., `"nps_kpi"`
- `floor`, `target` → business-defined thresholds
- `direction` → `"higher"` / `"lower"` / `"quartile"`
- `unit` → `"score"` / `"percent"` / etc.

---

### Step 2 — Build fetch/transform module 🔶 ~3–6 hrs
**File:** New `apps/backend/fetch_nps_kpi.py`

Follow the pattern from `fetch_dot_kpi.py`:

```python
def fetch_raw() -> pd.DataFrame:
    # Databricks SQL query for the KPI source table
    ...

def process(df: pd.DataFrame) -> pd.DataFrame:
    # Normalize columns, set kpiApplicability, group/aggregate
    # Must output these mandatory columns:
    # parentSupplier, supplier, zone, country, category,
    # sub_category, purchasing_category, scorecard_category,
    # kpiApplicability ("Applicable" | "Not Applicable"),
    # year, [month], [KPI metric column]
    ...

def main():
    df_raw = fetch_raw()
    df = process(df_raw)
    df.to_csv(OUTPUT_PATH, index=False)
```

---

### Step 3 — Wire cache + endpoints in server.py ⚡ ~30 min
**File:** `apps/backend/server.py`

1. Add `NPS_OUTPUT_PATH` constant near other `*_OUTPUT_PATH` constants (~line 130)
2. Load CSV into cache on startup, following existing pattern (~line 364)
3. Add GET endpoint + refresh POST endpoint following the 9-KPI pattern (~line 562+)

---

### Step 4 — Implement scoring math in scorecard engine 🔶 ~1–2 hrs
**File:** `apps/backend/scorecard.py` → KPI scoring branch (~line 560)

If NPS uses linear attainment (same as DOT/IC), it's a ~10-line copy-adjust.
If it uses quartile-based scoring (like CO2), generalize the quartile source field.

```python
# Linear attainment example (copy from DOT branch, adjust field name)
elif kpi["id"] == "NPS":
    raw = parent_rows["npsScore"].mean()
    attainment = linear_attainment(raw, kpi["floor"], kpi["target"], kpi["direction"])
    earned = attainment * kpi["max_score"]
```

---

### Step 5 — Validate applicability behavior ⚡ ~30 min
**File:** `apps/backend/scorecard.py` → applicability index (~line 339) and status lookup (~line 375)

- Confirm `kpiApplicability` from source data maps to `"Applicable"` / `"Not Applicable"`
- Add a category exclusion rule **only if business requires it** (e.g., Sustainability KPIs excluded for BST category is hardcoded at ~line 288)
- Once `cache_key` is real, the KPI automatically appears in scorecard config APIs (they filter on `cache_key`)

---

### Step 6 — Frontend KPI breakdown table ✅ Zero changes
**File:** `apps/frontend/src/ScorecardPage.tsx`

The KPI breakdown table renders **any KPI** from `pillar.kpis[]` generically using:
`id, name, max_score, earned, attainment, raw, applicable, expected_applicable`

No new frontend code needed for the scorecard view.

---

### Step 7 — Dedicated KPI tab/page (optional) 🔶 ~2–4 hrs
Only needed if stakeholders want a standalone drilldown page (like the existing DOT/IOT pages with filters, raw data table, rollup, export).

**Files to create/modify:**
- New `apps/frontend/src/NpsKpiPage.tsx` — follow pattern from `DotKpiPage.tsx`
- `apps/frontend/src/App.tsx` — add tab + route
- `apps/frontend/src/shared/consistentKpiModel.ts` — add KPI id/spec if using the shared KPI page model

---

## Total Effort Estimate

| Scenario | Effort |
|---|---|
| **Scorecard only** (no dedicated tab) | **~5–9 hrs** per KPI |
| **Full KPI tab** (filters, drilldown, export) | **~10–15 hrs** per KPI |

The majority of time is in **Step 2** (Databricks query + data transform) — the complexity depends entirely on the source data availability and schema, not on the scorecard framework.

---

## What Does NOT Change

| Component | Change required? |
|---|---|
| Normalized score formula | ❌ None |
| Coverage-adjusted score formula | ❌ None |
| Pillar roll-up calculation | ❌ None |
| Weighted contribution calculation | ❌ None |
| Applicability status engine | ❌ None (unless new category exclusion rules) |
| Scorecard KPI breakdown table (frontend) | ❌ None |
| Pillar weights | ❌ None (unless business reconfigures) |
| Coverage % calculation | ❌ None |

---

## NPS / Turnover Specific Notes

Since both are already placeholder entries:
- Step 1 reduces to filling in 4 fields in an existing dict
- The primary dependency is **getting the Databricks table/view from the data team**
- NPS scoring is likely linear attainment (higher is better, 0–10 scale typically)
- Turnover scoring direction needs business clarification (lower turnover = better supplier stability)

---

## Zone-Specific (Local) KPIs

> **Question:** What if a new KPI applies only to a specific zone (e.g., EUR) and not to other zones (APAC, LATAM)?
> **Answer:** The existing `kpiApplicability` engine already handles this with zero changes to the scoring formula.

---

### The Mathematical Contract

The pillar weight is a **global constant**:

```
Service Level:  pillar_weight = 40   (fixed, never changes)
```

But `max_sum` — the denominator in `pillar_pct = earned_sum / max_sum` — is computed **per supplier**, not globally. Only KPIs with a scored result for that supplier are added to `max_sum`. This means:

- A EUR supplier evaluated on 4 KPIs has `max_sum = 30`
- A LATAM supplier evaluated on 3 KPIs has `max_sum = 25`
- Both can still achieve `pillar_pct = 100%` and `weighted = 40`

The scoring is always **"how well did you perform on what was expected of you"**.

---

### Step-by-Step Example: Adding "EUR Delivery Quality" (EDQ, max_score=5)

#### Three suppliers

| Supplier | Zone | DOT raw | SA raw | SC raw | EDQ raw |
|----------|------|---------|--------|--------|---------|
| ARDAGH | EUR | 88% | 75% | 80% | 82% |
| APAC Corp | APAC | 90% | 70% | 85% | N/A |
| LATAM Brew | LATAM | 82% | 65% | 75% | N/A |

---

#### SCENARIO A — No local KPI (DOT + SA + SC only)

All three suppliers share the same `max_sum = 25`.

**ARDAGH (EUR) attainment:**

| KPI | raw | floor | target | attainment | earned |
|-----|-----|-------|--------|------------|--------|
| DOT | 0.88 | 0.70 | 0.85 | (0.88-0.70)/(0.85-0.70) = **1.0** (capped) | 10.0 |
| SA | 0.75 | 0.50 | 0.80 | (0.75-0.50)/(0.80-0.50) = **0.833** | 8.33 |
| SC | 0.80 | 0.60 | 0.90 | (0.80-0.60)/(0.90-0.60) = **0.667** | 3.33 |

```
earned_sum = 10.0 + 8.33 + 3.33 = 21.67
max_sum    = 10 + 10 + 5         = 25
pillar_pct = 21.67 / 25          = 86.7%
weighted   = 86.7% × 40          = 34.67
```

Same `max_sum = 25` applies to APAC Corp and LATAM Brew — all three evaluated on identical scale.

---

#### SCENARIO B — With zone-specific KPI EDQ (max_score=5, EUR only)

**Step 1 — Add to `KPI_CONFIGS` in `scorecard.py`:**

```python
{
    "id": "EDQ",
    "name": "EUR Delivery Quality",
    "pillar": "Service Level",
    "cache_key": "eur_delivery_quality",
    "max_score": 5.0,
    "floor": 0.60,
    "target": 0.90,
    "direction": "higher",
    "unit": "percent",
},
```

**Step 2 — Critical line in `fetch_eur_delivery_quality.py`:**

```python
def process(df: pd.DataFrame) -> pd.DataFrame:
    # Every non-EUR row MUST appear with "Not Applicable" — never omit rows
    df["kpiApplicability"] = df["zone"].apply(
        lambda z: "Applicable" if z == "EUR" else "Not Applicable"
    )
    return df
```

**Step 3 — Trace the math per supplier:**

**ARDAGH (EUR) — EDQ attainment = (0.82-0.60)/(0.90-0.60) = 0.733, earned = 3.67**

| KPI | earned | added to max_sum? |
|-----|--------|-------------------|
| DOT | 10.0 | ✅ |
| SA | 8.33 | ✅ |
| SC | 3.33 | ✅ |
| EDQ | 3.67 | ✅ (kpiApplicability = "Applicable") |

```
earned_sum = 10.0 + 8.33 + 3.33 + 3.67 = 25.33
max_sum    = 10 + 10 + 5 + 5            = 30
pillar_pct = 25.33 / 30                 = 84.4%
weighted   = 84.4% × 40                 = 33.77
```

**APAC Corp (APAC) — EDQ = NOT_APPLICABLE**

| KPI | earned | added to max_sum? |
|-----|--------|-------------------|
| DOT | ~9.0 | ✅ |
| SA | ~6.67 | ✅ |
| SC | ~4.17 | ✅ |
| EDQ | 0 | ❌ (kpiApplicability = "Not Applicable") |

```
earned_sum = 9.0 + 6.67 + 4.17 = 19.83
max_sum    = 10 + 10 + 5        = 25       ← identical to Scenario A
pillar_pct = 19.83 / 25         = 79.3%
weighted   = 79.3% × 40         = 31.72
```

**LATAM Brew (LATAM) — identical to APAC Corp logic. max_sum stays at 25.**

---

#### Side-by-side impact

| Supplier | Scenario A max_sum | Scenario B max_sum | Change? |
|----------|--------------------|--------------------|---------|
| ARDAGH (EUR) | 25 | **30** | ✅ Extra 5 pts to earn — harder ceiling |
| APAC Corp | 25 | 25 | No change |
| LATAM Brew | 25 | 25 | No change |

Adding EDQ affects **only EUR suppliers**. APAC and LATAM are completely untouched.

---

### ⚠️ Critical: Missing Rows vs. "Not Applicable" Rows

Inside `_build_kpi_status_lookup()`:

```python
elif parent not in matched_parents or parent in applicable_parents:
    status = "MISSING_DATA"    # row absent OR applicable row with no scoreable value
else:
    status = "NOT_APPLICABLE"  # row present with kpiApplicability = "Not Applicable"
```

| Situation | Status assigned | Counted in Coverage? |
|-----------|----------------|----------------------|
| Row present, `kpiApplicability = "Not Applicable"` | `NOT_APPLICABLE` | ❌ Not counted — correct |
| Row absent entirely | `MISSING_DATA` | ✅ Counted — **wrongly reduces coverage %** for that supplier |

**Rule: always include explicit `"Not Applicable"` rows for out-of-zone suppliers in your fetch module. Never omit them.**

---

### Files touched for a zone-specific KPI

| # | File | What you do |
|---|------|-------------|
| 1 | `apps/backend/scorecard.py` | Add the new KPI entry to `KPI_CONFIGS` |
| 2 | `apps/backend/fetch_eur_delivery_quality.py` | New file — Databricks query + `process()` setting `kpiApplicability` |
| 3 | `apps/backend/server.py` | Add CSV path constant, cache load on startup, GET + refresh endpoints |
| 4 | `apps/backend/data/eur_delivery_quality.csv` | Seed file for local dev/testing |
| 5 | `apps/backend/refresh_scorecard_data.py` | Add to the refresh pipeline |

Normalized score formula, pillar roll-up, coverage calculation, and frontend table — **zero changes needed**.
