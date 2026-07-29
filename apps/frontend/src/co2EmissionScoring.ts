// ---------------------------------------------------------------------------
// CO2 Emission KPI — scoring engine
// Same structural pattern as Supplier Compliance scoring, but:
//   - Value is an absolute tonnes CO2e number (no [0, 1] normalisation).
//   - Higher value = better (CO2 Reduction Potential).
//   - Floor / Target default to Q1 / Q3 of the filtered rows.
// Flow:
//   1) Parse the direct CO2 tonnes value per supplier
//   2) Rank within cohort → percentile (Rank 1 = highest value)
//   3) Attainment factor: (value - floor) / (target - floor), clamped 0..1
//   4) Earned Score (Strict or Soft Stretch), identical to Compliance
//   5) Roll up Parent / Zone using SIMPLE AVERAGE → "Proxy Calculation"
// ---------------------------------------------------------------------------

import type {
  Co2AssessmentRow,
  Co2Config,
  Co2FormulaMode,
  Co2PercentileRank,
  Co2RollupLevel,
  Co2ScoreStatus,
  Co2EmissionInputRow,
  RollupCo2Row,
  ScoredCo2Row,
} from "./co2EmissionTypes";

// ─── Helpers ────────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const dim = (value: string, fallback: string) =>
  (value ?? "").trim() || fallback;

const parseCo2 = (
  value: string,
): { value: number | null; error: string | null } => {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, error: null };
  const cleaned = raw.replace(/,/g, "").trim();
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return { value: null, error: `CO2 value "${raw}" is not numeric.` };
  }
  if (parsed < 0) {
    return { value: null, error: "CO2 value is below 0." };
  }
  return { value: parsed, error: null };
};

// ─── Quartile helpers (used to seed Critical Floor / Target defaults) ──────

