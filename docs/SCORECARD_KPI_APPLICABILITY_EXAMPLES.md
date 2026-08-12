# Scorecard KPI Applicability Examples

This note explains what happens to a KPI earned score in the Normalized
Scorecard when data is available, blank, unavailable, or not applicable.

## Core Rule

```text
Blank but applicable = missing expected data; coverage goes down
Not applicable = excluded from denominator and does not reduce the score
Not available framework KPI = excluded by default unless manually made applicable
```

Normalized score measures performance from KPIs that have usable scored data.
Coverage measures completeness against KPIs that are expected to apply.

```text
Coverage = Available KPI Weight / Expected Applicable KPI Weight
```

## How The Backend Derives Applicability Status

Databricks does not need to provide a new status column. For the active filter
scope, the backend scans each KPI dataset once and builds an internal lookup:

```text
KPI + Parent Supplier -> Derived Status
```

| Derived status | How it is identified | Score and coverage treatment |
| --- | --- | --- |
| `VALID_DATA` | An applicable row contains enough usable data to calculate the KPI | Scored and counted as available |
| `MISSING_DATA` | No matching row exists, or an applicable row has blank/unusable KPI data | Not scored; expected weight remains, so coverage decreases |
| `NOT_APPLICABLE` | Matching source rows exist but all say `Not Applicable` | Excluded with no coverage penalty |
| `BST_EXCLUDED` | Sustainability KPI and the parent supplier's Ranking/SPM Category is BST | Excluded with no coverage penalty |
| `BUSINESS_EXCLUDED` | The KPI has no active data source or another configured business rule excludes it | Excluded with no coverage penalty |

The lookup is held in backend memory only. It does not update Databricks, the
CSV cache, or the frontend schema. Country, Category, Sub Category, Purchase
Category, Ranking Category, Zone, and Parent Supplier filters are applied before
the status is derived.

Previously, the backend searched all rows again for every parent/KPI pair. The
lookup preserves the same business result while removing those repeated scans:

```text
Before: for every parent -> for every KPI -> search all KPI rows
Now:    scan each KPI dataset once -> derive statuses once -> use lookup
```

## Example Setup

Assume a supplier has these applicable pillar weights:

```text
Service Level: 40
Operational: 20
Sustainability: 20
Value Creation: 20
```

For each KPI:

```text
KPI earned score = calculated KPI points
KPI max score = maximum available points for that KPI

pillar_score_pct = sum(earned KPI points) / sum(applicable KPI max points)

normalized_score =
  sum(pillar_score_pct * pillar_weight)
  / sum(applicable pillar weights)
  * 100
```

## Scenario 1: KPI Has Valid Data

Example:

```text
KPI: DOT
KPI max score: 10
DOT data: valid
Calculated earned score: 8
Applicability: Applicable
```

Scorecard treatment:

```text
Earned score included: 8
Applicable max points included: 10
KPI score contribution: 8 / 10 = 80%
```

Result:

```text
The KPI contributes normally to the pillar and normalized score.
```

## How Each Case Should Behave

| Scenario | Should impact normalized score? | Should impact coverage? | Why |
| --- | --- | --- | --- |
| KPI has valid data | Yes | Counts as available | Normal case |
| KPI applies but data is missing | No direct earned score, but should show missing | Yes, coverage should go down | Data completeness issue |
| KPI is deliberately not applicable | No | No penalty | Business rule says it does not apply |
| BST Sustainability exclusion | No | No penalty | Business rule says Sustainability does not apply to BST |
| Source says `Not Applicable` | No | No penalty | Source/business says KPI does not apply |

## Scenario 2: KPI Data Is Blank But KPI Is Applicable

Example:

```text
KPI: Supplier Compliance
KPI max score: 5
Compliance value: blank
Applicability: Applicable
```

Scorecard treatment:

```text
Earned score included in normalized score: no
Available KPI weight: 0
Expected applicable KPI weight: 5
Coverage contribution: 0 / 5 = 0%
```

Result:

```text
The KPI does not add earned score because there is no usable score, but it
reduces coverage because the KPI was expected to apply.
```

This is a missing-data coverage penalty.

## Scenario 3: KPI Is Not Available In The System

Example:

```text
KPI: NPS
KPI max score: 5
Source data: not connected / not available
Default applicability: Not applicable
```

Scorecard treatment by default:

```text
Earned score included: no
Applicable max points included: no
KPI shown as placeholder: yes
```

Result:

```text
The KPI is visible in the framework, but it does not reduce the score by
default because the system does not have source data for it yet.
```

If the user manually changes the KPI to applicable in the UI:

```text
Available KPI weight: 0
Expected applicable KPI weight: 5
Coverage contribution: 0 / 5 = 0%
```

That manual override makes the unavailable KPI count as missing applicable data.

## Scenario 4: KPI Is Marked Not Applicable In Source Data

Example:

```text
KPI: CO2 Emission
KPI max score: 5
Source row kpiApplicability: Not Applicable
```

Scorecard treatment:

```text
The source row is excluded from KPI aggregation.
Earned score included: no
Applicable max points included: no
```

Result:

```text
The KPI does not reduce the score because the source says it does not apply.
```

If all rows for that parent supplier and KPI are marked `Not Applicable`, then
that KPI is excluded for that parent supplier.

## Scenario 5: Category-Level Not Applicable KPI

Example:

```text
Supplier category: BST
KPI group: Sustainability
Business rule: Sustainability KPIs are not applicable for BST suppliers
```

Assume Sustainability contains:

```text
Supplier Maturity: max 10
Eclipse: max 5
CO2 Emission: max 5
Total Sustainability KPI max: 20
```

Scorecard treatment:

```text
Supplier Maturity earned score included: no
Eclipse earned score included: no
CO2 earned score included: no
Sustainability max points included: no
```

Result:

```text
The Sustainability pillar should be excluded from the normalized denominator for
that BST supplier.
```

If the other applicable pillars are:

```text
Service Level: 40
Operational: 20
Value Creation: 20
```

Then the applicable pillar denominator becomes:

```text
40 + 20 + 20 = 80
```

Not:

```text
100
```

So the normalized score is calculated over the applicable 80 points only. The
supplier is not penalized for Sustainability because the KPI group truly does
not apply.

## Quick Comparison

| Scenario | Earned Score | Coverage Denominator | Coverage Impact |
| --- | ---: | ---: | --- |
| Valid KPI data | Calculated value | Included | Counts as available |
| Blank but applicable | Not scored | Included | Reduces coverage |
| KPI not available in system | Not included by default | Excluded by default | No impact by default |
| Source says `Not Applicable` | Not included | Excluded | No impact |
| Category-level not applicable | Not included | Excluded | No impact |

## Practical Business Rule

```text
Do not punish a supplier for a KPI that truly does not apply.
Show missing expected KPI data through coverage.
```
