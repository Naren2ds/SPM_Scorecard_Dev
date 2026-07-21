# Supplier Compliance % Scoring

**KPI:** Supplier Documentation Compliance  
**Source file:** `src/complianceScoring.ts`, `src/complianceCsv.ts`, `src/complianceTypes.ts`

---

## Overview

Each supplier receives an **Earned Score** derived from two components:

| Component | What it measures |
|---|---|
| **Compliance %** | The supplier's absolute document compliance rate |
| **Percentile Rank** | How that compliance compares to all peers in the same cohort |

The two components are combined with a configurable formula to produce the final Earned Score.

---

## Step 1 — Raw Data Ingestion (CSV Upload)

### Accepted columns

| Column (aliases accepted) | Type | Notes |
|---|---|---|
| `Supplier` / `Supplier Name` | Text | Required |
| `Parent Supplier` / `Parent` | Text | Optional |
| `Zone` | Text | Optional |
| `Country` | Text | Optional |
| `KPI Applicability` / `Applicability` | Text | Required |
| `Supplier Compliance %` / `Compliance %` / `Docs % Complete` | Decimal or % | Direct mode |
| `Completed Documents` / `Completed Docs` | Number | Raw counts mode |
| `Required Documents` / `Required Docs` / `Total Required Documents` | Number | Raw counts mode |
| `Source System` | Text | Metadata |
| `Refresh Date` | Text | Metadata |
| `Data Owner` | Text | Metadata |
| `Period` | Text | Metadata |

Column headers are **case-insensitive** and all non-alphanumeric characters are stripped before matching.

### KPI Applicability mapping

| Raw cell value | Interpreted as |
|---|---|
| `Not Applicable`, `N/A`, `NA`, `No`, `False` | Not Applicable |
| Anything else (including blank) | Applicable |

Not Applicable rows are **excluded from ranking and earn no score**.

---

## Step 2 — Input Mode Detection

| Detected mode | Condition | Behaviour |
|---|---|---|
| **Raw counts** (preferred) | `Completed Documents` or `Required Documents` is populated | Compliance % is calculated from the counts |
| **Direct** | `Supplier Compliance %` is populated, no counts | The provided % is used directly |
| **Both** | Both are present | Raw counts take priority; a warning is shown |
| **None** | Neither is present | Supplier marked as **Missing Compliance** |

---

## Step 3 — Compliance % Derivation

### Option A — From Raw Document Counts (preferred)

$$
\text{Compliance \%} = \frac{\text{Completed Documents}}{\text{Required Documents}}
$$

**Validation rules:**
- Both values must be numeric and ≥ 0
- `Required Documents` must be > 0
- Result must be in [0, 1]; otherwise flagged as **Invalid Data**

### Option B — From Provided Compliance % (direct)

The raw value is normalised:

| Raw value | Normalisation applied |
|---|---|
| Value > 1 and ≤ 100 | Divided by 100 (e.g. `85` → `0.85`) |
| Value in [0, 1] | Used as-is (e.g. `0.85` → `0.85`) |
| Value < 0 or > 100 | **Invalid Data** |
| Non-numeric | **Invalid Data** |

The final internal value is always stored in the **[0, 1]** range.

---

## Step 4 — Parent / Zone Rollup (if cohort level ≠ Supplier)

When reporting at Parent or Zone level, individual supplier rows are aggregated:

### If ALL contributing suppliers have raw document counts

$$
\text{Rollup Compliance \%} = \frac{\sum \text{Completed Documents}}{\sum \text{Required Documents}}
$$

This is the **preferred** method — it avoids averaging percentages.

### If raw counts are not universally available

$$
\text{Rollup Compliance \%} = \frac{1}{n} \sum_{i=1}^{n} \text{Compliance}_i
$$

This is a **simple average** and is flagged as **"Proxy average"** in the output. The score status is set to **Proxy Calculation**.

---

## Step 5 — Percentile Ranking (within cohort)

