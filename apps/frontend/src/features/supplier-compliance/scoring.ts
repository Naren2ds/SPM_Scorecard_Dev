// ---------------------------------------------------------------------------
// Supplier Compliance % — scoring engine
// Implements the flow described in
// docs/Support_Docs/supplier-compliance-scoring.md:
//   1) Parse and validate the direct compliance % per supplier
//   2) Rank within cohort → percentile
//   3) Apply attainment factor against floor / target
//   4) Combine into Earned Score (Strict or Soft Stretch)
//   5) Roll up by Parent / Zone / Category / Country using SIMPLE AVERAGE
//      (backend only supplies direct %, no counts) — flagged as
//      "Proxy Calculation" per the scoring spec.
// ---------------------------------------------------------------------------

import type {
  ComplianceAssessmentRow,
  ComplianceConfig,
  CompliancePercentileRank,
  ComplianceRollupLevel,
  ComplianceScoreStatus,
  RollupComplianceRow,
  ScoredComplianceRow,
  SupplierComplianceInputRow,
} from "./types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const dim = (value: string, fallback: string) =>
  (value ?? "").trim() || fallback;

const firstText = (values: string[], fallback: string) =>
  values.map((v) => v.trim()).find(Boolean) ?? fallback;

const parseCompliance = (
  value: string,
): { value: number | null; error: string | null } => {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, error: null };
  const cleaned = raw.replace(/,/g, "").replace("%", "").trim();
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return { value: null, error: `Compliance value "${raw}" is not numeric.` };
  }
  if (parsed < 0) {
    return { value: null, error: "Compliance % is below 0." };
  }
  // Values in [0, 1] pass through, values in (1, 100] treated as %.
  if (parsed <= 1) return { value: parsed, error: null };
  if (parsed <= 100) return { value: parsed / 100, error: null };
  return { value: null, error: "Compliance % is above 100." };
};

// ─── Config validation ─────────────────────────────────────────────────────

export function validateConfig(config: ComplianceConfig): string[] {
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
  row: SupplierComplianceInputRow,
  index: number,
): ComplianceAssessmentRow => {
  const parsed = parseCompliance(row.compliancePct);
  const errors = parsed.error ? [parsed.error] : [];
  return {
    id: row.id || `supplier-${index}`,
    supplier: dim(row.supplier, `Supplier ${index + 1}`),
    parentSupplier: dim(row.parentSupplier, "Unassigned parent"),
    zone: dim(row.zone, "Unassigned zone"),
    country: dim(row.country, "Unassigned country"),
    category: dim(row.category, "Unassigned category"),
    supplierApprovalStatus: (row.supplierApprovalStatus ?? "").trim(),
    isApplicable: row.kpiApplicability !== "Not Applicable",
    compliancePct: parsed.value,
    errors,
  };
};

// ─── Scoring math ──────────────────────────────────────────────────────────

export function calculatePercentileRanks(
  rows: Array<{ id: string; value: number }>,
  target: number,
): Map<string, CompliancePercentileRank> {
  const result = new Map<string, CompliancePercentileRank>();
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
  compliance: number,
  criticalFloor: number,
  target: number,
): number {
  if (compliance < criticalFloor) return 0;
  if (compliance >= target) return 1;
  return clamp(
    (compliance - criticalFloor) / (target - criticalFloor),
    0,
    1,
  );
}

export function calculateComplianceEarnedScore(
  maxScore: number,
  percentile: number,
  attainmentFactor: number,
  formulaMode: ComplianceFormulaMode,
): number {
  return formulaMode === "softStretch"
    ? maxScore * attainmentFactor * (0.7 + 0.3 * percentile)
    : maxScore * percentile * attainmentFactor;
}

type ComplianceFormulaMode = ComplianceConfig["formulaMode"];

// ─── Row scoring orchestration ─────────────────────────────────────────────

const cohortKeyForRow = (
  row: ComplianceAssessmentRow,
  config: ComplianceConfig,
) => {
  if (config.cohortLevel === "Parent") return row.parentSupplier;
  if (config.cohortLevel === "Zone") return row.zone;
  if (config.cohortLevel === "Category") return row.category;
  if (config.cohortLevel === "Country") return row.country;
  return "All suppliers";
};

