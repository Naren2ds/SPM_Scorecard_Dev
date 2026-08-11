export type SmallKpiId = "SA" | "SC" | "SM" | "CO2" | "ECL" | "IC";
export type ResultLevel = "parent" | "supplier" | "zone" | "category";
export type FormulaMode = "softStretch" | "strict";

export interface SourceRow {
  [key: string]: string;
  id: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  scorecard_category: string;
  kpiApplicability: string;
  year: string;
}

export interface WorkspaceConfig {
  maxScore: number;
  criticalFloor: number;
  target: number;
  formulaMode: FormulaMode;
}

export interface KpiSpec {
  id: SmallKpiId;
  endpoint: string;
  title: string;
  eyebrow: string;
  metricLabel: string;
  metricShortLabel: string;
  unit: "percent" | "number";
  defaultConfig: WorkspaceConfig;
  formula: string;
  rollupFormula: string;
  rawColumns: Array<{ key: string; label: string }>;
  autoQuartiles?: boolean;
}

export interface DisplayResult {
  id: string;
  level: ResultLevel;
  label: string;
  supplier: string;
  parentSupplier: string;
  zone: string;
  country: string;
  category: string;
  scorecardCategory: string;
  year: string;
  metric: number | null;
  rawValues: Record<string, number | string>;
  rank: number | null;
  percentile: number | null;
  attainment: number | null;
  earned: number | null;
  scoreStatus: string;
  contributingRows: number;
  explanation: string;
}

interface AssessedRow {
  row: SourceRow;
  metric: number | null;
  rawValues: Record<string, number | string>;
  applicable: boolean;
}

interface RollupSeed {
  label: string;
  scorecardCategory: string;
  metric: number;
  rawValues: Record<string, number | string>;
  contributingRows: number;
}

export const KPI_SPECS: Record<SmallKpiId, KpiSpec> = {
  SA: {
    id: "SA",
    endpoint: "/api/supplier-assessment",
    title: "Supplier Assessment",
    eyebrow: "Service Level KPI",
    metricLabel: "Average health",
    metricShortLabel: "Health %",
    unit: "percent",
    defaultConfig: { maxScore: 10, criticalFloor: 0.5, target: 0.8, formulaMode: "softStretch" },
    formula: "(Green x 1.0 + Yellow x 0.5) / (Green + Yellow + Red)",
    rollupFormula: "Summed weighted assessments / summed valid assessments",
    rawColumns: [
      { key: "greenCount", label: "Green" },
      { key: "yellowCount", label: "Yellow" },
      { key: "redCount", label: "Red" },
    ],
  },
  SC: {
    id: "SC",
    endpoint: "/api/supplier-compliance",
    title: "Supplier Compliance",
    eyebrow: "Service Level KPI",
    metricLabel: "Average compliance",
    metricShortLabel: "Compliance %",
    unit: "percent",
    defaultConfig: { maxScore: 5, criticalFloor: 0.6, target: 0.9, formulaMode: "softStretch" },
    formula: "Supplier compliance percentage",
    rollupFormula: "Average of valid compliance percentages",
    rawColumns: [{ key: "compliancePct", label: "Compliance Input" }],
  },
  SM: {
    id: "SM",
    endpoint: "/api/supplier-maturity",
    title: "Supplier Maturity",
    eyebrow: "Sustainability KPI",
    metricLabel: "Average maturity",
    metricShortLabel: "Maturity %",
    unit: "percent",
    defaultConfig: { maxScore: 10, criticalFloor: 0.6, target: 0.8, formulaMode: "softStretch" },
    formula: "Normalized supplier maturity score",
    rollupFormula: "Average of valid maturity scores",
    rawColumns: [{ key: "maturityScore", label: "Maturity Input" }],
  },
  CO2: {
    id: "CO2",
    endpoint: "/api/co2-emission",
    title: "CO2 Reduction Potential",
    eyebrow: "Sustainability KPI",
    metricLabel: "Average reduction potential",
    metricShortLabel: "tCO2e",
    unit: "number",
    defaultConfig: { maxScore: 5, criticalFloor: 0, target: 1, formulaMode: "softStretch" },
    formula: "Reduction potential in tonnes CO2e; higher is better",
    rollupFormula: "Average of valid reduction-potential values; Floor = Q1 and Target = Q3",
    rawColumns: [{ key: "co2Emission", label: "tCO2e Input" }],
    autoQuartiles: true,
  },
  ECL: {
    id: "ECL",
    endpoint: "/api/eclipse",
    title: "Eclipse Score",
    eyebrow: "Sustainability KPI",
    metricLabel: "Average Eclipse",
    metricShortLabel: "Eclipse %",
    unit: "percent",
    defaultConfig: { maxScore: 5, criticalFloor: 0.5, target: 0.8, formulaMode: "softStretch" },
    formula: "Normalized Eclipse score",
    rollupFormula: "Average of valid Eclipse scores",
    rawColumns: [{ key: "eclipseScore", label: "Eclipse Input" }],
  },
  IC: {
    id: "IC",
    endpoint: "/api/invoice-conformity",
    title: "Invoice Conformity",
    eyebrow: "Operational KPI",
    metricLabel: "Average conformity",
    metricShortLabel: "Conformity %",
    unit: "percent",
    defaultConfig: { maxScore: 5, criticalFloor: 0.7, target: 0.85, formulaMode: "softStretch" },
    formula: "Conformant invoices / Total invoices",
    rollupFormula: "Sum(Total Invoices - Mismatch Count) / Sum(Total Invoices)",
    rawColumns: [
      { key: "totalInvoices", label: "Total Invoices" },
      { key: "mismatchCount", label: "Mismatches" },
    ],
  },
};