Only rows with a valid Compliance % (applicable, no errors, not null) enter the ranking pool.  
Rows are sorted **descending** (higher compliance = better rank).

### Standard case

$$
\text{rank} = \frac{\text{first tied position} + \text{last tied position}}{2}
$$

$$
\text{percentile} = \frac{N - \text{rank}}{N - 1}
$$

where $N$ = number of ranked suppliers in the cohort.

Result: **1.0 = best**, **0.0 = worst**.

### Special cases

| Situation | Rule applied |
|---|---|
| **Single observation** ($N = 1$) | Percentile = 1.0 |
| **No variance** (all compliance identical) | If compliance ≥ target → percentile = 1.0; otherwise → 0.5 |

---

## Step 6 — Attainment Factor

The attainment factor gates the score based on absolute performance thresholds:

| Compliance relative to thresholds | Attainment Factor |
|---|---|
| Compliance < Critical Floor | **0** (zero score) |
| Compliance ≥ Target | **1** (full attainment) |
| Critical Floor ≤ Compliance < Target | $\dfrac{\text{compliance} - \text{criticalFloor}}{\text{target} - \text{criticalFloor}}$ (clamped to [0, 1]) |

---

## Step 7 — Earned Score

### Strict Percentile × Attainment (default)

$$
\text{Earned Score} = \text{maxScore} \times \text{percentile} \times \text{attainmentFactor}
$$

### Soft Stretch mode

Protects 70% of the score from percentile differentiation; only 30% is stretched by rank:

$$
\text{Earned Score} = \text{maxScore} \times \text{attainmentFactor} \times (0.70 + 0.30 \times \text{percentile})
$$

---

## Step 8 — Score % and Status

$$
\text{Score \%} = \frac{\text{Earned Score}}{\text{maxScore}}
$$

| Score Status | Condition |
|---|---|
| **Valid** | Normal scored row |
| **Zero Score** | Compliance below critical floor, or formula produces 0 |
| **Missing Compliance** | Applicable supplier with no usable compliance data |
| **Not Applicable** | KPI not applicable for this supplier |
| **Invalid Data** | Validation errors in the raw data |
| **Proxy Calculation** | Rollup uses simple average (not raw counts) |
| **Single Observation** | Only one supplier in cohort |
| **No Variance** | All cohort members have identical compliance |

---

## End-to-End Example

**Config:** maxScore = 10, criticalFloor = 70%, target = 90%, formula = Strict, cohort = Supplier-level, 3 suppliers.

### Input data

| Supplier | Completed Docs | Required Docs | Derived Compliance % |
|---|---|---|---|
| Supplier A | 95 | 100 | **95%** (0.95) |
| Supplier B | 80 | 100 | **80%** (0.80) |
| Supplier C | 65 | 100 | **65%** (0.65) |

### Percentile calculation ($N = 3$)

| Supplier | Compliance | Rank | Percentile |
|---|---|---|---|
| Supplier A | 0.95 | 1 | (3−1)/(3−1) = **1.00** |
| Supplier B | 0.80 | 2 | (3−2)/(3−1) = **0.50** |
| Supplier C | 0.65 | 3 | (3−3)/(3−1) = **0.00** |

### Attainment factor

| Supplier | Compliance | Attainment Factor |
|---|---|---|
| Supplier A | 0.95 ≥ 0.90 (target) | **1.00** |
| Supplier B | 0.70 ≤ 0.80 < 0.90 | (0.80−0.70)/(0.90−0.70) = **0.50** |
| Supplier C | 0.65 < 0.70 (floor) | **0** |

### Earned Score

| Supplier | Formula | Earned Score |
|---|---|---|
| Supplier A | 10 × 1.00 × 1.00 | **10.00** |
| Supplier B | 10 × 0.50 × 0.50 | **2.50** |
| Supplier C | 10 × 0.00 × 0 | **0.00** (Zero Score) |
