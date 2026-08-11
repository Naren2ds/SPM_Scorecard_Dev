# SPM Category Scorecard Logic

This note explains how the scorecard calculation works when a parent supplier
appears in more than one SPM Category.

## 1. Current Business Rule

Some parent suppliers can have transactions across multiple SPM Categories.
For example, the same parent supplier may have rows under both `Ingredients`
and `Packaging`.

In the current scorecard logic, the KPI is still calculated at the parent
supplier level.

The calculation follows this rule:

```text
1. Use all eligible rows for the parent supplier to calculate the raw KPI value.
2. Identify the dominant SPM Category for that parent supplier and KPI.
3. Dominant SPM Category = the SPM Category with the highest number of rows.
4. If there is a tie, the first category alphabetically is selected.
5. Calculate percentile only within that dominant SPM Category cohort.
6. Use the same earned score formula as before.
```

Key point:

```text
Only the percentile comparison uses the dominant SPM Category.
The raw KPI value still includes all eligible rows for the parent supplier.
```

## 2. Sample DOT Calculation

Example parent supplier: `ABC Supplier`

```text
SPM Category      Rows   On-Time Lines   Delivered Lines
Ingredients       8      720             800
Packaging         2      140             200
```

Step 1: Calculate DOT using all eligible rows:

```text
Total On-Time Lines   = 720 + 140 = 860
Total Delivered Lines = 800 + 200 = 1000
DOT %                 = 860 / 1000 = 86.00%
```

Step 2: Identify dominant SPM Category:

```text
Ingredients = 8 rows
Packaging   = 2 rows

Dominant SPM Category = Ingredients
```

Step 3: Calculate percentile:

```text
ABC Supplier's DOT value of 86.00% is compared only against suppliers
whose dominant DOT SPM Category is Ingredients.
```

Step 4: Calculate earned score:

```text
earned = max_score * attainment * (0.70 + 0.30 * percentile)
```

The floor, target, attainment, max score, KPI weights, and pillar weights remain
unchanged.

## 3. Normalized Scorecard Impact

The same logic is applied independently for each KPI.

This means:

- A parent supplier can have one dominant SPM Category for DOT and a different
  dominant SPM Category for another KPI.
- Each KPI earned score is calculated first.
- The normalized scorecard then combines all applicable KPI earned scores into
  pillar scores and the final normalized score.
- The current logic does not create a separate normalized score for each
  `Parent Supplier + SPM Category` combination.
- The current logic does not exclude non-dominant SPM Category rows from the raw
  KPI calculation.

Business interpretation:

```text
The current normalized score is a parent-supplier-level score.
SPM Category is used to make percentile comparison fairer,
but the score is still calculated for the parent supplier overall.
```

## 4. Recommended Future Option

If Business wants a fully category-specific scorecard, the cleaner future model
would be:

```text
Parent Supplier + SPM Category
   -> calculate KPI raw value within that SPM Category only
   -> calculate percentile within that SPM Category only
   -> calculate earned KPI score
   -> produce normalized score by Parent Supplier + SPM Category
```

This would mean a supplier active in multiple SPM Categories can have separate
category-specific scorecard results, instead of one consolidated parent
supplier score.
