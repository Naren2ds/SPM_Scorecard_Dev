// ---------------------------------------------------------------------------
// Supplier Maturity Score — scoring engine
// Same math as Supplier Compliance:
//   1) Parse the maturity score (stored in [0, 1] by backend)
//   2) Rank within cohort → percentile (Rank 1 = highest score = best)
//   3) Attainment: (score - floor) / (target - floor), clamped 0..1
//   4) Earned Score (Strict or Soft Stretch)
//   5) Rollups by Parent / Zone / Category using SIMPLE AVERAGE → Proxy
// ---------------------------------------------------------------------------

import type {
  MaturityAssessmentRow,
  MaturityConfig,
  MaturityFormulaMode,
  MaturityPercentileRank,
  MaturityRollupLevel,
  MaturityScoreStatus,
  RollupMaturityRow,
  ScoredMaturityRow,
  SupplierMaturityInputRow,
} from "./types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const dim = (value: string, fallback: string) =>
  (value ?? "").trim() || fallback;

const parseMaturity = (
  value: string,
): { value: number | null; error: string | null } => {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, error: null };
  const cleaned = raw.replace(/,/g, "").replace("%", "").trim();
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return { value: null, error: `Maturity score "${raw}" is not numeric.` };
  }
  if (parsed < 0) {
    return { value: null, error: "Maturity score is below 0." };
  }
  // Values in [0, 1] pass through, values in (1, 100] treated as %.
  if (parsed <= 1) return { value: parsed, error: null };
  if (parsed <= 100) return { value: parsed / 100, error: null };
  return { value: null, error: "Maturity score is above 100." };
};

// ─── Config validation ─────────────────────────────────────────────────────

