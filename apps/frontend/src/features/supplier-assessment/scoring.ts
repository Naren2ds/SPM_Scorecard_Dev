// ---------------------------------------------------------------------------
// Supplier Assessment (Quality) — scoring engine
// Implements the flow described in
// docs/Support_Docs/supplier-assessment-percentile-scoring.md:
//   1) Convert incoming pre-aggregated rows to typed counts
//   2) Compute Assessment Health Index (weighted average)
//   3) Rank within cohort → percentile
//   4) Apply attainment factor against floor / target
//   5) Combine into Earned Score (Strict or Soft Stretch)
//   6) Optional Red Guardrail Cap at 50 % of max score
//   7) Roll up by Zone / Parent / Category / Country by summing counts, then
//      re-scoring against the new peer set.
// ---------------------------------------------------------------------------

import type {
  AssessmentConfig,
  AssessmentCountRow,
  AssessmentCounts,
  AssessmentPercentileRank,
  AssessmentRollupLevel,
  AssessmentScoreStatus,
  RollupAssessmentRow,
  ScoredAssessmentRow,
  SupplierAssessmentInputRow,
} from "./types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const parseCount = (value: string): number => {
  const cleaned = String(value ?? "").replace(/,/g, "").trim();
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const blankCounts = (): AssessmentCounts => ({
  greenCount: 0,
  yellowCount: 0,
  redCount: 0,
  naCount: 0,
  blankCount: 0,
  totalValidAssessments: 0,
});

const addCounts = (
  left: AssessmentCounts,
  right: AssessmentCounts,
): AssessmentCounts => {
  const greenCount = left.greenCount + right.greenCount;
  const yellowCount = left.yellowCount + right.yellowCount;
  const redCount = left.redCount + right.redCount;
  return {
    greenCount,
    yellowCount,
    redCount,
    naCount: left.naCount + right.naCount,
    blankCount: left.blankCount + right.blankCount,
    totalValidAssessments: greenCount + yellowCount + redCount,
  };
};

const dim = (value: string, fallback: string) =>
  (value ?? "").trim() || fallback;

const firstText = (values: string[], fallback: string) =>
  values.map((v) => v.trim()).find(Boolean) ?? fallback;

// ─── Config validation ─────────────────────────────────────────────────────

export function validateConfig(config: AssessmentConfig): string[] {
  const errors: string[] = [];

  if (!Number.isFinite(config.maxScore) || config.maxScore <= 0) {
    errors.push("Max Score must be greater than 0.");
  }
  if (
    !Number.isFinite(config.greenWeight) ||
    !Number.isFinite(config.yellowWeight) ||
    !Number.isFinite(config.redWeight)
  ) {
    errors.push("Green, Yellow, and Red weights must be numeric.");
  }
  if (config.greenWeight <= config.yellowWeight) {
    errors.push("Green Weight must be greater than Yellow Weight.");
  }
  if (config.yellowWeight <= config.redWeight) {
    errors.push("Yellow Weight must be greater than Red Weight.");
  }
  if (config.redWeight < 0) {
    errors.push("Red Weight must be greater than or equal to 0.");
  }
  if (config.greenWeight > 1) {
    errors.push("Green Weight must be less than or equal to 1.");
  }
  if (
    !Number.isFinite(config.criticalFloor) ||
    config.criticalFloor < 0 ||
    config.criticalFloor > 1
  ) {
    errors.push("Critical Floor must be between 0% and 100%.");
  }
  if (
    !Number.isFinite(config.target) ||
    config.target < 0 ||
    config.target > 1
  ) {
    errors.push("Target must be between 0% and 100%.");
  }
  if (
    Number.isFinite(config.criticalFloor) &&
    Number.isFinite(config.target) &&
    config.criticalFloor >= config.target
  ) {
    errors.push("Critical Floor must be less than Target.");
  }
  if (
    !Number.isFinite(config.redWarningThreshold) ||
    config.redWarningThreshold < 0 ||
    config.redWarningThreshold > 1
  ) {
    errors.push("Red Warning Threshold must be between 0% and 100%.");
  }
  if (
    !Number.isFinite(config.redCapThreshold) ||
    config.redCapThreshold < 0 ||
    config.redCapThreshold > 1
  ) {
    errors.push("Red Cap Threshold must be between 0% and 100%.");
  }
  return errors;
}

// ─── Convert input rows → typed count rows ─────────────────────────────────

