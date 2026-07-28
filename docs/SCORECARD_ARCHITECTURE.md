# Normalized Scorecard — Architecture Decision Record

## Background

The Normalized Supplier Scorecard aggregates scores from 9 KPIs across 4 pillars into
a single normalized score per parent supplier. This document records the architectural
options evaluated and the decision made for how KPI earned points are computed.

---

## The Problem

KPI earned points were computed differently in two places:

| | Individual KPI Pages | Scorecard (old) |
|---|---|---|
| Formula | `max × attainment × (0.70 + 0.30 × percentile)` | `max × attainment` |
| Percentile | ✅ Computed across all suppliers | ❌ Not applied |
| SA health | `(green×1.0 + yellow×0.5) / valid` (blanks excluded) | `green / (green+yellow+red+blank)` |
| Config source | React `useState` (browser RAM, lost on refresh) | `KPI_CONFIGS` in `scorecard.py` |

This caused visible discrepancies: the SA page showed Ardagh with earned = **10.00** while
the scorecard showed **5.04** for the same supplier.

---

## Options Evaluated

### Approach A — On-the-fly calculation (old build)

Every API call to `/api/scorecard` triggers a fresh aggregation of raw CSV rows.

```
Request → aggregate raw rows → attainment × max → response
```

| | |
|---|---|
| **Formula match** | ❌ No percentile, different SA health formula |
| **Latency** | ~30–50 ms per request |
| **Config source** | `KPI_CONFIGS` in `scorecard.py` |
| **Config change** | Restart server |
| **Consistency** | ❌ Diverges from individual KPI pages |

---

### Approach B1 — Full frontend calculation

Load all 9 KPI datasets in the browser. Run the full scoring pipeline in JavaScript.

| | |
|---|---|
| **Formula match** | ✅ 100% identical to KPI pages |
| **Latency** | ❌ Slow — 9 API calls before render |
| **Config source** | React state (per session) |
| **Config change** | Live (slider changes update scorecard) |
| **Consistency** | ✅ Perfect |
| **Complexity** | ❌ High — large payloads in browser memory |

---

### Approach B2 — Backend pre-computed cache ✅ CHOSEN

At server startup, run the full scoring pipeline once for ALL parent suppliers.
Cache the result. API requests serve directly from cache with in-memory list filtering.

```
Server startup:
  CSV load → _build_scored_cache()
    → compute_scorecard(all parents, no filter)
      → _aggregate_kpi (per KPI, per parent)
      → _kpi_attainments (attainment + percentile + soft-stretch)
    → _scored_cache = { scorecards: [...], cached_at: "...", ... }

Request → filter _scored_cache in memory → response  (<5 ms)
```

| | |
|---|---|
| **Formula match** | ✅ Same soft-stretch formula as KPI pages |
| **Latency** | ✅ < 5 ms (pure in-memory lookup) |
| **Config source** | `KPI_CONFIGS` in `scorecard.py` (single source of truth) |
| **Config change** | `POST /api/scorecard/rebuild` (no restart needed) |
| **Consistency** | ✅ Consistent after rebuild |
| **Zone/category filter** | ⚠️ Triggers on-the-fly recompute (changes aggregation) |

---

## Full Comparison

| Dimension | A (old) | B1 (frontend) | B2 (current) |
|---|---|---|---|
| Percentile applied | ❌ | ✅ | ✅ |
| SA blank exclusion | ❌ | ✅ | ✅ |
| SA yellow weighting | ❌ | ✅ | ✅ |
| Latency (no filter) | ~40 ms | ~500 ms+ | **< 5 ms** |
| Latency (zone/cat filter) | ~40 ms | ~500 ms+ | ~40 ms |
| Config single source | ✅ | ❌ | ✅ |
| Hot config reload | ❌ | ✅ | ✅ (rebuild endpoint) |
| Browser memory load | Low | High | Low |
| Implementation complexity | Low | High | Medium |

---

## How Config Changes Work (B2 + Option 2)

```
┌─────────────────────────────────────────────────────────┐
│  KPI_CONFIGS in backend/scorecard.py                    │
│  (floor, target, max_score, direction, SA weights)      │
│  ← Single source of truth for ALL scoring              │
└────────────────────┬────────────────────────────────────┘
                     │
         ┌───────────▼───────────┐
         │  Server startup or    │
         │  POST /api/scorecard/ │
         │  rebuild              │
         └───────────┬───────────┘
                     │
         ┌───────────▼───────────┐
         │  _build_scored_cache()│
         │  compute_scorecard()  │
         │  with percentiles     │
         └───────────┬───────────┘
                     │
         ┌───────────▼───────────┐
         │  _scored_cache{}      │
         │  (in-memory, server)  │
         └───────────┬───────────┘
                     │
         ┌───────────▼───────────┐
         │  GET /api/scorecard   │
         │  (< 5 ms lookup)      │
         └───────────────────────┘
```