export function normalizeSourceRows(rows: Array<Record<string, unknown>>): SourceRow[] {
  return rows.map((source, index) => {
    const normalized: Record<string, string> = {};
    Object.entries(source).forEach(([key, value]) => {
      normalized[key] = String(value ?? "");
    });
    return {
      ...normalized,
      id: normalized.id || `row-${index}`,
      supplier: normalized.supplier || "",
      parentSupplier: normalized.parentSupplier || "",
      zone: normalized.zone || "",
      country: normalized.country || "",
      category: normalized.category || "",
      scorecard_category: normalized.scorecard_category || "Unassigned scorecard category",
      kpiApplicability: normalized.kpiApplicability || "Applicable",
      year: normalized.year || "",
    };
  });
}

export function calculateQuartiles(rows: SourceRow[], spec: KpiSpec): { q1: number; q3: number } | null {
  const values = rows
    .map((row) => assessRow(row, spec))
    .filter((row) => row.applicable && row.metric !== null)
    .map((row) => row.metric as number)
    .sort((a, b) => a - b);
  if (values.length < 2) return null;
  const q1 = percentile(values, 0.25);
  const rawQ3 = percentile(values, 0.75);
  return { q1, q3: rawQ3 > q1 ? rawQ3 : q1 + 1e-9 };
}

export function buildResults(
  rows: SourceRow[],
  spec: KpiSpec,
  config: WorkspaceConfig,
  level: ResultLevel,
): DisplayResult[] {
  if (level === "supplier") {
    const assessed = rows.map((row) => assessRow(row, spec));
    const ranked = rankValuesByScorecardCategory(
      assessed.map((assessment, index) => ({
        index,
        value: assessment.metric,
        scorecardCategory: scorecardCategory(assessment.row.scorecard_category),
      })),
      config.target,
    );
    return assessed.map((assessment, index) => scoreAssessment(assessment, ranked.get(index), config));
  }

  const seeds = buildRollupSeeds(rows, spec, level);
  const ranked = rankValuesByScorecardCategory(
    seeds.map((seed, index) => ({
      index,
      value: seed.metric,
      scorecardCategory: seed.scorecardCategory,
    })),
    config.target,
  );
  return seeds.map((seed, index) => scoreRollup(seed, ranked.get(index), config, level));
}

function assessRow(row: SourceRow, spec: KpiSpec): AssessedRow {
  const applicable = row.kpiApplicability.trim().toLowerCase() !== "not applicable";
  const rawValues: Record<string, number | string> = {};
  spec.rawColumns.forEach((column) => {
    rawValues[column.key] = number(row[column.key]) ?? row[column.key] ?? "";
  });
  if (!applicable) return { row, metric: null, rawValues, applicable: false };

  let metric: number | null = null;
  if (spec.id === "SA") {
    const green = number(row.greenCount) ?? 0;
    const yellow = number(row.yellowCount) ?? 0;
    const red = number(row.redCount) ?? 0;
    const valid = green + yellow + red;
    metric = valid > 0 ? (green + 0.5 * yellow) / valid : null;
  } else if (spec.id === "IC") {
    const total = number(row.totalInvoices);
    const mismatches = number(row.mismatchCount);
    metric = total !== null && total > 0
      ? Math.max(total - (mismatches ?? 0), 0) / total
      : normalizedPercent(row.conformityPct);
  } else if (spec.id === "SC") {
    metric = normalizedPercent(row.compliancePct);
  } else if (spec.id === "SM") {
    metric = normalizedPercent(row.maturityScore);
  } else if (spec.id === "ECL") {
    metric = normalizedPercent(row.eclipseScore);
  } else {
    metric = number(row.co2Emission);
  }
  return { row, metric, rawValues, applicable };
}