const toCountRow = (
  row: SupplierAssessmentInputRow,
  index: number,
): AssessmentCountRow => {
  const greenCount = parseCount(row.greenCount);
  const yellowCount = parseCount(row.yellowCount);
  const redCount = parseCount(row.redCount);
  const naCount = parseCount(row.naCount);
  const blankCount = parseCount(row.blankCount);
  return {
    id: row.id || `supplier-${index}`,
    supplier: dim(row.supplier, `Supplier ${index + 1}`),
    parentSupplier: dim(row.parentSupplier, "Unassigned parent"),
    zone: dim(row.zone, "Unassigned zone"),
    country: dim(row.country, "Unassigned country"),
    category: dim(row.category, "Unassigned category"),
    scorecard_category: dim(row.scorecard_category, "Unassigned scorecard category"),
    supplierApprovalStatus: (row.supplierApprovalStatus ?? "").trim(),
    isApplicable: row.kpiApplicability !== "Not Applicable",
    greenCount,
    yellowCount,
    redCount,
    naCount,
    blankCount,
    totalValidAssessments: greenCount + yellowCount + redCount,
  };
};

// ─── Scoring math ──────────────────────────────────────────────────────────

export function calculateAssessmentHealthIndex(
  counts: AssessmentCounts,
  config: AssessmentConfig,
): number | null {
  if (counts.totalValidAssessments <= 0) return null;
  return (
    (counts.greenCount * config.greenWeight +
      counts.yellowCount * config.yellowWeight +
      counts.redCount * config.redWeight) /
    counts.totalValidAssessments
  );
}

export function calculatePercentileRanks(
  rows: Array<{ id: string; value: number }>,
  target: number,
): Map<string, AssessmentPercentileRank> {
  const result = new Map<string, AssessmentPercentileRank>();
  const validRows = rows.filter((r) => Number.isFinite(r.value));
  const count = validRows.length;

  if (count === 0) return result;
  if (count === 1) {
    result.set(validRows[0].id, { rank: 1, percentile: 1, note: "single" });
    return result;
  }

  const distinctValues = new Set(validRows.map((r) => r.value.toFixed(12)));
  if (distinctValues.size === 1) {
    const percentile = validRows[0].value >= target ? 1 : 0.5;
    const rank = (count + 1) / 2;
    validRows.forEach((r) => {
      result.set(r.id, { rank, percentile, note: "noVariance" });
    });
    return result;
  }

  const sorted = [...validRows].sort((a, b) => b.value - a.value);
  let cursor = 0;
  while (cursor < sorted.length) {
    const valueKey = sorted[cursor].value.toFixed(12);
    let end = cursor + 1;
    while (end < sorted.length && sorted[end].value.toFixed(12) === valueKey) {
      end += 1;
    }
    const rank = (cursor + 1 + end) / 2;
    const percentile = (count - rank) / (count - 1);
    for (let i = cursor; i < end; i += 1) {
      result.set(sorted[i].id, { rank, percentile, note: "standard" });
    }
    cursor = end;
  }
  return result;
}

export function calculateAttainmentFactor(
  healthIndex: number,
  criticalFloor: number,
  target: number,
): number {
  if (healthIndex < criticalFloor) return 0;
  if (healthIndex >= target) return 1;
  return clamp(
    (healthIndex - criticalFloor) / (target - criticalFloor),
    0,
    1,
  );
}

export function calculateAssessmentEarnedScore(
  maxScore: number,
  percentile: number,
  attainmentFactor: number,
  config: AssessmentConfig,
  redPercent: number | null,
): { earnedScore: number; capped: boolean } {
  const baseScore =
    config.formulaMode === "softStretch"
      ? maxScore * attainmentFactor * (0.7 + 0.3 * percentile)
      : maxScore * percentile * attainmentFactor;
  const cap = maxScore * 0.5;

  if (
    config.capScoreIfRedExceedsThreshold &&
    redPercent !== null &&
    redPercent >= config.redCapThreshold &&
    baseScore > cap
  ) {
    return { earnedScore: cap, capped: true };
  }
  return { earnedScore: baseScore, capped: false };
}

// ─── Row scoring orchestration ─────────────────────────────────────────────

const cohortKeyForRow = (
  row: AssessmentCountRow,
  _config: AssessmentConfig,
) => row.scorecard_category;

const dominantScorecardCategory = (rows: Array<{ scorecard_category: string }>) => {
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.scorecard_category, (counts.get(row.scorecard_category) ?? 0) + 1));
  const topCount = Math.max(0, ...counts.values());
  return [...counts.entries()]
    .filter(([, count]) => count === topCount)
    .map(([value]) => value)
    .sort()[0] ?? "Unassigned scorecard category";
};

const invalidBaseScore = (
  row: AssessmentCountRow,
  config: AssessmentConfig,
  status: AssessmentScoreStatus,
  explanation: string,
  cohortKey = "Excluded",
): ScoredAssessmentRow => ({
  ...row,
  cohortKey,
  assessmentHealthIndex: null,
  redPercent: null,
  rankDescending: null,
  percentile: null,
  criticalFloor: config.criticalFloor,
  target: config.target,
  attainmentFactor: null,
  formulaMode: config.formulaMode,
  maxScore: config.maxScore,
  earnedScore: null,
  scorePercent: null,
  scoreStatus: status,
  explanation,
});