export function validateConfig(config: MaturityConfig): string[] {
  const errors: string[] = [];

  if (!Number.isFinite(config.maxScore) || config.maxScore <= 0) {
    errors.push("Max Score must be greater than 0.");
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
  return errors;
}

// ─── Convert input rows → typed assessment rows ────────────────────────────

const toAssessmentRow = (
  row: SupplierMaturityInputRow,
  index: number,
): MaturityAssessmentRow => {
  const parsed = parseMaturity(row.maturityScore);
  const errors = parsed.error ? [parsed.error] : [];
  return {
    id: row.id || `supplier-${index}`,
    supplier: dim(row.supplier, `Supplier ${index + 1}`),
    parentSupplier: dim(row.parentSupplier, "Unassigned parent"),
    zone: dim(row.zone, "Unassigned zone"),
    category: dim(row.category, "Unassigned category"),
    isApplicable: row.kpiApplicability !== "Not Applicable",
    maturityScore: parsed.value,
    errors,
  };
};

// ─── Scoring math ──────────────────────────────────────────────────────────

export function calculatePercentileRanks(
  rows: Array<{ id: string; value: number }>,
  target: number,
): Map<string, MaturityPercentileRank> {
  const result = new Map<string, MaturityPercentileRank>();
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
  score: number,
  criticalFloor: number,
  target: number,
): number {
  if (score < criticalFloor) return 0;
  if (score >= target) return 1;
  if (target === criticalFloor) return 0;
  return clamp((score - criticalFloor) / (target - criticalFloor), 0, 1);
}

export function calculateMaturityEarnedScore(
  maxScore: number,
  percentile: number,
  attainmentFactor: number,
  formulaMode: MaturityFormulaMode,
): number {
  return formulaMode === "softStretch"
    ? maxScore * attainmentFactor * (0.7 + 0.3 * percentile)
    : maxScore * percentile * attainmentFactor;
}

// ─── Row scoring orchestration ─────────────────────────────────────────────

const cohortKeyForRow = (row: MaturityAssessmentRow, config: MaturityConfig) => {
  if (config.cohortLevel === "Parent") return row.parentSupplier;
  if (config.cohortLevel === "Zone") return row.zone;
  if (config.cohortLevel === "Category") return row.category;
  return "All suppliers";
};

const invalidBaseScore = (
  row: MaturityAssessmentRow,
  config: MaturityConfig,
  status: MaturityScoreStatus,
  explanation: string,
  cohortKey = "Excluded",
): ScoredMaturityRow => ({
  ...row,
  cohortKey,
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
  score: number,
  rank: MaturityPercentileRank,
  attainmentFactor: number,
  earnedScore: number,
  config: MaturityConfig,
): { status: MaturityScoreStatus; explanation: string } => {
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
  const belowFloor = score < config.criticalFloor || attainmentFactor === 0;
  const formulaZero = earnedScore === 0;

  if (rank.note === "single") {
    messages.push("Single observation: percentile set to 100% by rule.");
  }
  if (rank.note === "noVariance") {
    messages.push("No variance: all suppliers have identical maturity scores.");
  }

  if (belowFloor) {
    messages.push("Below critical floor: maturity score too low, earned score set to 0.");
  } else if (formulaZero) {
    messages.push("Zero score: strict formula produces 0 because percentile component is 0.");
  } else if (score >= config.target) {
    messages.push("Valid: maturity score is at or above target and percentile-adjusted.");
  } else {
    messages.push("Valid: maturity score between floor and target — attainment is proportional.");
  }

  if (config.formulaMode === "softStretch" && !belowFloor) {
    messages.push(
      "Softer percentile stretch applied: 70% of the attainment-adjusted score is protected, 30% is differentiated by percentile.",
    );
  }
  messages.push(formulaMessage);

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
  assessmentRows: MaturityAssessmentRow[],
  config: MaturityConfig,
): ScoredMaturityRow[] {
  const groupedRows = new Map<string, MaturityAssessmentRow[]>();

  assessmentRows.forEach((row) => {
    if (!row.isApplicable) return;
    if (row.errors.length > 0) return;
    if (row.maturityScore === null) return;
    const cohortKey = cohortKeyForRow(row, config);
    const group = groupedRows.get(cohortKey) ?? [];
    group.push(row);
    groupedRows.set(cohortKey, group);
  });

  const rankLookup = new Map<string, MaturityPercentileRank>();
  groupedRows.forEach((group) => {
    const ranks = calculatePercentileRanks(
      group.map((row) => ({ id: row.id, value: row.maturityScore ?? 0 })),
      config.target,
    );
    ranks.forEach((rank, id) => rankLookup.set(id, rank));
  });

  return assessmentRows.map((row) => {
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
    if (row.errors.length > 0) {
      return invalidBaseScore(
        row,
        config,
        "Invalid Data",
        row.errors.join(" "),
        cohortKey,
      );
    }
    if (row.maturityScore === null) {
      return invalidBaseScore(
        row,
        config,
        "Missing Score",
        "Missing Score: applicable supplier with no usable maturity score.",
        cohortKey,
      );
    }

    const rank = rankLookup.get(row.id);
    const percentile = rank?.percentile ?? null;
    const attainmentFactor = calculateAttainmentFactor(
      row.maturityScore,
      config.criticalFloor,
      config.target,
    );
    const earnedScore =
      percentile === null
        ? null
        : calculateMaturityEarnedScore(
            config.maxScore,
            percentile,
            attainmentFactor,
            config.formulaMode,
          );
    const narrative =
      rank && earnedScore !== null
        ? scoreNarrative(
            row.maturityScore,
            rank,
            attainmentFactor,
            earnedScore,
            config,
          )
        : {
            status: "Missing Score" as MaturityScoreStatus,
            explanation: "Unable to calculate percentile for this row.",
          };

    return {
      ...row,
      cohortKey,
      rankDescending: rank?.rank ?? null,
      percentile,
      criticalFloor: config.criticalFloor,
      target: config.target,
      attainmentFactor,
      formulaMode: config.formulaMode,
      maxScore: config.maxScore,
      earnedScore,
      scorePercent:
        earnedScore === null ? null : earnedScore / config.maxScore,
      scoreStatus: narrative.status,
      explanation: narrative.explanation,
    };
  });
}

// ─── Public API — supplier-level + rollups ─────────────────────────────────

export function calculateSupplierScores(
  rows: SupplierMaturityInputRow[],
  config: MaturityConfig,
): ScoredMaturityRow[] {
  const assessments = rows.map((r, i) => toAssessmentRow(r, i));
  return scoreAssessmentRows(assessments, config);
}

/**
 * Rollup: group supplier-level scored rows, then AVERAGE the maturity score.
 * Flagged as "Proxy Calculation" per the sibling KPI spec.
 */
const rollupRows = (
  supplierRows: ScoredMaturityRow[],
  level: MaturityRollupLevel,
  config: MaturityConfig,
): RollupMaturityRow[] => {
  const groups = new Map<string, ScoredMaturityRow[]>();
  supplierRows.forEach((row) => {
    const key =
      level === "Parent"
        ? row.parentSupplier
        : level === "Zone"
          ? row.zone
          : row.category;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });

  const rollupAssessments: MaturityAssessmentRow[] = Array.from(
    groups.entries(),
  ).map(([label, groupRows], index) => {
    const contributing = groupRows.filter(
      (r) =>
        r.scoreStatus !== "Not Applicable" &&
        r.scoreStatus !== "Invalid Data" &&
        r.scoreStatus !== "Missing Score" &&
        r.maturityScore !== null,
    );
    const avg =
      contributing.length === 0
        ? null
        : contributing.reduce((sum, r) => sum + (r.maturityScore ?? 0), 0) /
          contributing.length;

    return {
      id: `${level.toLowerCase()}-${index}-${label}`,
      supplier: "All suppliers",
      parentSupplier: level === "Parent" ? label : "All parents",
      zone: level === "Zone" ? label : "All zones",
      category: level === "Category" ? label : "All categories",
      isApplicable: contributing.length > 0,
      maturityScore: avg,
      errors: [],
    };
  });

  return scoreAssessmentRows(rollupAssessments, {
    ...config,
    cohortLevel: "Supplier",
  }).map((row) => {
    const label =
      level === "Parent"
        ? row.parentSupplier
        : level === "Zone"
          ? row.zone
          : row.category;
    const isValid = row.scoreStatus === "Valid";
    return {
      ...row,
      scoreStatus: isValid
        ? ("Proxy Calculation" as MaturityScoreStatus)
        : row.scoreStatus,
      explanation: isValid
        ? `${row.explanation} Proxy Calculation: rollup maturity score is the simple average of contributing suppliers.`
        : row.explanation,
      level,
      label,
      contributingSuppliers: groups.get(label)?.length ?? 0,
      aggregationMethod: "Proxy average" as const,
    };
  });
};

export function calculateParentRollup(
  rows: SupplierMaturityInputRow[],
  config: MaturityConfig,
): RollupMaturityRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Parent", config);
}

export function calculateZoneRollup(
  rows: SupplierMaturityInputRow[],
  config: MaturityConfig,
): RollupMaturityRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Zone", config);
}

export function calculateCategoryRollup(
  rows: SupplierMaturityInputRow[],
  config: MaturityConfig,
): RollupMaturityRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Category", config);
}

export const formulaModeLabel = (mode: MaturityConfig["formulaMode"]) =>
  mode === "softStretch" ? "Soft Stretch (official)" : "Soft Stretch (official)";

// ─── CSV export helper ─────────────────────────────────────────────────────

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