function buildRollupSeeds(rows: SourceRow[], spec: KpiSpec, level: Exclude<ResultLevel, "supplier">): RollupSeed[] {
  const groups = new Map<string, AssessedRow[]>();
  rows.forEach((row) => {
    const assessment = assessRow(row, spec);
    if (!assessment.applicable || assessment.metric === null) return;
    const label = dimension(row, level);
    groups.set(label, [...(groups.get(label) ?? []), assessment]);
  });

  return Array.from(groups.entries()).map(([label, assessments]) => {
    let metric = 0;
    const rawValues: Record<string, number | string> = {};
    if (spec.id === "SA") {
      const green = sum(assessments, "greenCount");
      const yellow = sum(assessments, "yellowCount");
      const red = sum(assessments, "redCount");
      metric = (green + 0.5 * yellow) / (green + yellow + red);
      Object.assign(rawValues, { greenCount: green, yellowCount: yellow, redCount: red });
    } else if (spec.id === "IC") {
      const total = sum(assessments, "totalInvoices");
      const mismatches = sum(assessments, "mismatchCount");
      const conformant = assessments.reduce((sumValue, assessment) => {
        const rowTotal = number(assessment.row.totalInvoices) ?? 0;
        const rowMismatches = number(assessment.row.mismatchCount) ?? 0;
        return sumValue + Math.max(rowTotal - rowMismatches, 0);
      }, 0);
      metric = conformant / total;
      Object.assign(rawValues, { totalInvoices: total, mismatchCount: mismatches });
    } else {
      metric = assessments.reduce((total, row) => total + (row.metric ?? 0), 0) / assessments.length;
      spec.rawColumns.forEach((column) => {
        rawValues[column.key] = metric;
      });
    }
    return {
      label,
      scorecardCategory: dominantScorecardCategory(
        assessments.map((assessment) => assessment.row.scorecard_category),
      ),
      metric,
      rawValues,
      contributingRows: assessments.length,
    };
  });
}

function scoreAssessment(
  assessment: AssessedRow,
  ranking: { rank: number; percentile: number; note: string } | undefined,
  config: WorkspaceConfig,
): DisplayResult {
  const { row, metric, rawValues, applicable } = assessment;
  if (!applicable) return emptyResult(row, rawValues, "Not Applicable", "Not applicable: excluded from ranking and scoring.");
  if (metric === null || !ranking) return emptyResult(row, rawValues, "Missing Data", "Missing data: no valid KPI value is available.");
  return scoredResult({
    id: row.id,
    level: "supplier",
    label: row.supplier || `Row ${row.id}`,
    supplier: row.supplier,
    parentSupplier: row.parentSupplier,
    zone: row.zone,
    country: row.country,
    category: row.category,
    scorecardCategory: scorecardCategory(row.scorecard_category),
    year: row.year,
    metric,
    rawValues,
    contributingRows: 1,
  }, ranking, config);
}

function scoreRollup(
  seed: RollupSeed,
  ranking: { rank: number; percentile: number; note: string } | undefined,
  config: WorkspaceConfig,
  level: Exclude<ResultLevel, "supplier">,
): DisplayResult {
  return scoredResult({
    id: `${level}-${seed.label}`,
    level,
    label: seed.label,
    supplier: "",
    parentSupplier: level === "parent" ? seed.label : "All parents",
    zone: level === "zone" ? seed.label : "All zones",
    country: "",
    category: level === "category" ? seed.label : "",
    scorecardCategory: seed.scorecardCategory,
    year: "",
    metric: seed.metric,
    rawValues: seed.rawValues,
    contributingRows: seed.contributingRows,
  }, ranking, config);
}

function scoredResult(
  base: Omit<DisplayResult, "rank" | "percentile" | "attainment" | "earned" | "scoreStatus" | "explanation">,
  ranking: { rank: number; percentile: number; note: string } | undefined,
  config: WorkspaceConfig,
): DisplayResult {
  const percentileRank = ranking ?? { rank: 1, percentile: 1, note: "single" };
  const attainment = base.metric === null ? null : attainmentFor(base.metric, config);
  const earned = attainment === null ? null : config.maxScore * attainment * (
    config.formulaMode === "softStretch" ? 0.7 + 0.3 * percentileRank.percentile : percentileRank.percentile
  );
  const belowFloor = attainment === 0;
  const status = belowFloor ? "Below critical floor" : "Valid score";
  const explanation = belowFloor
    ? `Below critical floor. Attainment = 0 and earned score = 0.`
    : `Valid score. Attainment = ${attainment?.toFixed(4)}. Earned Score = ${earned?.toFixed(2)}. Percentile cohort: ${base.scorecardCategory}. ${base.level === "supplier" ? "Rank is calculated within this scorecard category." : `Rollup of ${base.contributingRows} valid rows.`}`;
  return {
    ...base,
    rank: percentileRank.rank,
    percentile: percentileRank.percentile,
    attainment,
    earned,
    scoreStatus: status,
    explanation,
  };
}