const scoreNarrative = (
  row: AssessmentCountRow,
  healthIndex: number,
  redPercent: number,
  rank: AssessmentPercentileRank,
  attainmentFactor: number,
  earnedScore: number,
  capped: boolean,
  config: AssessmentConfig,
): { status: AssessmentScoreStatus; explanation: string } => {
  const messages: string[] = [];
  const percentile = rank.percentile;
  const formulaMessage =
    config.formulaMode === "softStretch"
      ? `Earned Score = ${config.maxScore.toFixed(2)} x ${attainmentFactor.toFixed(
          4,
        )} x (70% + 30% x ${(percentile * 100).toFixed(2)}%) = ${earnedScore.toFixed(2)}.`
      : `Earned Score = ${config.maxScore.toFixed(2)} x ${(percentile * 100).toFixed(
          2,
        )}% x ${attainmentFactor.toFixed(4)} = ${earnedScore.toFixed(2)}.`;
  const belowFloor = healthIndex < config.criticalFloor || attainmentFactor === 0;
  const formulaZero = earnedScore === 0;

  if (rank.note === "single") messages.push("Single observation: percentile set to 100% by rule.");
  if (rank.note === "noVariance")
    messages.push("No variance: all suppliers have same assessment health.");

  if (belowFloor) {
    messages.push("Below critical floor: assessment health too low, earned score set to 0.");
  } else if (formulaZero) {
    messages.push("Zero score: strict formula produces 0 because percentile component is 0.");
  } else if (healthIndex >= config.target) {
    messages.push("Valid: Health Index above target and percentile-adjusted.");
  } else {
    messages.push("Valid: Health Index between floor and target, attainment is proportional.");
  }

  if (config.formulaMode === "softStretch" && !belowFloor) {
    messages.push(
      "Softer percentile stretch applied: 70% of the attainment-adjusted score is protected, and 30% is differentiated by percentile.",
    );
  }
  messages.push(formulaMessage);
  if (redPercent >= config.redWarningThreshold && row.redCount > 0) {
    messages.push("Red exposure warning: supplier has Red assessments.");
  }
  if (capped) {
    messages.push("Red guardrail cap applied: earned score capped at 50% of Max Score.");
  }
  if (row.naCount > 0 || row.blankCount > 0) {
    messages.push("N/A and blank assessments are excluded from the valid denominator.");
  }

  if (belowFloor || formulaZero) {
    return { status: "Zero Score", explanation: messages.join(" ") };
  }
  if (rank.note === "single") {
    return { status: "Single Observation", explanation: messages.join(" ") };
  }
  if (rank.note === "noVariance") {
    return { status: "No Variance", explanation: messages.join(" ") };
  }
  return { status: "Valid", explanation: messages.join(" ") };
};

export function scoreAssessmentRows(
  countRows: AssessmentCountRow[],
  config: AssessmentConfig,
): ScoredAssessmentRow[] {
  const healthById = new Map<string, number>();
  const groupedRows = new Map<string, AssessmentCountRow[]>();

  countRows.forEach((row) => {
    if (!row.isApplicable) return;
    const healthIndex = calculateAssessmentHealthIndex(row, config);
    if (healthIndex === null) return;
    healthById.set(row.id, healthIndex);
    const cohortKey = cohortKeyForRow(row, config);
    const group = groupedRows.get(cohortKey) ?? [];
    group.push(row);
    groupedRows.set(cohortKey, group);
  });

  const rankLookup = new Map<string, AssessmentPercentileRank>();
  groupedRows.forEach((group) => {
    const ranks = calculatePercentileRanks(
      group.map((row) => ({ id: row.id, value: healthById.get(row.id) ?? 0 })),
      config.target,
    );
    ranks.forEach((rank, id) => rankLookup.set(id, rank));
  });

  return countRows.map((row) => {
    const cohortKey = cohortKeyForRow(row, config);
    if (!row.isApplicable) {
      return invalidBaseScore(
        row,
        config,
        "Not Applicable",
        "Not Applicable: excluded from ranking and earned score.",
        cohortKey,
      );
    }

    const healthIndex = healthById.get(row.id) ?? null;
    if (healthIndex === null) {
      const hasOnlyBlank = row.blankCount > 0 && row.naCount === 0;
      return invalidBaseScore(
        row,
        config,
        hasOnlyBlank ? "Missing Assessment" : "No Valid Assessment",
        hasOnlyBlank
          ? "Missing Assessment: supplier has no rating value available."
          : "Only N/A / blank values found: no valid assessment score.",
        cohortKey,
      );
    }

    const rank = rankLookup.get(row.id);
    const percentile = rank?.percentile ?? null;
    const redPercent =
      row.totalValidAssessments > 0
        ? row.redCount / row.totalValidAssessments
        : null;
    const attainmentFactor = calculateAttainmentFactor(
      healthIndex,
      config.criticalFloor,
      config.target,
    );
    const earned =
      percentile === null
        ? { earnedScore: null as number | null, capped: false }
        : calculateAssessmentEarnedScore(
            config.maxScore,
            percentile,
            attainmentFactor,
            config,
            redPercent,
          );
    const narrative =
      rank && earned.earnedScore !== null && redPercent !== null
        ? scoreNarrative(
            row,
            healthIndex,
            redPercent,
            rank,
            attainmentFactor,
            earned.earnedScore,
            earned.capped,
            config,
          )
        : {
            status: "No Valid Assessment" as AssessmentScoreStatus,
            explanation: "Unable to calculate percentile for this row.",
          };

    return {
      ...row,
      cohortKey,
      assessmentHealthIndex: healthIndex,
      redPercent,
      rankDescending: rank?.rank ?? null,
      percentile,
      criticalFloor: config.criticalFloor,
      target: config.target,
      attainmentFactor,
      formulaMode: config.formulaMode,
      maxScore: config.maxScore,
      earnedScore: earned.earnedScore,
      scorePercent:
        earned.earnedScore === null ? null : earned.earnedScore / config.maxScore,
      scoreStatus: narrative.status,
      explanation: narrative.explanation,
    };
  });
}

