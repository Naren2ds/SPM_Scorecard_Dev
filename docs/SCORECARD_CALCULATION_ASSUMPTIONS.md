# Scorecard Calculation Assumptions

This document captures all the assumptions embedded in the normalized scorecard computation (`apps/backend/scorecard.py`). It is intended as a reference for business stakeholders, UAT reviewers, and developers.

---

## 1. Grouping & Data Assumptions

### 1.1 Unassigned Parent Group
Suppliers with a blank or missing `parentSupplier` field are all grouped together under a single cohort called **"Unassigned parent"** and scored as one entity.

### 1.2 KPI Applicability Filter
Any data row where `kpiApplicability = "Not Applicable"` is **completely excluded** from all calculations — numerator, denominator, and counts. Only rows explicitly marked applicable (or with no applicability flag) are included.

### 1.3 Invoice Value Fallback (PDIV — Top-N only)
When computing invoice value totals for Top-N supplier ranking, if `invoiceValue` is missing for a row, `poValue` is used as a fallback so the row still contributes to the ranking. This fallback applies **only** to Top-N ranking, not to the PDIV attainment formula itself.

---

## 2. Per-KPI Aggregation Assumptions

Each KPI aggregates all applicable rows for a parent supplier into a **single ratio**, which is then fed into the attainment curve.

### 2.1 Delivery On Time (DOT)
Uses an **adjusted denominator** — not a plain on-time / total ratio.

$$\text{DOT} = \frac{\sum \text{onTimePoLines}}{\sum \left(\text{totalDeliveredPoLines} + 0.99 \times \text{delayed}_{>30d} + 0.10 \times \text{early}_{>30d}\right)}$$

- Deliveries delayed > 30 days are penalized at **99%** of their count.
- Deliveries early > 30 days are penalized at **10%** of their count.
- This means late deliveries hurt the score significantly more than early ones.

### 2.2 Price Divergence (PDIV)
Uses a **weighted aggregate across all invoices** — not a simple average of per-invoice divergence percentages.

$$\text{PDIV} = \frac{\sum |invoiceValue - poValue|}{\sum poValue}$$

- Rows with missing `invoiceValue` or `poValue <= 0` are skipped entirely.
- Direction: **lower is better** (floor = 25%, target = 19.9%).

### 2.3 Invoice On Time (IOT)
Simple ratio of on-time invoice lines across all PO lines.

$$\text{IOT} = \frac{\sum \text{invoiceOnTimeCount}}{\sum \text{totalPoLines}}$$

### 2.4 Invoice Conformity (IC)
Conformant invoices = total invoices minus mismatches.

$$\text{IC} = \frac{\sum (\text{totalInvoices} - \text{mismatchCount})}{\sum \text{totalInvoices}}$$

### 2.5 Supplier Assessment (SA)
A **weighted health score** based on green / yellow / red assessment outcomes.

$$\text{SA} = \frac{\sum (\text{green} \times 1.0 + \text{yellow} \times 0.5 + \text{red} \times 0)}{\sum (\text{green} + \text{yellow} + \text{red})}$$

- Rows where `green + yellow + red = 0` are excluded from the denominator.
- Red outcomes contribute **0** to the numerator.

### 2.6 Supplier Compliance (SC)
**Simple average** of the `compliancePct` field across all applicable rows — not weighted by volume or number of assessments.

$$\text{SC} = \frac{\sum \text{compliancePct}}{N}$$

### 2.7 Supplier Maturity (SM)
Simple average of `maturityScore`. Values provided on a **0–100 scale are normalized to 0–1** by dividing by 100 before averaging.

$$\text{SM} = \text{avg}\left(\frac{\text{maturityScore}}{100}\right) \quad \text{if score} > 1$$

### 2.8 Eclipse Score (ECL)
Same normalization as Supplier Maturity — values `> 1` are divided by 100.

$$\text{ECL} = \text{avg}\left(\frac{\text{eclipseScore}}{100}\right) \quad \text{if score} > 1$$

### 2.9 CO₂ Reduction Potential (CO2)
Uses a **quartile-based** scoring approach rather than fixed floor/target thresholds.

- Q1 and Q3 are computed from **individual supplier row values** (not parent-level averages), matching the frontend behavior (`computeQuartileDefaults(filteredRows)`).
- Q1 becomes the floor, Q3 becomes the target, and the direction is treated as **higher is better**.
- If only 1 data point exists (cannot form quartiles), **full attainment is awarded**.