### When to Rebuild the Cache

| Scenario | Action Required |
|---|---|
| KPI config changed in `scorecard.py` (floor, target, max_score) | Restart server **OR** click **Rebuild Cache** in UI |
| Fresh CSV data loaded (manual copy to `backend/data/`) | Click **Rebuild Cache** in UI |
| Fresh CSV data loaded via Refresh Data endpoint | Click **Rebuild Cache** in UI |
| Server restarted | Cache rebuilt automatically at startup |

### Rebuild Cache Button (UI)

The **Rebuild Cache** button is available in the Normalized Scorecard page header.

- Shows `Rebuilding Cache…` with disabled state while running
- Displays `Cache built: <timestamp> | <N> parents` below when complete
- After rebuild, the scorecard data reloads automatically
- The rebuild runs synchronously and takes ~1–3 seconds depending on data size

---

## Scoring Formula (New Build)

### Step 1 — Per-KPI raw ratio per parent supplier

Each KPI aggregates its raw rows:

| KPI | Numerator | Denominator |
|---|---|---|
| DOT | `onTimePoLines` | `totalDelivered + 0.99×x1Late + 0.10×x2Early` |
| IOT | `invoiceOnTimeCount` | `totalPoLines` |
| IC | `totalInvoices − mismatches` | `totalInvoices` |
| PDIV | `ABS(invoiceValue − poValue)` | `poValue` |
| **SA** | `green×1.0 + yellow×0.5` | `green + yellow + red` (blanks excluded) |
| SC | average of `compliancePct` | — |
| SM | average of `maturityScore / 100` | — |
| ECL | average of `eclipseScore / 100` | — |
| CO₂ | sum of `co2Emission` | — (quartile-based) |

### Step 2 — Attainment curve

```
direction = "higher":   att = clip((ratio − floor) / (target − floor), 0, 1)
direction = "lower":    att = clip((floor − ratio) / (floor − target), 0, 1)
direction = "quartile": floor = Q1, target = Q3 of population → treated as "higher"
```

### Step 3 — Percentile rank

Sort all parents by their raw ratio (best to worst). The best parent gets percentile = 1.0
(100th), the worst gets percentile = 1/N.

```
percentile[rank_0idx] = (N − rank_0idx) / N
```

### Step 4 — Earned score (soft-stretch)

```
earned = max_score × attainment × (0.70 + 0.30 × percentile)
```

Minimum possible earned (attainment > 0) = `max_score × att × 0.70`
Maximum possible earned = `max_score × 1.0 × 1.0 = max_score`

### Step 5 — Pillar score

```
pillar_pct = Σ(earned KPI points) / Σ(applicable max KPI points)
```

### Step 6 — Normalized score

```
normalized = Σ(pillar_pct × pillar_weight) / Σ(applicable pillar weight) × 100
```

### Step 7 — Coverage & adjusted score

```
coverage = Σ(available KPI weight) / Σ(expected KPI weight across all pillars)
coverage_adjusted = normalized × coverage
```

---

## KPI Config (Single Source of Truth)

All parameters live in `backend/scorecard.py → KPI_CONFIGS`:

| KPI | Max Score | Floor | Target | Direction |
|---|---|---|---|---|
| DOT | 10 | 70% | 85% | higher |
| Supplier Assessment | 10 | 50% | 80% | higher |
| Supplier Compliance | 5 | 60% | 90% | higher |
| Price Divergence | 5 | 15% | 5% | lower |
| Invoice Conformity | 5 | 70% | 85% | higher |
| Invoice On Time | 10 | 70% | 85% | higher |
| Supplier Maturity | 10 | 40% | 80% | higher |
| Eclipse Score | 5 | 50% | 80% | higher |
| CO₂ Reduction | 5 | Q1 | Q3 | quartile |

Frontend individual KPI page defaults mirror these values exactly.

---

## API Endpoints

| Endpoint | Method | Cache used? | Notes |
|---|---|---|---|
| `/api/scorecard` | GET | ✅ Yes (no zone/cat filter) | Returns top-N by invoice value |
| `/api/scorecard/leaderboard` | GET | ✅ Yes | Strips per-KPI breakdown |
| `/api/scorecard/parent` | GET | ✅ Yes | Single-parent drill-down |
| `/api/scorecard/filters` | GET | No | Reads raw cache for slicer options |
| `/api/scorecard/rebuild` | **POST** | — | Rebuilds `_scored_cache` |
| `/api/scorecard/cache-status` | GET | — | Returns `cached_at`, `parent_count` |

> Zone/category filters on any GET endpoint bypass the cache and recompute on the fly,
> because those filters change which rows are included in each KPI's aggregation.
