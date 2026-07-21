# Supplier Assessment Percentile Scoring

**KPI:** Annual Supplier Assessment (Quality)  
**Source file:** `src/qualityScoring.ts`, `src/qualityCsv.ts`, `src/qualityTypes.ts`

---

## Overview

Each supplier receives an **Earned Score** derived from two components:

| Component | What it measures |
|---|---|
| **Assessment Health Index (AHI)** | Raw quality of the supplier's Green/Yellow/Red assessment profile |
| **Percentile Rank** | How that AHI compares to all other suppliers in the same cohort |

The two components are combined with a configurable formula to produce the final Earned Score.

---

## Step 1 — Raw Data Ingestion (CSV Upload)

### Accepted columns

| Column (aliases accepted) | Type | Required |
|---|---|---|
| `Supplier` / `Supplier Name` | Text | Yes |
| `Parent Supplier` / `Parent` | Text | Optional |
| `Zone` | Text | Optional |
| `Country` | Text | Optional |
| `Plant / Site` / `Plant Site` / `Site` | Text | Optional |
| `KPI Applicability` / `Applicability` | Text | Yes |
| `Annual Supplier Assessment` / `Supplier Assessment Rating` / `Rating` | Text | Row mode |
| `Green Count` / `Green` | Number | Summary mode |
| `Yellow Count` / `Yellow` | Number | Summary mode |
| `Red Count` / `Red` | Number | Summary mode |
| `N/A Count` / `NA Count` | Number | Summary mode |

Column headers are **case-insensitive** and all non-alphanumeric characters are stripped before matching (e.g. `"Supplier Name"` → `suppliername`).

### KPI Applicability mapping

| Raw cell value | Interpreted as |
|---|---|
| `Not Applicable`, `N/A`, `NA`, `No`, `False` | Not Applicable |
| Anything else (including blank) | Applicable |

Not Applicable rows are **excluded from ranking and earn no score**.

---

## Step 2 — Input Mode Detection

The engine auto-detects which input style the uploaded data uses:

| Detected mode | Condition | Behaviour |
|---|---|---|
| **Row mode** | `Annual Supplier Assessment` column is populated | Each row is a single assessment event |
| **Summary mode** | Count columns (`Green Count`, etc.) are populated | Each row is a pre-aggregated supplier summary |
| **Both** | Both are present | Row mode is used; a warning is shown |
| **None** | Neither is present | Error — no data to score |

The mode can also be forced via the `inputMode` config option (`"auto"` / `"row"` / `"summary"`).

---

## Step 3 — Rating Normalisation (Row Mode Only)

Each `Annual Supplier Assessment` cell is mapped to a category:

| Raw value | Category |
|---|---|
| `Green`, `G` | Green ✅ |
| `Yellow`, `Amber`, `Y` | Yellow 🟡 |
| `Red`, `R` | Red 🔴 |
| `N/A`, `NA`, `Not Applicable` | N/A (excluded from denominator) |
| `Blank`, `(Blank)`, empty | Blank (excluded from denominator) |
| Anything else | Invalid → row flagged as **Invalid Data** |

---

## Step 4 — Aggregation to Count Row

Rows are grouped by the configured **cohort level** (`Supplier` / `Parent` / `Zone`).

For each group, the applicable (non-"Not Applicable") rows are counted:

```
totalValidAssessments = greenCount + yellowCount + redCount
```

N/A and Blank values are **excluded from the denominator**.

If `totalValidAssessments = 0` → status is **Missing Assessment** or **No Valid Assessment** → no score.

---

## Step 5 — Assessment Health Index (AHI)

$$
\text{AHI} = \frac{(\text{greenCount} \times w_G) + (\text{yellowCount} \times w_Y) + (\text{redCount} \times w_R)}{\text{totalValidAssessments}}
$$

**Default weights** (configurable):

| Rating | Weight |
|---|---|
| Green ($w_G$) | 1.0 |
| Yellow ($w_Y$) | 0.5 |
| Red ($w_R$) | 0.0 |