---

## 3. Attainment & Scoring Assumptions

### 3.1 Linear Attainment Curve
For all KPIs except CO2, attainment is computed as a linear interpolation between floor and target:

$$\text{attainment} = \begin{cases} 1.0 & \text{if raw} \geq \text{target (higher-is-better)} \\ 0.0 & \text{if raw} \leq \text{floor (higher-is-better)} \\ \dfrac{raw - floor}{target - floor} & \text{otherwise} \end{cases}$$

For **lower-is-better** KPIs (PDIV), the floor and target are swapped in the comparison.

### 3.2 Soft-Stretch Earned Points
Earned points are **not** simply `attainment × max_score`. A **percentile bonus** is applied:

$$\text{earned} = \text{max\_score} \times \text{attainment} \times (0.70 + 0.30 \times \text{percentile})$$

- The base weight is **70%** attainment-driven.
- An additional **30%** is driven by how the supplier ranks among its peers.
- A supplier hitting the target exactly can still earn less than `max_score` if it ranks poorly in the population.

### 3.3 Percentile Ranking
Percentile is computed across all parent suppliers using a **midpoint rank formula**:

$$\text{percentile} = \frac{N - \text{avgRank}}{N - 1}$$

Where `avgRank` is the average of the 1-indexed positions in the sorted list for tied groups.

Special cases:
- **N = 1** → percentile = 1.0 (only one supplier, awarded full rank)
- **All values identical** → percentile = 1.0 if value ≥ target, else 0.5
- **Tied suppliers** share the same averaged rank (ties are not broken arbitrarily)

---

## 4. Pillar & Normalized Score Assumptions

### 4.1 Pillar Score Denominator = Applicable KPIs Only
$$\text{Pillar Score \%} = \frac{\sum \text{Earned KPI Points}}{\sum \text{Applicable KPI Max Points}}$$

KPIs with no data for a supplier are excluded from both numerator and denominator. A supplier with data for only 1 KPI in a pillar is still scored on that pillar using only that KPI.

### 4.2 Normalized Score Denominator = Applicable Pillars Only
$$\text{Normalized Score} = \frac{\sum (\text{Pillar Score \%} \times \text{Pillar Weight})}{\sum \text{Applicable Pillar Weights}} \times 100$$

Pillars where **no KPI has any data** for a supplier are excluded from the weighted average entirely.

### 4.3 Coverage Percentage
$$\text{Coverage \%} = \frac{\sum \text{Available KPI Weight}}{\sum \text{Expected KPI Weight (all KPIs incl. placeholders)}}$$

Expected weight includes all 15 KPIs defined in the framework (including the 6 with no current data source). A supplier with data for only 3 KPIs will have a low coverage %.

### 4.4 Coverage-Adjusted Score
$$\text{Coverage-Adjusted Score} = \text{Normalized Score} \times \text{Coverage \%}$$

This penalizes suppliers for whom many KPIs are missing or not applicable.

---

## 5. Placeholder KPI Assumption

Six KPIs defined in the framework have **no data source** in the current build:

| KPI ID | Name | Pillar | Max Score |
|---|---|---|---|
| NPS | Net Promoter Score | Service Level | 5 |
| TURN | Turnover | Service Level | 5 |
| POACC | PO Acceptance | Service Level | 5 |
| COST | Cost | Value Creation | 10 |
| CASH | Cash | Value Creation | 5 |
| ENG | Engagement | Value Creation | 5 |

- By default these are treated as **not applicable** and do not affect scores.
- If a user manually toggles one to **"Applicable"** in the UI, it is counted in the pillar denominator with **0 earned points**, which will lower that pillar's score.

---

## 6. Top-N Ranking Assumption

When a Top-N filter is applied:
- Suppliers are ranked by **total invoice value** (from `price_divergence` data), highest first.
- Only the top N are shown in the response.
- However, **percentile ranks are always computed across the full population** — restricting ranking to only the top N would give those suppliers artificially inflated percentiles and earned scores.

---

## 7. Pillar Weights

| Pillar | Weight |
|---|---|
| Service Level | 40 |
| Operational | 20 |
| Sustainability | 20 |
| Value Creation | 20 |

---

## 8. Score Banding

| Band | Normalized Score Range |
|---|---|
| Green | ≥ 80 |
| Amber | 60 – 79.99 |
| Red | < 60 |