function emptyResult(row: SourceRow, rawValues: Record<string, number | string>, status: string, explanation: string): DisplayResult {
  return {
    id: row.id,
    level: "supplier",
    label: row.supplier || `Row ${row.id}`,
    supplier: row.supplier,
    parentSupplier: row.parentSupplier,
    zone: row.zone,
    country: row.country,
    category: row.category,
    scorecardCategory: scorecardCategory(row.scorecard_category),
    year: row.year,
    metric: null,
    rawValues,
    rank: null,
    percentile: null,
    attainment: null,
    earned: null,
    scoreStatus: status,
    contributingRows: 0,
    explanation,
  };
}

function rankValues(
  rows: Array<{ index: number; value: number | null }>,
  target: number,
): Map<number, { rank: number; percentile: number; note: string }> {
  const valid = rows.filter((row): row is { index: number; value: number } => row.value !== null && Number.isFinite(row.value));
  const output = new Map<number, { rank: number; percentile: number; note: string }>();
  if (valid.length === 0) return output;
  if (valid.length === 1) {
    output.set(valid[0].index, { rank: 1, percentile: 1, note: "single" });
    return output;
  }
  const distinct = new Set(valid.map((row) => row.value.toFixed(12)));
  if (distinct.size === 1) {
    const percentileRank = valid[0].value >= target ? 1 : 0.5;
    const averageRank = (valid.length + 1) / 2;
    valid.forEach((row) => output.set(row.index, { rank: averageRank, percentile: percentileRank, note: "noVariance" }));
    return output;
  }
  const sorted = [...valid].sort((left, right) => right.value - left.value);
  let cursor = 0;
  while (cursor < sorted.length) {
    const key = sorted[cursor].value.toFixed(12);
    let end = cursor + 1;
    while (end < sorted.length && sorted[end].value.toFixed(12) === key) end += 1;
    const averageRank = (cursor + 1 + end) / 2;
    const percentileRank = (sorted.length - averageRank) / (sorted.length - 1);
    for (let index = cursor; index < end; index += 1) {
      output.set(sorted[index].index, { rank: averageRank, percentile: percentileRank, note: "standard" });
    }
    cursor = end;
  }
  return output;
}

function rankValuesByScorecardCategory(
  rows: Array<{ index: number; value: number | null; scorecardCategory: string }>,
  target: number,
): Map<number, { rank: number; percentile: number; note: string }> {
  const cohorts = new Map<string, Array<{ index: number; value: number | null }>>();
  rows.forEach((row) => {
    const cohort = cohorts.get(row.scorecardCategory) ?? [];
    cohort.push({ index: row.index, value: row.value });
    cohorts.set(row.scorecardCategory, cohort);
  });
  const output = new Map<number, { rank: number; percentile: number; note: string }>();
  cohorts.forEach((cohort) => {
    rankValues(cohort, target).forEach((rank, index) => output.set(index, rank));
  });
  return output;
}

function scorecardCategory(value: string): string {
  return value.trim() || "Unassigned scorecard category";
}

function dominantScorecardCategory(values: string[]): string {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const normalized = scorecardCategory(value);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  });
  const topCount = Math.max(0, ...counts.values());
  return [...counts.entries()]
    .filter(([, count]) => count === topCount)
    .map(([value]) => value)
    .sort()[0] ?? "Unassigned scorecard category";
}

function attainmentFor(metric: number, config: WorkspaceConfig): number {
  if (metric <= config.criticalFloor) return 0;
  if (metric >= config.target) return 1;
  return Math.max(0, Math.min(1, (metric - config.criticalFloor) / (config.target - config.criticalFloor)));
}

function dimension(row: SourceRow, level: Exclude<ResultLevel, "supplier">): string {
  if (level === "parent") return row.parentSupplier.trim() || "Unassigned parent";
  if (level === "zone") return row.zone.trim() || "Unassigned zone";
  return row.category.trim() || "Unassigned category";
}

function sum(rows: AssessedRow[], field: string): number {
  return rows.reduce((total, row) => total + (number(row.row[field]) ?? 0), 0);
}

function number(value: string | undefined): number | null {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) && String(value ?? "").trim() !== "" ? parsed : null;
}

function normalizedPercent(value: string | undefined): number | null {
  const parsed = number(value);
  if (parsed === null) return null;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function percentile(values: number[], p: number): number {
  const position = (values.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}