**Constraints enforced:** $w_G > w_Y > w_R \geq 0$ and $w_G \leq 1$.

AHI therefore ranges from **0.0** (all Red) to **1.0** (all Green).

---

## Step 6 — Percentile Ranking (within cohort)

Only suppliers with a valid AHI participate in ranking. Suppliers are sorted **descending** (higher AHI = better rank).

### Standard case

$$
\text{rank} = \frac{\text{first tied position} + \text{last tied position}}{2}
$$

$$
\text{percentile} = \frac{N - \text{rank}}{N - 1}
$$

where $N$ = number of suppliers in the cohort.

Result: **1.0 = best**, **0.0 = worst**.

### Special cases

| Situation | Rule applied |
|---|---|
| **Single observation** ($N = 1$) | Percentile = 1.0 |
| **No variance** (all AHI identical) | If AHI ≥ target → percentile = 1.0; otherwise → 0.5 |

---

## Step 7 — Attainment Factor

The attainment factor gates the score based on an absolute performance floor and target:

| AHI relative to thresholds | Attainment Factor |
|---|---|
| AHI < Critical Floor | **0** (zero score) |
| AHI ≥ Target | **1** (full attainment) |
| Critical Floor ≤ AHI < Target | $\dfrac{\text{AHI} - \text{criticalFloor}}{\text{target} - \text{criticalFloor}}$ (clamped to [0, 1]) |

---

## Step 8 — Earned Score

### Strict Percentile × Attainment (default)

$$
\text{Earned Score} = \text{maxScore} \times \text{percentile} \times \text{attainmentFactor}
$$

### Soft Stretch mode

Protects 70% of the score from percentile differentiation; only 30% is stretched by rank:

$$
\text{Earned Score} = \text{maxScore} \times \text{attainmentFactor} \times (0.70 + 0.30 \times \text{percentile})
$$

### Red Guardrail Cap (optional)

If `capScoreIfRedExceedsThreshold = true` **and** the supplier's red exposure meets or exceeds `redCapThreshold`:

$$
\text{Earned Score} = \min(\text{Earned Score},\ \text{maxScore} \times 0.50)
$$

---

## Step 9 — Score % and Status

$$
\text{Score \%} = \frac{\text{Earned Score}}{\text{maxScore}}
$$

| Score Status | Condition |
|---|---|
| **Valid** | Normal scored row |
| **Zero Score** | AHI below critical floor, or formula produces 0 |
| **Missing Assessment** | Row has blank but no valid ratings |
| **No Valid Assessment** | Only N/A values found |
| **Not Applicable** | KPI not applicable for this supplier |
| **Invalid Data** | Unrecognised rating values |
| **Single Observation** | Only one supplier in cohort |
| **No Variance** | All cohort members have identical AHI |

---

## End-to-End Example

**Config:** maxScore = 10, $w_G$ = 1.0, $w_Y$ = 0.5, $w_R$ = 0.0, criticalFloor = 60%, target = 85%, formula = Strict, cohort = Supplier-level, 3 suppliers in cohort.

| Supplier | Green | Yellow | Red | AHI | Rank | Percentile | Attainment | Earned Score |
|---|---|---|---|---|---|---|---|---|
| Supplier A | 8 | 1 | 1 | (8×1 + 1×0.5 + 1×0) / 10 = **0.85** | 1 | (3−1)/(3−1) = **1.00** | AHI ≥ target → **1.00** | 10 × 1.00 × 1.00 = **10.00** |
| Supplier B | 6 | 3 | 1 | (6×1 + 3×0.5 + 1×0) / 10 = **0.75** | 2 | (3−2)/(3−1) = **0.50** | (0.75−0.60)/(0.85−0.60) = **0.60** | 10 × 0.50 × 0.60 = **3.00** |
| Supplier C | 3 | 2 | 5 | (3×1 + 2×0.5 + 5×0) / 10 = **0.40** | 3 | (3−3)/(3−1) = **0.00** | AHI < floor → **0** | 10 × 0.00 × 0 = **0.00** |