/** Linear-interpolation percentile (matches numpy default "linear"). */
export function percentileOf(values: number[], p: number): number | null {
  const clean = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  const rank = p * (clean.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return clean[lo];
  const frac = rank - lo;
  return clean[lo] + (clean[hi] - clean[lo]) * frac;
}

/**
 * Compute Q1 (25th percentile) and Q3 (75th percentile) from the numeric
 * CO2 values of the applicable rows. Returns nulls if no valid values.
 */
export function computeQuartileDefaults(
  rows: Co2EmissionInputRow[],
): { q1: number | null; q3: number | null } {
  const values: number[] = [];
  rows.forEach((r) => {
    if (r.kpiApplicability === "Not Applicable") return;
    const parsed = parseCo2(r.co2Emission);
    if (parsed.value !== null) values.push(parsed.value);
  });
  return {
    q1: percentileOf(values, 0.25),
    q3: percentileOf(values, 0.75),
  };
}

// ─── Config validation ─────────────────────────────────────────────────────

export function validateConfig(config: Co2Config): string[] {
  const errors: string[] = [];

  if (!Number.isFinite(config.maxScore) || config.maxScore <= 0) {
    errors.push("Max Score must be greater than 0.");
  }
  if (!Number.isFinite(config.criticalFloor) || config.criticalFloor < 0) {
    errors.push("Critical Floor must be a non-negative number.");
  }
  if (!Number.isFinite(config.target) || config.target < 0) {
    errors.push("Target must be a non-negative number.");
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
  row: Co2EmissionInputRow,
  index: number,
): Co2AssessmentRow => {
  const parsed = parseCo2(row.co2Emission);
  const errors = parsed.error ? [parsed.error] : [];
  return {
    id: row.id || `supplier-${index}`,
    supplier: dim(row.supplier, `Supplier ${index + 1}`),
    parentSupplier: dim(row.parentSupplier, "Unassigned parent"),
    zone: dim(row.zone, "Unassigned zone"),
    category: dim(row.category, "Unassigned category"),
    isApplicable: row.kpiApplicability !== "Not Applicable",
    co2Emission: parsed.value,
    errors,
  };
};

// ─── Scoring math ──────────────────────────────────────────────────────────

export function calculatePercentileRanks(
  rows: Array<{ id: string; value: number }>,
  target: number,
): Map<string, Co2PercentileRank> {
  const result = new Map<string, Co2PercentileRank>();
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

  // Sort descending: highest CO2 value = Rank 1 = best.
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
  value: number,
  criticalFloor: number,
  target: number,
): number {
  if (value < criticalFloor) return 0;
  if (value >= target) return 1;
  if (target === criticalFloor) return 0;
  return clamp((value - criticalFloor) / (target - criticalFloor), 0, 1);
}

export function calculateCo2EarnedScore(
  maxScore: number,
  percentile: number,
  attainmentFactor: number,
  formulaMode: Co2FormulaMode,
): number {
  return formulaMode === "softStretch"
    ? maxScore * attainmentFactor * (0.7 + 0.3 * percentile)
    : maxScore * percentile * attainmentFactor;
}

// ─── Row scoring orchestration ─────────────────────────────────────────────

const cohortKeyForRow = (row: Co2AssessmentRow, config: Co2Config) => {
  if (config.cohortLevel === "Parent") return row.parentSupplier;
  if (config.cohortLevel === "Zone") return row.zone;
  return "All suppliers";
};

const invalidBaseScore = (
  row: Co2AssessmentRow,
  config: Co2Config,
  status: Co2ScoreStatus,
  explanation: string,
  cohortKey = "Excluded",
): ScoredCo2Row => ({
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
  value: number,
  rank: Co2PercentileRank,
  attainmentFactor: number,
  earnedScore: number,
  config: Co2Config,
): { status: Co2ScoreStatus; explanation: string } => {
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
  const belowFloor = value < config.criticalFloor || attainmentFactor === 0;
  const formulaZero = earnedScore === 0;

  if (rank.note === "single") {
    messages.push("Single observation: percentile set to 100% by rule.");
  }
  if (rank.note === "noVariance") {
    messages.push("No variance: all suppliers have identical CO2 values.");
  }

  if (belowFloor) {
    messages.push("Below critical floor: CO2 value too low, earned score set to 0.");
  } else if (formulaZero) {
    messages.push("Zero score: strict formula produces 0 because percentile component is 0.");
  } else if (value >= config.target) {
    messages.push("Valid: CO2 value is at or above target and percentile-adjusted.");
  } else {
    messages.push("Valid: CO2 value between floor and target — attainment is proportional.");
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
  assessmentRows: Co2AssessmentRow[],
  config: Co2Config,
): ScoredCo2Row[] {
  const groupedRows = new Map<string, Co2AssessmentRow[]>();

  assessmentRows.forEach((row) => {
    if (!row.isApplicable) return;
    if (row.errors.length > 0) return;
    if (row.co2Emission === null) return;
    const cohortKey = cohortKeyForRow(row, config);
    const group = groupedRows.get(cohortKey) ?? [];
    group.push(row);
    groupedRows.set(cohortKey, group);
  });

  const rankLookup = new Map<string, Co2PercentileRank>();
  groupedRows.forEach((group) => {
    const ranks = calculatePercentileRanks(
      group.map((row) => ({ id: row.id, value: row.co2Emission ?? 0 })),
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
    if (row.co2Emission === null) {
      return invalidBaseScore(
        row,
        config,
        "Missing Value",
        "Missing Value: applicable supplier with no usable CO2 data.",
        cohortKey,
      );
    }

    const rank = rankLookup.get(row.id);
    const percentile = rank?.percentile ?? null;
    const attainmentFactor = calculateAttainmentFactor(
      row.co2Emission,
      config.criticalFloor,
      config.target,
    );
    const earnedScore =
      percentile === null
        ? null
        : calculateCo2EarnedScore(
            config.maxScore,
            percentile,
            attainmentFactor,
            config.formulaMode,
          );
    const narrative =
      rank && earnedScore !== null
        ? scoreNarrative(
            row.co2Emission,
            rank,
            attainmentFactor,
            earnedScore,
            config,
          )
        : {
            status: "Missing Value" as Co2ScoreStatus,
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
  rows: Co2EmissionInputRow[],
  config: Co2Config,
): ScoredCo2Row[] {
  const assessments = rows.map((r, i) => toAssessmentRow(r, i));
  return scoreAssessmentRows(assessments, config);
}

/**
 * Rollup: group supplier-level scored rows, then AVERAGE the CO2 value.
 * Marked as "Proxy Calculation" per the scoring spec.
 */
const rollupRows = (
  supplierRows: ScoredCo2Row[],
  level: Co2RollupLevel,
  config: Co2Config,
): RollupCo2Row[] => {
  const groups = new Map<string, ScoredCo2Row[]>();
  supplierRows.forEach((row) => {
    const key = level === "Parent" ? row.parentSupplier : row.zone;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });

  const rollupAssessments: Co2AssessmentRow[] = Array.from(
    groups.entries(),
  ).map(([label, groupRows], index) => {
    const contributing = groupRows.filter(
      (r) =>
        r.scoreStatus !== "Not Applicable" &&
        r.scoreStatus !== "Invalid Data" &&
        r.scoreStatus !== "Missing Value" &&
        r.co2Emission !== null,
    );
    const avg =
      contributing.length === 0
        ? null
        : contributing.reduce((sum, r) => sum + (r.co2Emission ?? 0), 0) /
          contributing.length;

    return {
      id: `${level.toLowerCase()}-${index}-${label}`,
      supplier: "All suppliers",
      parentSupplier: level === "Parent" ? label : "All parents",
      zone: level === "Zone" ? label : "All zones",
      category: "All categories",
      isApplicable: contributing.length > 0,
      co2Emission: avg,
      errors: [],
    };
  });

  return scoreAssessmentRows(rollupAssessments, {
    ...config,
    cohortLevel: "Supplier",
  }).map((row) => {
    const label = level === "Parent" ? row.parentSupplier : row.zone;
    const isValid = row.scoreStatus === "Valid";
    return {
      ...row,
      scoreStatus: isValid
        ? ("Proxy Calculation" as Co2ScoreStatus)
        : row.scoreStatus,
      explanation: isValid
        ? `${row.explanation} Proxy Calculation: rollup CO2 value is the simple average of contributing suppliers.`
        : row.explanation,
      level,
      label,
      contributingSuppliers: groups.get(label)?.length ?? 0,
      aggregationMethod: "Proxy average" as const,
    };
  });
};

export function calculateParentRollup(
  rows: Co2EmissionInputRow[],
  config: Co2Config,
): RollupCo2Row[] {
  return rollupRows(calculateSupplierScores(rows, config), "Parent", config);
}

export function calculateZoneRollup(
  rows: Co2EmissionInputRow[],
  config: Co2Config,
): RollupCo2Row[] {
  return rollupRows(calculateSupplierScores(rows, config), "Zone", config);
}

export const formulaModeLabel = (mode: Co2Config["formulaMode"]) =>
  mode === "softStretch"
    ? "Softer Percentile Stretch"
    : "Strict Percentile x Attainment";

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