// ─── Public API — supplier-level + rollups ─────────────────────────────────

export function calculateSupplierScores(
  rows: SupplierAssessmentInputRow[],
  config: AssessmentConfig,
): ScoredAssessmentRow[] {
  const countRows = rows.map((r, i) => toCountRow(r, i));
  return scoreAssessmentRows(countRows, config);
}

const rollupRows = (
  supplierRows: ScoredAssessmentRow[],
  level: AssessmentRollupLevel,
  config: AssessmentConfig,
): RollupAssessmentRow[] => {
  const groups = new Map<string, ScoredAssessmentRow[]>();
  supplierRows.forEach((row) => {
    const key =
      level === "Parent"
        ? row.parentSupplier
        : level === "Zone"
          ? row.zone
          : level === "Category"
            ? row.category
            : row.country;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });

  const countRows: AssessmentCountRow[] = Array.from(groups.entries()).map(
    ([label, groupRows], index) => {
      const contributing = groupRows.filter(
        (r) => r.scoreStatus !== "Not Applicable",
      );
      const aggregate = contributing.reduce<AssessmentCounts>(
        (acc, r) => addCounts(acc, r),
        blankCounts(),
      );
      return {
        id: `${level.toLowerCase()}-${index}-${label}`,
        supplier: "All suppliers",
        parentSupplier: level === "Parent" ? label : "All parents",
        zone: level === "Zone" ? label : "All zones",
        country: level === "Country" ? label : "All countries",
        category: level === "Category" ? label : "All categories",
        scorecard_category: dominantScorecardCategory(groupRows),
        supplierApprovalStatus: firstText(
          groupRows.map((r) => r.supplierApprovalStatus),
          "",
        ),
        isApplicable: contributing.length > 0,
        ...aggregate,
      };
    },
  );

  return scoreAssessmentRows(countRows, {
    ...config,
    cohortLevel: "Supplier",
  }).map((row) => {
    const label =
      level === "Parent"
        ? row.parentSupplier
        : level === "Zone"
          ? row.zone
          : level === "Category"
            ? row.category
            : row.country;
    return {
      ...row,
      level,
      label,
      contributingSuppliers: groups.get(label)?.length ?? 0,
    };
  });
};

export function calculateParentRollup(
  rows: SupplierAssessmentInputRow[],
  config: AssessmentConfig,
): RollupAssessmentRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Parent", config);
}

export function calculateZoneRollup(
  rows: SupplierAssessmentInputRow[],
  config: AssessmentConfig,
): RollupAssessmentRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Zone", config);
}

export function calculateCategoryRollup(
  rows: SupplierAssessmentInputRow[],
  config: AssessmentConfig,
): RollupAssessmentRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Category", config);
}

export function calculateCountryRollup(
  rows: SupplierAssessmentInputRow[],
  config: AssessmentConfig,
): RollupAssessmentRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Country", config);
}

export const formulaModeLabel = (mode: AssessmentConfig["formulaMode"]) =>
  mode === "softStretch" ? "Soft Stretch (official)" : "Soft Stretch (official)";

// ─── CSV export helper (reused from DOT) ───────────────────────────────────

const escapeCsvCell = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

export const toCsv = (
  rows: Array<Array<string | number | null | undefined>>,
) => rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