const invalidBaseScore = (
  row: ComplianceAssessmentRow,
  config: ComplianceConfig,
  status: ComplianceScoreStatus,
  explanation: string,
  cohortKey = "Excluded",
): ScoredComplianceRow => ({
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
  compliance: number,
  rank: CompliancePercentileRank,
  attainmentFactor: number,
  earnedScore: number,
  config: ComplianceConfig,
): { status: ComplianceScoreStatus; explanation: string } => {
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
  const belowFloor = compliance < config.criticalFloor || attainmentFactor === 0;
  const formulaZero = earnedScore === 0;

  if (rank.note === "single") {
    messages.push("Single observation: percentile set to 100% by rule.");
  }
  if (rank.note === "noVariance") {
    messages.push("No variance: all suppliers have identical compliance.");
  }

  if (belowFloor) {
    messages.push("Below critical floor: compliance too low, earned score set to 0.");
  } else if (formulaZero) {
    messages.push("Zero score: strict formula produces 0 because percentile component is 0.");
  } else if (compliance >= config.target) {
    messages.push("Valid: compliance is above target and percentile-adjusted.");
  } else {
    messages.push("Valid: compliance between floor and target — attainment is proportional.");
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
  assessmentRows: ComplianceAssessmentRow[],
  config: ComplianceConfig,
): ScoredComplianceRow[] {
  const groupedRows = new Map<string, ComplianceAssessmentRow[]>();

  assessmentRows.forEach((row) => {
    if (!row.isApplicable) return;
    if (row.errors.length > 0) return;
    if (row.compliancePct === null) return;
    const cohortKey = cohortKeyForRow(row, config);
    const group = groupedRows.get(cohortKey) ?? [];
    group.push(row);
    groupedRows.set(cohortKey, group);
  });

  const rankLookup = new Map<string, CompliancePercentileRank>();
  groupedRows.forEach((group) => {
    const ranks = calculatePercentileRanks(
      group.map((row) => ({ id: row.id, value: row.compliancePct ?? 0 })),
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
    if (row.compliancePct === null) {
      return invalidBaseScore(
        row,
        config,
        "Missing Compliance",
        "Missing Compliance: applicable supplier with no usable compliance data.",
        cohortKey,
      );
    }

    const rank = rankLookup.get(row.id);
    const percentile = rank?.percentile ?? null;
    const attainmentFactor = calculateAttainmentFactor(
      row.compliancePct,
      config.criticalFloor,
      config.target,
    );
    const earnedScore =
      percentile === null
        ? null
        : calculateComplianceEarnedScore(
            config.maxScore,
            percentile,
            attainmentFactor,
            config.formulaMode,
          );
    const narrative =
      rank && earnedScore !== null
        ? scoreNarrative(
            row.compliancePct,
            rank,
            attainmentFactor,
            earnedScore,
            config,
          )
        : {
            status: "Missing Compliance" as ComplianceScoreStatus,
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
  rows: SupplierComplianceInputRow[],
  config: ComplianceConfig,
): ScoredComplianceRow[] {
  const assessments = rows.map((r, i) => toAssessmentRow(r, i));
  return scoreAssessmentRows(assessments, config);
}

/**
 * Rollup: group supplier-level scored rows, then AVERAGE the compliance %.
 * The scoring doc calls this a "Proxy Calculation" — we flag it accordingly.
 */
const rollupRows = (
  supplierRows: ScoredComplianceRow[],
  level: ComplianceRollupLevel,
  config: ComplianceConfig,
): RollupComplianceRow[] => {
  const groups = new Map<string, ScoredComplianceRow[]>();
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

  const rollupAssessments: ComplianceAssessmentRow[] = Array.from(
    groups.entries(),
  ).map(([label, groupRows], index) => {
    const contributing = groupRows.filter(
      (r) =>
        r.scoreStatus !== "Not Applicable" &&
        r.scoreStatus !== "Invalid Data" &&
        r.scoreStatus !== "Missing Compliance" &&
        r.compliancePct !== null,
    );
    const avg =
      contributing.length === 0
        ? null
        : contributing.reduce((sum, r) => sum + (r.compliancePct ?? 0), 0) /
          contributing.length;

    return {
      id: `${level.toLowerCase()}-${index}-${label}`,
      supplier: "All suppliers",
      parentSupplier: level === "Parent" ? label : "All parents",
      zone: level === "Zone" ? label : "All zones",
      country: level === "Country" ? label : "All countries",
      category: level === "Category" ? label : "All categories",
      supplierApprovalStatus: firstText(
        groupRows.map((r) => r.supplierApprovalStatus),
        "",
      ),
      isApplicable: contributing.length > 0,
      compliancePct: avg,
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
          : level === "Category"
            ? row.category
            : row.country;
    // Doc: rollups that use simple average → mark status Proxy Calculation
    // (unless the row is a "Zero Score" / "Not Applicable" / etc.).
    const isValid = row.scoreStatus === "Valid";
    return {
      ...row,
      scoreStatus: isValid
        ? ("Proxy Calculation" as ComplianceScoreStatus)
        : row.scoreStatus,
      explanation: isValid
        ? `${row.explanation} Proxy Calculation: rollup compliance is the simple average of contributing suppliers.`
        : row.explanation,
      level,
      label,
      contributingSuppliers: groups.get(label)?.length ?? 0,
      aggregationMethod: "Proxy average" as const,
    };
  });
};

export function calculateParentRollup(
  rows: SupplierComplianceInputRow[],
  config: ComplianceConfig,
): RollupComplianceRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Parent", config);
}

export function calculateZoneRollup(
  rows: SupplierComplianceInputRow[],
  config: ComplianceConfig,
): RollupComplianceRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Zone", config);
}

export function calculateCategoryRollup(
  rows: SupplierComplianceInputRow[],
  config: ComplianceConfig,
): RollupComplianceRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Category", config);
}

export function calculateCountryRollup(
  rows: SupplierComplianceInputRow[],
  config: ComplianceConfig,
): RollupComplianceRow[] {
  return rollupRows(calculateSupplierScores(rows, config), "Country", config);
}

export const formulaModeLabel = (mode: ComplianceConfig["formulaMode"]) =>
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
